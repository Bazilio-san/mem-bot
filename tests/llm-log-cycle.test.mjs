// Модульные тесты сборки ленты цикла для просмотрщика логов (buildCycleRows): слияние записей журнала
// LLM-запросов с агентными событиями, порядок по времени, группы-стадии, синтетическая группа
// пост-обработки и деградация к синтезу tool-строк для исторических циклов без событий.
import assert from 'node:assert/strict';
import { buildCycleRows } from '../src/server/llm-log-data.js';

// Времена цикла: классификация → основной ответ с tool-вызовом → итерация 2 → выгрузка фактов.
const T = (sec, ms = 0) => new Date(Date.UTC(2026, 5, 9, 13, 50, sec, ms)).toISOString();

// Запись журнала chat.completions. created_at — момент ЗАВЕРШЕНИЯ вызова (так пишет llm-log).
function chatRecord({ id, kind, endSec, durationMs, payload, response, tokens = 100, status = 'ok', error = null }) {
  return {
    llm_request_id: id,
    created_at: T(endSec),
    request_id: 'llm_test_cycle',
    request_kind: kind,
    endpoint: 'chat.completions',
    model: 'gpt-test',
    payload,
    response,
    payload_truncated: false,
    response_truncated: false,
    total_tokens: tokens,
    price_usd: 0.001,
    duration_ms: durationMs,
    status,
    error,
  };
}

function event({ id, type, sec, ms = 0, title, data = null, durationMs = null, status = 'ok', error = null }) {
  return {
    agent_event_id: id,
    created_at: T(sec, ms),
    request_id: 'llm_test_cycle',
    event_type: type,
    title,
    data,
    duration_ms: durationMs,
    status,
    error,
  };
}

const basePayload = {
  model: 'gpt-test',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'напомни' },
  ],
};
const payloadWithTool = {
  model: 'gpt-test',
  messages: [
    ...basePayload.messages,
    { role: 'assistant', tool_calls: [{ id: 'c1' }] },
    { role: 'tool', content: '{"ok":true}' },
  ],
};

