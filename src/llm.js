// Клиент к LLM через OpenAI SDK. Если OPENAI_BASE_URL задан, SDK работает с OpenAI-совместимым прокси
// вроде LiteLLM; если не задан, обращается напрямую к OpenAI API.
// Используется Chat Completions API (а не Responses API), потому что он совместим с обоими режимами.
// Доступны три операции: обычный чат с инструментами, чат со строгим JSON по схеме и получение эмбеддингов.
import OpenAI from 'openai';
import { config, debugEnabled } from './config.js';

const client = new OpenAI({ apiKey: config.llm.apiKey, baseURL: config.llm.baseURL });

function dbg(...args) {
  if (debugEnabled('llm')) console.error('[llm]', ...args);
}

// Чат с поддержкой инструментов. Возвращает объект message ответа модели
// (с полями content и tool_calls), чтобы вызывающий код мог отработать цикл инструментов.
export async function chat({ model = config.llm.mainModel, messages, tools, toolChoice }) {
  const body = { model, messages };
  if (tools && tools.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  dbg('chat ->', model, 'msgs:', messages.length, 'tools:', tools?.length || 0);
  const res = await client.chat.completions.create(body);
  const msg = res.choices[0].message;
  dbg('chat <-', JSON.stringify(msg).slice(0, 400));
  return msg;
}

// --- Сборка потокового ответа модели -----------------------------------------
// При потоковом вызове Chat Completions ответ приходит частями (chunks). Текст ответа лежит
// в delta.content, а вызовы инструментов — в delta.tool_calls, причём части одного вызова
// приходят по индексу: сначала может прийти id, затем имя функции, затем много фрагментов
// аргументов. Эти три чистые функции собирают из потока такой же финальный объект message,
// какой возвращает непотоковый chat, и потому покрыты модульными тестами отдельно от сети.

// Создать пустой аккумулятор потокового ответа.
export function createDeltaAccumulator() {
  return { role: 'assistant', content: '', tool_calls: [] };
}

// Добавить одну delta (содержимое choices[0].delta из очередного chunk) в аккумулятор.
export function accumulateChatDelta(acc, delta) {
  if (!delta) return acc;
  if (delta.content) acc.content += delta.content;
  if (Array.isArray(delta.tool_calls)) {
    for (const part of delta.tool_calls) {
      const index = part.index ?? acc.tool_calls.length;
      let slot = acc.tool_calls[index];
      if (!slot) {
        slot = { id: '', type: 'function', function: { name: '', arguments: '' } };
        acc.tool_calls[index] = slot;
      }
      if (part.id) slot.id = part.id;
      if (part.type) slot.type = part.type;
      if (part.function?.name) slot.function.name += part.function.name;
      if (part.function?.arguments) slot.function.arguments += part.function.arguments;
    }
  }
  return acc;
}

// Превратить аккумулятор в финальный объект message, идентичный по форме ответу непотокового chat:
// поле tool_calls присутствует только если инструменты действительно вызывались.
export function finalizeChatMessage(acc) {
  const message = { role: 'assistant', content: acc.content };
  const calls = acc.tool_calls.filter(Boolean);
  if (calls.length) message.tool_calls = calls;
  return message;
}

// Потоковый аналог chat: возвращает такой же финальный объект message (с полями content и tool_calls),
// но по мере поступления текста вызывает onDelta(chunkText), чтобы канал мог показывать ответ постепенно.
// Если инструменты не вызываются, onDelta получает текст ответа по частям; на ходу аргументы инструментов
// не разбираются — это делает вызывающий код после получения готового сообщения.
export async function chatStream({ model = config.llm.mainModel, messages, tools, toolChoice, onDelta }) {
  const body = { model, messages, stream: true };
  if (tools && tools.length) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  dbg('chatStream ->', model, 'msgs:', messages.length, 'tools:', tools?.length || 0);

  const stream = await client.chat.completions.create(body);
  const acc = createDeltaAccumulator();
  let chunks = 0;
  let finishReason = null;
  for await (const chunk of stream) {
    chunks++;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (delta.content && onDelta) await onDelta(delta.content);
    accumulateChatDelta(acc, delta);
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  const message = finalizeChatMessage(acc);
  dbg('chatStream <-', 'chunks:', chunks, 'finish:', finishReason, 'tool_calls:', message.tool_calls?.length || 0);
  return message;
}

// Чат со структурированным выводом по JSON Schema. Возвращает разобранный объект.
// Используется режим json_object с описанием схемы прямо в промпте: строгий режим
// json_schema в strict-режиме отклоняет схемы со свободными полями (data, entities),
// поэтому надёжнее задавать схему текстом и требовать соответствия ей.
export async function chatJSON({ model = config.llm.auxModel, system, user, schema, schemaName = 'result' }) {
  const schemaText = JSON.stringify(schema);
  const sys = `${system || ''}

Ответь СТРОГО одним JSON-объектом, который соответствует следующей JSON Schema (${schemaName}):
${schemaText}
Без markdown, без пояснений, без текста до или после JSON. Только сам объект.`;

  dbg('chatJSON ->', model, schemaName);
  const res = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_object' },
  });
  const content = res.choices[0].message.content;
  try {
    return JSON.parse(content);
  } catch {
    // На случай, если модель всё же обернула JSON в текст — вырезаем первый объект.
    const m = content.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Модель вернула не-JSON: ' + content.slice(0, 200));
  }
}

// Получить эмбеддинг текста для смыслового поиска памяти. При ошибке возвращает null,
// тогда система откатывается на полнотекстовый и структурный поиск без векторов.
export async function embed(text) {
  try {
    const res = await client.embeddings.create({ model: config.llm.embedModel, input: text });
    return res.data[0].embedding;
  } catch (err) {
    dbg('эмбеддинг недоступен:', err.message);
    return null;
  }
}
