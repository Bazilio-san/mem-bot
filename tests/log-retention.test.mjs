// Модульные тесты чистки журналов по возрасту (src/pipeline/log-retention.js): порционное удаление до
// неполного пакета, «0 = хранить бессрочно», передача порога дней в запрос и устойчивость к ошибке БД.
// Реальная БД не используется — функция запросов подменяется через __setDbQueryForTests.
import assert from 'node:assert/strict';
import { runLogRetentionOnce, __setDbQueryForTests, DELETE_BATCH_SIZE } from '../src/pipeline/log-retention.js';
import { config } from '../src/config.js';

// Сохраняем и подменяем конфиг ретеншна на время тестов; в конце восстанавливаем.
const savedRetention = config.llmLog?.retention;

function fakeRows(n) {
  return Array.from({ length: n }, (_, i) => ({ id: i }));
}

// 1. Порционность: пока DELETE возвращает полный пакет, чистка продолжается; неполный пакет останавливает её.
{
  config.llmLog.retention = { llmRequestDays: 90, agentEventDays: 0, llmUsageDays: 0 };
  const calls = [];
  let pass = 0;
  __setDbQueryForTests(async (sql, params) => {
    calls.push({ sql, params });
    pass += 1;
    // Первый проход — полный пакет (удаление продолжается), второй — неполный (остановка).
    return { rows: pass === 1 ? fakeRows(DELETE_BATCH_SIZE) : fakeRows(7) };
  });

  const deleted = await runLogRetentionOnce();
  assert.equal(deleted.llmRequest, DELETE_BATCH_SIZE + 7, 'сумма удалённых по обоим проходам');
  assert.equal(deleted.agentEvent, 0, 'agent_event с порогом 0 не трогается');
  assert.equal(deleted.llmUsage, 0, 'llm_usage с порогом 0 не трогается');
  assert.equal(calls.length, 2, 'ровно два DELETE: полный пакет + неполный');
  assert.ok(calls[0].sql.includes('log.llm_request'), 'чистится именно полный журнал');
  assert.deepEqual(calls[0].params, [90], 'порог дней передаётся параметром');
}

// 2. «0 = бессрочно» для всех таблиц: ни одного запроса к БД.
{
  config.llmLog.retention = { llmRequestDays: 0, agentEventDays: 0, llmUsageDays: 0 };
  const calls = [];
  __setDbQueryForTests(async (sql) => {
    calls.push(sql);
    return { rows: [] };
  });
  const deleted = await runLogRetentionOnce();
  assert.deepEqual(deleted, { llmRequest: 0, agentEvent: 0, llmUsage: 0 });
  assert.equal(calls.length, 0, 'при нулевых порогах БД не трогается');
}

// 3. Каждая таблица чистится со своим порогом.
{
  config.llmLog.retention = { llmRequestDays: 30, agentEventDays: 60, llmUsageDays: 365 };
  const byTable = {};
  __setDbQueryForTests(async (sql, params) => {
    const table = sql.match(/FROM (log\.\w+)/)[1];
    byTable[table] = params[0];
    return { rows: [] };
  });
  await runLogRetentionOnce();
  assert.deepEqual(byTable, {
    'log.llm_request': 30,
    'log.agent_event': 60,
    'log.llm_usage': 365,
  });
}

// 4. Ошибка БД пробрасывается из runLogRetentionOnce (вызывающие обёртки в startLogRetention её гасят),
// но не оставляет процесс в неконсистентном состоянии — повторный вызов работает.
{
  config.llmLog.retention = { llmRequestDays: 90, agentEventDays: 0, llmUsageDays: 0 };
  let fail = true;
  __setDbQueryForTests(async () => {
    if (fail) {
      fail = false;
      throw new Error('БД недоступна');
    }
    return { rows: [] };
  });
  await assert.rejects(runLogRetentionOnce(), /БД недоступна/);
  const deleted = await runLogRetentionOnce();
  assert.equal(deleted.llmRequest, 0, 'после восстановления БД чистка работает');
}

// Восстановление: реальная реализация БД и исходный конфиг.
__setDbQueryForTests(null);
config.llmLog.retention = savedRetention;
console.log('log-retention.test.mjs: ok');
