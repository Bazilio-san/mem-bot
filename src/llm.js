// Клиент к LLM через OpenAI-совместимый LiteLLM-прокси.
// Используется Chat Completions API (а не Responses API), потому что он надёжно
// поддерживается прокси. Доступны три операции: обычный чат с инструментами,
// чат со строгим JSON по схеме и получение эмбеддингов.
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

// Чат со структурированным выводом по JSON Schema. Возвращает разобранный объект.
// Используется режим json_object с описанием схемы прямо в промпте: строгий режим
// json_schema на этом LiteLLM-прокси отклоняет схемы со свободными полями (data, entities),
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
