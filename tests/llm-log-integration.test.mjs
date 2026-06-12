// Интеграционные тесты просмотрщика логов с РЕАЛЬНЫМИ базами (mem_bot и mem_bot_logs):
// лента чата (слияние сообщений и сервисных групп, пагинация), журнал цикла (шапка, строки, сообщение
// пользователя из основной БД), одиночная сервисная запись, чистка по возрасту и идемпотентность скрипта
// переноса. Все создаваемые записи маркируются и удаляются в конце прогона.
// Запуск: npm run test:llm-log-db (NODE_ENV=test обязателен — записи журналов получают is_test).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { query, queryLog, closePool } from '../src/db.js';
import { getTimeline, getCycle, getSingleRequest } from '../src/server/llm-log-data.js';
import { runLogRetentionOnce } from '../src/pipeline/log-retention.js';
import { config } from '../src/config.js';

const MARK = `lvtest_${Date.now()}`;
const CYCLE_ID = `llm_${MARK}_cycle`;
const SERVICE_ID = `llm_${MARK}_service`;

// --- подготовка фикстуры -----------------------------------------------------

async function insertUser() {
  const { rows } = await query(
    `INSERT INTO mem.users (external_id, display_name, is_test) VALUES ($1, $2, true) RETURNING id`,
    [`ext_${MARK}`, `Тестовый ${MARK}`],
  );
  return rows[0].id;
}

async function insertConversation(userId) {
  const { rows } = await query(`INSERT INTO mem.conversations (user_id, channel) VALUES ($1, 'test') RETURNING id`, [
    userId,
  ]);
  return rows[0].id;
}

