// Модульный тест потокового вызова chatStream: проверяет, что usage из финального чанка накапливается и
// попадает в запись журнала с фактическими токенами. Сеть подменяется фальшивым клиентом OpenAI, запись в
// БД — через __setDbQueryForTests.
import assert from 'node:assert/strict';
import { chatStream } from '../src/llm.js';
import { flushLlmLog, __setDbQueryForTests, COLUMNS } from '../src/pipeline/llm-log.js';

// Превратить позиционные значения одной строки INSERT в объект по именам колонок.
function mapRow(values) {
  const row = {};
  COLUMNS.forEach((col, i) => {
    row[col] = values[i];
  });
  return row;
}

// Фальшивый поток chunks: два текстовых чанка и финальный чанк с usage и пустым choices.
function fakeStream() {
  const chunks = [
    { choices: [{ delta: { content: 'Привет' }, finish_reason: null }] },
    { choices: [{ delta: { content: ' мир' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        yield c;
      }
    },
  };
}

{
  const captured = [];
  __setDbQueryForTests(async (sql, values) => {
    captured.push({ sql, values });
  });

  const fakeClient = {
    chat: { completions: { create: async () => fakeStream() } },
  };

  const deltas = [];
  const message = await chatStream({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'привет' }],
    onDelta: (d) => deltas.push(d),
    client: fakeClient,
  });

  // Финальное сообщение собрано из текстовых чанков.
  assert.equal(message.content, 'Привет мир');
  assert.deepEqual(deltas, ['Привет', ' мир']);

  await flushLlmLog();
  assert.equal(captured.length, 1, 'обращение должно быть записано в журнал');
  const row = mapRow(captured[0].values);
  assert.equal(row.endpoint, 'chat.completions');
  assert.equal(row.model, 'gpt-4o');
  assert.equal(row.prompt_tokens, 10, 'входящие токены берутся из финального чанка usage');
  assert.equal(row.completion_tokens, 5);
  assert.equal(row.total_tokens, 15);
  // gpt-4o: 10/1e6*2.5 + 5/1e6*10 = 0.000025 + 0.00005 = 0.000075.
  assert.ok(Math.abs(Number(row.price_usd) - 0.000075) < 1e-9, `ожидалось 0.000075, получено ${row.price_usd}`);
}

__setDbQueryForTests(null);
console.log('llm-log-stream-usage.test.mjs: ok');
