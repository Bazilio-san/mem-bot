// Модульные тесты эмиттера журнала LLM-запросов. Проверяют буферизацию, пакетную выгрузку, устойчивость к
// ошибке вставки, принудительный слив и усечение payload. Реальная БД не используется — функция записи
// подменяется через __setDbQueryForTests.
import assert from 'node:assert/strict';
import { logLlmRequest, flushLlmLog, buildRecord, __setDbQueryForTests, COLUMNS } from '../src/pipeline/llm-log.js';

// Превратить позиционные значения одной строки INSERT в объект по именам колонок.
function mapRow(values, rowIndex = 0) {
  const offset = rowIndex * COLUMNS.length;
  const row = {};
  COLUMNS.forEach((col, i) => {
    row[col] = values[offset + i];
  });
  return row;
}

// 1. Запись буферизуется и выгружается одним INSERT; пакет содержит все накопленные строки.
{
  const captured = [];
  __setDbQueryForTests(async (sql, values) => {
    captured.push({ sql, values });
  });

  logLlmRequest({
    endpoint: 'chat.completions',
    kind: 'main_agent_answer',
    model: 'gpt-4o',
    payload: { a: 1 },
    promptTokens: 10,
    completionTokens: 5,
  });
  logLlmRequest({
    endpoint: 'embeddings',
    kind: 'embedding',
    model: 'text-embedding-3-small',
    payload: { input: 'x' },
    totalTokens: 3,
  });
  await flushLlmLog();

  assert.equal(captured.length, 1, 'обе записи должны уйти одним пакетом');
  assert.equal(captured[0].values.length, 2 * COLUMNS.length, 'в пакете две строки');
  const row0 = mapRow(captured[0].values, 0);
  assert.equal(row0.request_kind, 'main_agent_answer');
  assert.equal(row0.model, 'gpt-4o');
  assert.equal(row0.prompt_tokens, 10);
  assert.equal(row0.completion_tokens, 5);
  assert.equal(row0.total_tokens, 15, 'total_tokens выводится из суммы при отсутствии явного значения');
}

// 2. Ошибка вставки не бросается наружу; записи возвращаются в буфер и уходят при следующей удачной выгрузке.
{
  let failNext = true;
  const captured = [];
  __setDbQueryForTests(async (sql, values) => {
    if (failNext) {
      failNext = false;
      throw new Error('БД временно недоступна');
    }
    captured.push({ sql, values });
  });

  logLlmRequest({
    endpoint: 'chat.completions',
    kind: 'main_agent_answer',
    model: 'gpt-4o',
    payload: { b: 2 },
    promptTokens: 1,
    completionTokens: 1,
  });
  // Первый слив падает внутри, но не бросает наружу.
  await assert.doesNotReject(flushLlmLog());
  assert.equal(captured.length, 0, 'после ошибки запись не записана');
  // Второй слив (БД снова доступна) выгружает ту же запись.
  await flushLlmLog();
  assert.equal(captured.length, 1, 'после восстановления БД запись выгружается');
}

// 3. Усечение payload: слишком длинный payload обрезается, флаг payload_truncated поднимается.
{
  const huge = 'я'.repeat(200000);
  const record = buildRecord({
    endpoint: 'embeddings',
    kind: 'embedding',
    model: 'text-embedding-3-small',
    payload: { input: huge },
    totalTokens: 5,
  });
  assert.equal(record.payload_truncated, true, 'длинный payload должен помечаться усечённым');
  assert.ok(record.payload.length < huge.length, 'сериализованный payload должен стать короче исходной строки');
}

// 3а. Ответ модели сохраняется в response; длинный ответ усекается с поднятием response_truncated.
{
  const record = buildRecord({
    endpoint: 'chat.completions',
    kind: 'main_agent_answer',
    model: 'gpt-4o',
    payload: { messages: [{ role: 'user', content: 'привет' }] },
    response: { message: { role: 'assistant', content: 'здравствуйте' }, finish_reason: 'stop' },
    promptTokens: 5,
    completionTokens: 3,
  });
  assert.ok(record.response.includes('здравствуйте'), 'ответ модели должен сохраняться в response');
  assert.equal(record.response_truncated, false);

  const long = buildRecord({
    endpoint: 'chat.completions',
    kind: 'main_agent_answer',
    model: 'gpt-4o',
    payload: { a: 1 },
    response: { message: { role: 'assistant', content: 'ё'.repeat(200000) } },
    promptTokens: 1,
    completionTokens: 1,
  });
  assert.equal(long.response_truncated, true, 'длинный ответ должен помечаться усечённым');
  assert.ok(long.response.length < 200000, 'сериализованный ответ должен стать короче исходного');
}

// 4. Запись со status: 'error' и без токенов сохраняется (для разбора неудач), цена и токены — null.
{
  const record = buildRecord({
    endpoint: 'embeddings',
    kind: 'embedding',
    model: 'text-embedding-3-small',
    payload: { input: 'x' },
    status: 'error',
    error: 'boom',
  });
  assert.equal(record.status, 'error');
  assert.equal(record.total_tokens, null);
  assert.equal(record.price_usd, null);
  assert.equal(record.error, 'boom');
}

// 5. Пропуск request_kind на chat.completions помечается типом «untyped»: тип обязателен, и его отсутствие
// должно быть видно в журнале, а не подменяться правдоподобным значением.
{
  const record = buildRecord({
    endpoint: 'chat.completions',
    model: 'gpt-4o',
    payload: { c: 3 },
    promptTokens: 1,
    completionTokens: 1,
  });
  assert.equal(record.request_kind, 'untyped', 'вызов без kind должен помечаться untyped');
}

// 6. Конечные точки с единственным назначением сохраняют тип по конечной точке даже без явного kind.
{
  const record = buildRecord({
    endpoint: 'embeddings',
    model: 'text-embedding-3-small',
    payload: { input: 'x' },
    totalTokens: 3,
  });
  assert.equal(record.request_kind, 'embedding', 'embeddings без kind остаётся embedding');
}

__setDbQueryForTests(null); // вернуть реальную реализацию
console.log('llm-log-buffer.test.mjs: ok');
