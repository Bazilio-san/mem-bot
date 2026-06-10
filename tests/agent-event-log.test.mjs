// Модульные тесты журнала агентных событий: формирование записи, корреляция через AsyncLocalStorage,
// буферизация и пакетная выгрузка через общий механизм log-writer. Реальная БД не используется — функция
// записи подменяется через __setDbQueryForTests.
import assert from 'node:assert/strict';
import {
  logAgentEvent,
  flushAgentEventLog,
  buildEventRecord,
  __setDbQueryForTests,
  EVENT_COLUMNS,
  AGENT_EVENTS,
} from '../src/pipeline/agent-event-log.js';
import { runWithLlmContext } from '../src/pipeline/llm-context.js';

// Превратить позиционные значения одной строки INSERT в объект по именам колонок.
function mapRow(values, rowIndex = 0) {
  const offset = rowIndex * EVENT_COLUMNS.length;
  const row = {};
  EVENT_COLUMNS.forEach((col, i) => {
    row[col] = values[offset + i];
  });
  return row;
}

// 1. Событие внутри корреляционного контекста получает request_id/user_id/conversation_id из контекста.
{
  await runWithLlmContext({ requestId: 'llm_test_1', userId: 'u-1', conversationId: 'c-1' }, async () => {
    const record = buildEventRecord({
      eventType: AGENT_EVENTS.TOOL_STARTED,
      title: 'Вызов инструмента: memory_search',
      data: { toolName: 'memory_search', args: { query: 'день рождения' } },
    });
    assert.equal(record.request_id, 'llm_test_1');
    assert.equal(record.user_id, 'u-1');
    assert.equal(record.conversation_id, 'c-1');
    assert.equal(record.event_type, 'tool.started');
    assert.ok(record.data.includes('memory_search'), 'аргументы инструмента должны попадать в data');
    assert.equal(record.is_test, true, 'в тестовом прогоне запись помечается is_test');
  });
}

// 2. Событие вне контекста (например, подключение MCP при старте) сохраняется с пустой корреляцией.
{
  const record = buildEventRecord({
    eventType: AGENT_EVENTS.MCP_CONNECTED,
    title: 'Подключён MCP-сервер: тест',
    data: { alias: 'test', toolCount: 3 },
    durationMs: 42,
  });
  assert.equal(record.request_id, null);
  assert.equal(record.user_id, null);
  assert.equal(record.duration_ms, 42);
}

// 3. События буферизуются и выгружаются одним INSERT; ошибка инструмента несёт status и error.
{
  const captured = [];
  __setDbQueryForTests(async (sql, values) => {
    captured.push({ sql, values });
  });

  logAgentEvent({ eventType: AGENT_EVENTS.STAGE_STARTED, title: 'Стадия: классификация', data: { stage: 'classify' } });
  logAgentEvent({
    eventType: AGENT_EVENTS.TOOL_COMPLETED,
    title: 'Результат инструмента: reminder_create',
    data: { toolName: 'reminder_create', result: { error: 'нет даты' } },
    durationMs: 17,
    status: 'error',
    error: 'нет даты',
  });
  await flushAgentEventLog();

  assert.equal(captured.length, 1, 'оба события должны уйти одним пакетом');
  assert.ok(captured[0].sql.includes('log.agent_event'));
  assert.equal(captured[0].values.length, 2 * EVENT_COLUMNS.length, 'в пакете две строки');
  const row1 = mapRow(captured[0].values, 1);
  assert.equal(row1.event_type, 'tool.completed');
  assert.equal(row1.status, 'error');
  assert.equal(row1.error, 'нет даты');
  assert.equal(row1.duration_ms, 17);
}

// 4. Без eventType запись не формируется, вызов не бросает.
{
  assert.equal(buildEventRecord({ title: 'без типа' }), null);
  assert.doesNotThrow(() => logAgentEvent(null));
}

__setDbQueryForTests(null); // вернуть реальную реализацию
console.log('agent-event-log.test.mjs: ok');