// 1. Полный цикл с событиями: порядок, группы, заголовки.
{
  const records = [
    chatRecord({
      id: 1,
      kind: 'intent_classify',
      endSec: 2,
      durationMs: 900,
      payload: basePayload,
      response: { message: { role: 'assistant', content: '{"intent":"x"}' } },
    }),
    chatRecord({
      id: 2,
      kind: 'main_agent_answer',
      endSec: 6,
      durationMs: 2800,
      payload: basePayload,
      response: {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'reminder_create', arguments: '{}' } }],
        },
        finish_reason: 'tool_calls',
      },
    }),
    chatRecord({
      id: 3,
      kind: 'main_agent_answer',
      endSec: 10,
      durationMs: 2100,
      payload: payloadWithTool,
      response: { message: { role: 'assistant', content: 'Готово!' }, finish_reason: 'stop' },
    }),
    chatRecord({
      id: 4,
      kind: 'fact_extract',
      endSec: 13,
      durationMs: 1500,
      payload: basePayload,
      response: { message: { role: 'assistant', content: '{"facts":[]}' } },
    }),
  ];
  const events = [
    event({ id: 1, type: 'agent.started', sec: 0, ms: 100, title: 'Ход агента начат' }),
    event({
      id: 2,
      type: 'stage.started',
      sec: 0,
      ms: 200,
      title: 'Стадия: классификация интента',
      data: { stage: 'classify' },
    }),
    event({
      id: 3,
      type: 'stage.started',
      sec: 2,
      ms: 500,
      title: 'Стадия: ответ модели (итерация 1)',
      data: { stage: 'llm', step: 1 },
    }),
    event({
      id: 4,
      type: 'tool.started',
      sec: 6,
      ms: 100,
      title: 'Вызов инструмента: reminder_create',
      data: { toolName: 'reminder_create', args: { text: 'позвонить' } },
    }),
    event({
      id: 5,
      type: 'tool.completed',
      sec: 7,
      title: 'Результат инструмента: reminder_create',
      data: { toolName: 'reminder_create', result: { ok: true } },
      durationMs: 900,
    }),
    event({
      id: 6,
      type: 'stage.started',
      sec: 7,
      ms: 500,
      title: 'Стадия: ответ модели (итерация 2)',
      data: { stage: 'llm', step: 2 },
    }),
    event({
      id: 7,
      type: 'assistant.completed',
      sec: 10,
      ms: 100,
      title: 'Ответ пользователю',
      data: { text: 'Готово!' },
    }),
    event({ id: 8, type: 'agent.completed', sec: 10, ms: 200, title: 'Ход агента завершён' }),
  ];
  const rows = buildCycleRows(records, events, {
    userMessage: { content: 'напомни позвонить маме', created_at: T(0) },
  });

  // Порядок по времени: сообщение пользователя — первая строка, ответ агента — в хвосте.
  assert.equal(rows[0].rowType, 'user_say');
  assert.equal(rows[0].n, 1, 'нумерация начинается с 1');
  const types = rows.map((r) => r.rowType);
  assert.ok(types.indexOf('agent_start') < types.indexOf('stage'), 'старт агента раньше первой стадии');

  // Пара запрос/ответ для каждой записи журнала: 4 записи → 4 запроса и 4 ответа.
  assert.equal(rows.filter((r) => r.rowType === 'llm_request').length, 4);
  assert.equal(rows.filter((r) => r.rowType === 'llm_response').length, 4);

  // Строка запроса стоит по времени НАЧАЛА вызова: для классификации это 13:50:01.100 (2 с минус 900 мс).
  const classifyReq = rows.find((r) => r.kind === 'intent_classify');
  assert.equal(new Date(classifyReq.createdAt).getTime(), new Date(T(2)).getTime() - 900);

  // Tool-строки приходят из событий (с длительностью), а не из синтеза.
  const toolResult = rows.find((r) => r.rowType === 'tool_result');
  assert.equal(toolResult.durationMs, 900);
  assert.ok(toolResult.body.content.includes('reminder_create'), 'результат инструмента содержит данные события');

  // Вызов инструмента по времени находится между ответом итерации 1 и запросом итерации 2.
  const toolCallIdx = types.indexOf('tool_call');
  const iter2ReqIdx = rows.findIndex((r) => r.title === 'Запрос → LLM (итерация 2)');
  assert.ok(toolCallIdx > 0 && toolCallIdx < iter2ReqIdx, 'вызов инструмента внутри цикла между итерациями');

  // Группы-стадии: три стадии из событий + синтетическая пост-обработка.
  const headers = rows.filter((r) => r.isGroupHeader);
  assert.equal(headers.length, 4, 'три стадии + пост-обработка');
  assert.ok(
    headers.some((h) => h.title.includes('Пост-обработка')),
    'есть синтетический заголовок пост-обработки',
  );

  // Запись fact_extract попадает в группу пост-обработки.
  const postHeader = headers.find((h) => h.title.includes('Пост-обработка'));
  const factRow = rows.find((r) => r.kind === 'fact_extract');
  assert.equal(factRow.groupId, postHeader.groupId);

  // Строки между заголовками наследуют группу своей стадии.
  const stage1 = headers.find((h) => h.title.includes('классификация'));
  assert.equal(classifyReq.groupId, stage1.groupId, 'запрос классификации в группе своей стадии');
}

// 2. Деградация без событий (исторические циклы): tool-строки синтезируются из payload/response.
{
  const records = [
    chatRecord({
      id: 1,
      kind: 'main_agent_answer',
      endSec: 3,
      durationMs: 2000,
      payload: basePayload,
      response: {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'memory_search', arguments: '{"query":"q"}' } }],
        },
      },
    }),
    chatRecord({
      id: 2,
      kind: 'main_agent_answer',
      endSec: 8,
      durationMs: 2000,
      payload: payloadWithTool,
      response: { message: { role: 'assistant', content: 'Ответ' } },
    }),
  ];
  const rows = buildCycleRows(records, [], {});
  const types = rows.map((r) => r.rowType);
  assert.ok(types.includes('tool_call'), 'вызов инструмента синтезирован из response.tool_calls');
  assert.ok(types.includes('tool_result'), 'результат инструмента синтезирован из diff массива messages');
  const callIdx = types.indexOf('tool_call');
  const resultIdx = types.indexOf('tool_result');
  assert.ok(callIdx < resultIdx, 'вызов раньше результата');
  const call = rows[callIdx];
  assert.ok(call.title.includes('memory_search'));
}

// 3. Ошибка вызова: строка запроса несёт статус и текст ошибки; ответа без response нет.
{
  const records = [
    chatRecord({
      id: 1,
      kind: 'main_agent_answer',
      endSec: 31,
      durationMs: 30000,
      payload: basePayload,
      response: null,
      tokens: null,
      status: 'error',
      error: 'Request timed out',
    }),
  ];
  const rows = buildCycleRows(records, [], {});
  const req = rows.find((r) => r.rowType === 'llm_request');
  assert.equal(req.status, 'error');
  assert.equal(req.error, 'Request timed out');
  assert.ok(!rows.some((r) => r.rowType === 'llm_response'), 'без сохранённого ответа строки ответа нет');
}

console.log('llm-log-cycle.test.mjs: ok');
