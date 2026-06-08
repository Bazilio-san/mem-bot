// Модульные тесты сборки потокового ответа модели. Проверяют чистые функции из src/llm.js, которые
// собирают из потоковых частей (chunks) такой же финальный объект message, как непотоковый chat. Сеть и
// реальный прокси здесь не задействованы.
import assert from 'node:assert/strict';
import { runModelTurn } from '../src/agent.js';
import { createDeltaAccumulator, accumulateChatDelta, finalizeChatMessage } from '../src/llm.js';

// 1. Накопление текста ответа из нескольких delta.content.
{
  const acc = createDeltaAccumulator();
  accumulateChatDelta(acc, { content: 'Привет' });
  accumulateChatDelta(acc, { content: ', ' });
  accumulateChatDelta(acc, { content: 'мир!' });
  const msg = finalizeChatMessage(acc);
  assert.equal(msg.content, 'Привет, мир!');
  assert.equal('tool_calls' in msg, false, 'без инструментов поля tool_calls быть не должно');
}

// 2. Один вызов инструмента, собранный из нескольких фрагментов имени и аргументов.
{
  const acc = createDeltaAccumulator();
  accumulateChatDelta(acc, { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'memory_', arguments: '' } }] });
  accumulateChatDelta(acc, { tool_calls: [{ index: 0, function: { name: 'search', arguments: '{"query":' } }] });
  accumulateChatDelta(acc, { tool_calls: [{ index: 0, function: { arguments: '"билеты"}' } }] });
  const msg = finalizeChatMessage(acc);
  assert.equal(msg.tool_calls.length, 1);
  assert.deepEqual(msg.tool_calls[0], {
    id: 'call_1', type: 'function', function: { name: 'memory_search', arguments: '{"query":"билеты"}' },
  });
  assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { query: 'билеты' });
}

// 3. Два разных вызова инструментов по разным index.
{
  const acc = createDeltaAccumulator();
  accumulateChatDelta(acc, { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'first', arguments: '{}' } }] });
  accumulateChatDelta(acc, { tool_calls: [{ index: 1, id: 'b', type: 'function', function: { name: 'second', arguments: '{}' } }] });
  const msg = finalizeChatMessage(acc);
  assert.equal(msg.tool_calls.length, 2);
  assert.equal(msg.tool_calls[0].function.name, 'first');
  assert.equal(msg.tool_calls[1].function.name, 'second');
  assert.equal(msg.tool_calls[0].id, 'a');
  assert.equal(msg.tool_calls[1].id, 'b');
}

// 4. Когда инструменты не вызывались, поля tool_calls в финальном объекте нет.
{
  const acc = createDeltaAccumulator();
  accumulateChatDelta(acc, { content: 'просто текст' });
  const msg = finalizeChatMessage(acc);
  assert.equal('tool_calls' in msg, false);
  assert.equal(msg.role, 'assistant');
}

// 5. Agent model turn не публикует текстовые дельты, если ход завершился вызовом инструмента.
{
  const events = [];
  const msg = await runModelTurn({
    streamingOn: true,
    model: 'test-model',
    messages: [{ role: 'user', content: 'test' }],
    tools: [{ type: 'function', function: { name: 'memory_search' } }],
    emit: (event) => events.push(event),
    chatStreamFn: async ({ onDelta }) => {
      onDelta('Сейчас проверю. ');
      return {
        role: 'assistant',
        content: 'Сейчас проверю. ',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'memory_search', arguments: '{"query":"test"}' },
        }],
      };
    },
    chatFn: async () => {
      throw new Error('chat fallback must not be called');
    },
  });
  assert.equal(msg.tool_calls.length, 1);
  assert.deepEqual(events, []);
}

// 6. Agent model turn публикует буферизованные дельты для финального текстового ответа.
{
  const events = [];
  const msg = await runModelTurn({
    streamingOn: true,
    model: 'test-model',
    messages: [{ role: 'user', content: 'test' }],
    tools: [],
    emit: (event) => events.push(event),
    chatStreamFn: async ({ onDelta }) => {
      onDelta('При');
      onDelta('вет');
      return { role: 'assistant', content: 'Привет' };
    },
    chatFn: async () => {
      throw new Error('chat fallback must not be called');
    },
  });
  assert.equal(msg.content, 'Привет');
  assert.deepEqual(events, [
    { type: 'assistant.delta', text: 'При' },
    { type: 'assistant.delta', text: 'вет' },
  ]);
}

// 7. Ранняя ошибка streaming API откатывается на обычный chat, пока пользователь не видел дельты.
{
  const events = [];
  const msg = await runModelTurn({
    streamingOn: true,
    model: 'test-model',
    messages: [{ role: 'user', content: 'test' }],
    tools: [],
    emit: (event) => events.push(event),
    chatStreamFn: async ({ onDelta }) => {
      onDelta('невидимый буфер');
      throw new Error('transport reset');
    },
    chatFn: async () => ({ role: 'assistant', content: 'Ответ через fallback' }),
  });
  assert.equal(msg.content, 'Ответ через fallback');
  assert.deepEqual(events, []);
}

console.log('streaming.test.mjs: ok');
