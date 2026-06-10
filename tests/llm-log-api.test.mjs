// Интеграционные тесты HTTP-уровня просмотрщика логов: реальный express с маршрутами админ-API на
// эфемерном порту и реальные базы. Проверяются коды ответов и формы JSON всех новых маршрутов, валидация
// чата от имени пользователя (без вызова LLM), отдача настроек анализа, SSE-поток CLI-движка на
// фикстурной команде и запрет CLI при нелокальном хосте (403).
// Запуск: npm run test:llm-log-db (NODE_ENV=test обязателен).
import assert from 'node:assert/strict';
import express from 'express';
import { createAdminApi } from '../src/server/admin-api.js';
import { query, queryLog, closePool } from '../src/db.js';
import { config } from '../src/config.js';

const MARK = `lvapi_${Date.now()}`;
const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// Поднимаем сервер на эфемерном порту.
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', createAdminApi());
const server = await new Promise((resolve) => {
  const s = app.listen(0, 'localhost', () => resolve(s));
});
const base = `http://localhost:${server.address().port}/api`;

const savedAnalysis = config.admin.logAnalysis;
const savedHost = config.admin.host;
let userId;

try {
  // Фикстура: тестовый пользователь и одна запись журнала для анализа.
  const { rows: userRows } = await query(
    `INSERT INTO mem.users (external_id, display_name, is_test) VALUES ($1, $2, true) RETURNING id`,
    [`ext_${MARK}`, `АпиТест ${MARK}`],
  );
  userId = userRows[0].id;
  const { rows: recRows } = await queryLog(
    `INSERT INTO log.llm_request (request_id, request_kind, endpoint, model, user_id, payload, total_tokens, is_test)
     VALUES ($1, 'main_agent_answer', 'chat.completions', 'gpt-test', $2,
             '{"messages":[{"role":"user","content":"маркер-для-анализа"}]}'::jsonb, 42, true)
     RETURNING llm_request_id`,
    [`llm_${MARK}`, String(userId)],
  );
  const llmRequestId = recRows[0].llm_request_id;

  // --- 1. Поиск пользователей: находит по имени, отдаёт camelCase-поля ---------------------------------
  {
    const res = await fetch(`${base}/users/search?q=${encodeURIComponent(`АпиТест ${MARK}`)}`);
    assert.equal(res.status, 200);
    const list = await res.json();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, userId);
    assert.equal(list[0].externalId, `ext_${MARK}`);
  }

  // --- 2. Лента и журналы: формы ответов и 404 на неизвестные идентификаторы --------------------------
  {
    const timeline = await (await fetch(`${base}/users/${userId}/timeline?limit=10`)).json();
    assert.ok(Array.isArray(timeline.items), 'лента отдаёт массив items');
    assert.equal(typeof timeline.hasMore, 'boolean');

    const cycle404 = await fetch(`${base}/llm-log/cycle/llm_${MARK}_missing`);
    assert.equal(cycle404.status, 404);
    const req404 = await fetch(`${base}/llm-log/request/999999999`);
    assert.equal(req404.status, 404);

    const single = await (await fetch(`${base}/llm-log/request/${llmRequestId}`)).json();
    assert.equal(single.rows[0].rowType, 'llm_request');
  }

  // --- 3. Чат от имени пользователя: валидация без вызова LLM ------------------------------------------
  {
    const empty = await fetch(`${base}/users/${userId}/chat-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    assert.equal(empty.status, 400, 'пустое сообщение отклоняется');

    const ghost = await fetch(`${base}/users/00000000-0000-0000-0000-000000000000/chat-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'привет' }),
    });
    assert.equal(ghost.status, 404, 'неизвестный пользователь отклоняется');
  }

  // --- 4. Настройки анализа и SSE-поток CLI-движка на фикстурной команде ------------------------------
  {
    config.admin.host = 'localhost';
    config.admin.logAnalysis = {
      llm: { models: ['gpt-test'], defaultModel: 'gpt-test' },
      cli: {
        presets: [{ name: 'echo', command: process.execPath, args: [fixture('cli-echo.cjs')], timeoutSec: 30 }],
        maxOutputChars: 10_000,
      },
    };

    const cfg = await (await fetch(`${base}/llm-log/analysis-config`)).json();
    assert.deepEqual(cfg.models, ['gpt-test']);
    assert.equal(cfg.cliAvailable, true);
    assert.equal(cfg.cliPresets[0].name, 'echo');

    const res = await fetch(`${base}/llm-log/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llmRequestId, question: 'что это?', engine: 'cli', preset: 'echo' }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type').includes('text/event-stream'), 'ответ — SSE-поток');
    const body = await res.text();
    assert.ok(body.includes('ANALYSIS-OK:'), 'вывод CLI дошёл до клиента');
    assert.ok(body.includes('{"done":true}'), 'поток завершён кадром done');

    const bad = await fetch(`${base}/llm-log/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llmRequestId: 999999999, question: 'q', engine: 'cli' }),
    });
    assert.equal(bad.status, 404, 'анализ несуществующей записи отклоняется');
  }

  // --- 5. CLI-движок запрещён при нелокальном хосте (403); LLM-настройки при этом отдаются -------------
  {
    config.admin.host = '0.0.0.0';
    const res = await fetch(`${base}/llm-log/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llmRequestId: 1, question: 'q', engine: 'cli' }),
    });
    assert.equal(res.status, 403, 'CLI вне localhost отклоняется до запуска команды');
    const cfg = await (await fetch(`${base}/llm-log/analysis-config`)).json();
    assert.equal(cfg.cliAvailable, false, 'фронтенду сообщается, что CLI недоступен');
  }

  console.log('llm-log-api.test.mjs: ok');
} finally {
  config.admin.logAnalysis = savedAnalysis;
  config.admin.host = savedHost;
  if (userId) {
    await query(`DELETE FROM mem.users WHERE id = $1`, [userId]);
    await queryLog(`DELETE FROM log.llm_usage WHERE user_id = $1`, [String(userId)]);
    await queryLog(`DELETE FROM log.llm_request WHERE user_id = $1`, [String(userId)]);
  }
  await new Promise((resolve) => server.close(resolve));
  await closePool();
}