async function insertMessage(conversationId, userId, role, content, createdAt, metadata = {}) {
  const { rows } = await query(
    `INSERT INTO mem.conversation_messages (conversation_id, user_id, role, content, created_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [conversationId, userId, role, content, createdAt, metadata],
  );
  return rows[0].id;
}

async function insertLogRecord({
  userId,
  requestId,
  kind,
  createdAt,
  tokens = 100,
  durationMs = 500,
  payload,
  response = null,
  status = 'ok',
}) {
  const { rows } = await queryLog(
    `INSERT INTO log.llm_request
       (created_at, request_id, request_kind, endpoint, model, user_id, payload, response,
        prompt_tokens, completion_tokens, total_tokens, price_usd, duration_ms, status, is_test)
     VALUES ($1, $2, $3, 'chat.completions', 'gpt-test', $4, $5::jsonb, $6::jsonb,
             $7, 10, $8, 0.001, $9, $10, true)
     RETURNING llm_request_id`,
    [
      createdAt,
      requestId,
      kind,
      String(userId),
      JSON.stringify(payload ?? { model: 'gpt-test', messages: [{ role: 'user', content: 'тест' }] }),
      response ? JSON.stringify(response) : null,
      tokens - 10,
      tokens,
      durationMs,
      status,
    ],
  );
  return rows[0].llm_request_id;
}

async function insertEvent({ requestId, userId, type, title, createdAt, data = null }) {
  await queryLog(
    `INSERT INTO log.agent_event (created_at, request_id, user_id, event_type, title, data, is_test)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, true)`,
    [createdAt, requestId, String(userId), type, title, data ? JSON.stringify(data) : null],
  );
}

const T = (sec) => new Date(Date.parse('2026-06-01T12:00:00Z') + sec * 1000).toISOString();

let userId;
let conversationId;
try {
  userId = await insertUser();
  conversationId = await insertConversation(userId);

  // Цикл: user-сообщение с request_id + две записи журнала + события.
  await insertMessage(conversationId, userId, 'user', 'напомни про тест', T(0), { request_id: CYCLE_ID });
  await insertMessage(conversationId, userId, 'assistant', 'Готово, напомню!', T(6), { request_id: CYCLE_ID });
  await insertLogRecord({ userId, requestId: CYCLE_ID, kind: 'intent_classify', createdAt: T(1), durationMs: 800 });
  await insertLogRecord({
    userId,
    requestId: CYCLE_ID,
    kind: 'main_agent_answer',
    createdAt: T(5),
    tokens: 900,
    durationMs: 2000,
    response: { message: { role: 'assistant', content: 'Готово, напомню!' }, finish_reason: 'stop' },
  });
  await insertEvent({
    requestId: CYCLE_ID,
    userId,
    type: 'agent.started',
    title: 'Ход агента начат',
    createdAt: T(0.5),
  });
  await insertEvent({
    requestId: CYCLE_ID,
    userId,
    type: 'tool.completed',
    title: 'Результат инструмента: reminder_create',
    createdAt: T(4),
    data: { toolName: 'reminder_create', result: { ok: true } },
  });

  // Сервисная группа (request_id не упоминается ни в одном сообщении) и одиночная запись без request_id.
  await insertLogRecord({ userId, requestId: SERVICE_ID, kind: 'history_compress', createdAt: T(60), tokens: 300 });
  const orphanId = await insertLogRecord({ userId, requestId: null, kind: 'embedding', createdAt: T(70), tokens: 50 });

  // --- 1. Лента чата: сообщения + сервисные бэйджи, циклы исключены из бэйджей ------------------------
  {
    const { items } = await getTimeline({ userId, limit: 50 });
    const messages = items.filter((i) => i.type === 'message');
    const services = items.filter((i) => i.type === 'service');

    assert.equal(messages.length, 2, 'оба сообщения диалога в ленте');
    assert.equal(messages[0].requestId, CYCLE_ID, 'request_id сообщения отдан фронтенду');
    assert.equal(messages[0].hasLog, true, 'у сообщения с request_id есть кнопка журнала');

    const serviceIds = services.map((s) => s.requestId);
    assert.ok(serviceIds.includes(SERVICE_ID), 'сервисная группа стала бэйджем');
    assert.ok(!serviceIds.includes(CYCLE_ID), 'цикл, привязанный к сообщению, бэйджем не дублируется');
    const orphan = services.find((s) => s.requestId === null);
    assert.ok(orphan, 'запись без request_id — одиночный бэйдж');
    assert.deepEqual(orphan.llmRequestIds.map(Number), [Number(orphanId)]);

    const compress = services.find((s) => s.requestId === SERVICE_ID);
    assert.equal(compress.kind, 'history_compress');
    assert.equal(Number(compress.totalTokens), 300, 'токены группы просуммированы');

    // Хронологический порядок слияния двух источников.
    const times = items.map((i) => new Date(i.createdAt).getTime());
    assert.deepEqual(
      times,
      [...times].sort((a, b) => a - b),
      'лента отсортирована по времени',
    );
  }

  // --- 2. Пагинация: страница в одно сообщение, before возвращает строго более раннее -----------------
  {
    const page1 = await getTimeline({ userId, limit: 1 });
    assert.equal(page1.hasMore, true, 'есть более ранняя история');
    const lastMsg = page1.items.findLast((i) => i.type === 'message');
    assert.equal(lastMsg.content, 'Готово, напомню!', 'первая страница — самое свежее сообщение');

    const page2 = await getTimeline({ userId, before: lastMsg.createdAt, limit: 1 });
    const olderMsg = page2.items.findLast((i) => i.type === 'message');
    assert.equal(olderMsg.content, 'напомни про тест', 'before отдаёт строго более раннее');
  }

  // --- 3. Журнал цикла: шапка, сообщение пользователя из основной БД, слияние с событиями -------------
  {
    const cycle = await getCycle(CYCLE_ID);
    assert.ok(cycle, 'цикл найден');
    assert.equal(cycle.header.tokens, 1000, 'сумма токенов по записям цикла');
    assert.deepEqual(cycle.header.models, ['gpt-test']);

    const types = cycle.rows.map((r) => r.rowType);
    assert.equal(types[0], 'user_say', 'первая строка — сообщение пользователя из mem_bot');
    assert.ok(types.includes('agent_start'), 'события агента влились в ленту');
    assert.ok(types.includes('tool_result'), 'строка результата инструмента из события');
    assert.ok(types.includes('llm_request') && types.includes('llm_response'), 'пары запрос/ответ на месте');

    const answer = cycle.rows.find((r) => r.rowType === 'llm_response' && r.body?.content?.includes('Готово'));
    assert.ok(answer, 'сохранённый ответ модели виден в строке ответа');
  }

  // --- 4. Одиночная сервисная запись и 404-сценарии ----------------------------------------------------
  {
    const single = await getSingleRequest(orphanId);
    assert.ok(single, 'одиночная запись находится по первичному ключу');
    assert.equal(single.rows.filter((r) => r.rowType === 'llm_request').length, 1);

    assert.equal(await getCycle(`llm_${MARK}_missing`), null, 'неизвестный request_id даёт null (HTTP 404)');
    assert.equal(await getSingleRequest(999999999), null, 'неизвестный llm_request_id даёт null (HTTP 404)');
  }

  // --- 5. Чистка по возрасту на реальной БД: древние записи удаляются, свежие и бессрочные целы --------
  {
    const ancient = new Date(Date.now() - 20 * 365 * 24 * 3600 * 1000).toISOString();
    const ancientReqId = `llm_${MARK}_ancient`;
    await insertLogRecord({ userId, requestId: ancientReqId, kind: 'embedding', createdAt: ancient, tokens: 10 });
    await insertEvent({ requestId: ancientReqId, userId, type: 'agent.started', title: 'древнее', createdAt: ancient });

    const savedRetention = config.llmLog.retention;
    // Порог 10 лет: реальные данные моложе и не затрагиваются, наша 20-летняя фикстура — старше.
    config.llmLog.retention = { llmRequestDays: 3650, agentEventDays: 3650, llmUsageDays: 0 };
    try {
      const deleted = await runLogRetentionOnce();
      assert.ok(deleted.llmRequest >= 1, 'древняя запись журнала удалена');
      assert.ok(deleted.agentEvent >= 1, 'древнее событие удалено');
      assert.equal(deleted.llmUsage, 0, 'бессрочная llm_usage не тронута');
    } finally {
      config.llmLog.retention = savedRetention;
    }
    const { rows: leftReq } = await queryLog(`SELECT 1 FROM log.llm_request WHERE request_id = $1`, [ancientReqId]);
    assert.equal(leftReq.length, 0, 'древней записи больше нет');
    const { rows: fresh } = await queryLog(`SELECT 1 FROM log.llm_request WHERE request_id = $1`, [CYCLE_ID]);
    assert.equal(fresh.length, 2, 'свежие записи цикла не пострадали');
  }

  // --- 6. Идемпотентность миграций БД логов: повторный прогон не создаёт строк и не падает -------------
  {
    const count = async () => Number((await queryLog(`SELECT COUNT(*) AS n FROM log.llm_request`)).rows[0].n);
    const before = await count();
    execFileSync(process.execPath, ['src/migrate.js'], { stdio: 'pipe' });
    const after = await count();
    assert.equal(after, before, 'повторный прогон миграций не добавляет строк');
  }

  console.log('llm-log-integration.test.mjs: ok');
} finally {
  // Уборка: пользователь каскадом чистит mem.*; журналы — по нашим request_id и пользователю.
  if (userId) {
    await query(`DELETE FROM mem.users WHERE id = $1`, [userId]);
    await queryLog(`DELETE FROM log.llm_usage WHERE user_id = $1`, [String(userId)]);
    await queryLog(`DELETE FROM log.llm_request WHERE user_id = $1`, [String(userId)]);
    await queryLog(`DELETE FROM log.agent_event WHERE user_id = $1`, [String(userId)]);
  }
  await closePool();
}
