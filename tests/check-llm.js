// Проверка доступности и поведения моделей на LLM-провайдерах и сравнение их скорости.
// Список провайдеров задаётся константой PROVIDERS ниже. Запуск: node tests/check-llm.js
// Для каждого провайдера проверяется: обычный чат, структурный вывод JSON, вызов инструмента, эмбеддинги.
// В конце выводится сравнительная таблица времени отклика — главный интересующий нас показатель.
import OpenAI from 'openai';
import { config } from '../src/config.js';

// ====== Провайдеры и проверяемые модели ======
// Каждый провайдер — это свой клиент (свой ключ и базовый адрес) и своя модель.
// Cerebras работает по тому же протоколу, что и OpenAI, поэтому используется тот же клиент OpenAI,
// у которого подменены apiKey и baseURL.
const PROVIDERS = [
  {
    // Когда OPENAI_BASE_URL не задан, прокси не используется и клиент идёт напрямую к OpenAI.
    label: config.llm.baseURL ? 'LiteLLM-прокси' : 'OpenAI напрямую',
    model: process.env.MAIN_MODEL || 'gpt-5.4-mini',
    apiKey: config.llm.apiKey,
    baseURL: config.llm.baseURL,
    // Модель эмбеддингов (для последнего теста). null — пропустить проверку эмбеддингов.
    embedModel: 'text-embedding-3-small',
  },
  {
    label: 'Cerebras',
    model: 'gpt-oss-120b',
    apiKey: process.env.CEREBRAS_API_KEY,
    baseURL: process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1',
    // У Cerebras нет API эмбеддингов — проверку пропускаем.
    embedModel: null,
  },
];
// ============================================

// Один прогон набора проверок для одного провайдера. Возвращает счётчики и замеры времени.
async function runSuite(provider) {
  const client = new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseURL });
  const MODEL = provider.model;
  const EMBED_MODEL = provider.embedModel;

  let passed = 0, failed = 0;
  const timings = [];

  function ok(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
  }

  // Замер времени одного запроса. Возвращает результат, печатает и копит длительность.
  async function timed(label, fn) {
    const t0 = performance.now();
    try {
      const res = await fn();
      const ms = Math.round(performance.now() - t0);
      timings.push({ label, ms });
      console.log(`     время ответа: ${ms} мс`);
      return res;
    } catch (err) {
      // Ошибочный запрос не участвует в сравнении скорости: время до ошибки не показательно.
      // Поэтому в timings его не добавляем — в таблице сравнения у такого запроса будет прочерк.
      const ms = Math.round(performance.now() - t0);
      console.log(`     время до ошибки: ${ms} мс`);
      throw err;
    }
  }

  async function checkChat() {
    console.log('\n[1] Обычный чат');
    try {
      const res = await timed('чат', () => client.chat.completions.create({
        model: MODEL,
        messages: [{ role: 'user', content: 'Ответь одним словом: привет' }],
      }));
      const text = res.choices?.[0]?.message?.content || '';
      console.log('     ответ:', JSON.stringify(text).slice(0, 120));
      ok('Чат отвечает', text.length > 0);
    } catch (err) {
      ok('Чат отвечает', false, err.message);
    }
  }

  async function checkJsonObject() {
    console.log('\n[2] Структурный вывод (json_object)');
    try {
      const res = await timed('json_object', () => client.chat.completions.create({
        model: MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Верни строго JSON-объект вида {"city":"...","ok":true}.' },
          { role: 'user', content: 'Город — Казань.' },
        ],
      }));
      const obj = JSON.parse(res.choices[0].message.content);
      console.log('     объект:', JSON.stringify(obj).slice(0, 160));
      ok('Возвращает валидный JSON-объект', typeof obj === 'object' && obj !== null);
    } catch (err) {
      ok('Возвращает валидный JSON-объект', false, err.message);
    }
  }

  async function checkJsonSchema() {
    console.log('\n[3] Строгий json_schema (часто не работает на прокси)');
    try {
      const res = await timed('json_schema', () => client.chat.completions.create({
        model: MODEL,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'probe', strict: true,
            schema: {
              type: 'object', additionalProperties: false,
              required: ['answer'], properties: { answer: { type: 'string' } },
            },
          },
        },
        messages: [{ role: 'user', content: 'Скажи слово «тест».' }],
      }));
      const obj = JSON.parse(res.choices[0].message.content);
      ok('json_schema strict поддержан', typeof obj.answer === 'string');
    } catch (err) {
      // Не провал модели как таковой — просто фиксируем, что строгий режим недоступен.
      console.log('     строгий режим недоступен:', err.message.slice(0, 140));
      ok('json_schema strict поддержан (опционально)', false, 'используй json_object');
    }
  }

  async function checkJsonSchemaFreeform() {
    console.log('\n[3b] Строгий json_schema со СВОБОДНЫМ полем (additionalProperties:true)');
    // Проверяем конкретное утверждение: строгий режим отвергает схемы, где у вложенного
    // объекта additionalProperties=true (как у наших полей data/entities). Ожидаем ошибку.
    try {
      const res = await timed('json_schema_freeform', () => client.chat.completions.create({
        model: MODEL,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'freeform', strict: true,
            schema: {
              type: 'object', additionalProperties: false,
              required: ['data'],
              properties: {
                // Свободное поле: произвольные ключи. Несовместимо со strict-режимом OpenAI.
                data: { type: 'object', additionalProperties: true },
              },
            },
          },
        },
        messages: [{ role: 'user', content: 'Верни любой объект в поле data.' }],
      }));
      JSON.parse(res.choices[0].message.content);
      // Если прошло — значит свободные поля в strict ДОПУСТИМЫ (утверждение неверно).
      console.log('     свободное поле принято — strict со свободными полями работает');
      ok('Свободное поле в strict ОТВЕРГАЕТСЯ (ожидаемо)', false, 'на самом деле принято');
    } catch (err) {
      console.log('     отклонено:', err.message.slice(0, 160));
      // Ошибка ожидаема и подтверждает: причина — правило strict, а не модель.
      ok('Свободное поле в strict ОТВЕРГАЕТСЯ (ожидаемо)', true);
    }
  }

  async function checkTool() {
    console.log('\n[4] Вызов инструмента (function calling)');
    try {
      const res = await timed('инструмент', () => client.chat.completions.create({
        model: MODEL,
        tools: [{
          type: 'function',
          function: {
            name: 'create_reminder',
            description: 'Создать напоминание',
            parameters: {
              type: 'object', required: ['title', 'when'],
              properties: { title: { type: 'string' }, when: { type: 'string' } },
            },
          },
        }],
        messages: [{ role: 'user', content: 'Напомни мне завтра в 10 проверить цены.' }],
      }));
      const calls = res.choices[0].message.tool_calls || [];
      if (calls.length) console.log('     вызов:', calls[0].function.name, calls[0].function.arguments.slice(0, 120));
      ok('Модель вызывает инструмент', calls.length >= 1);
    } catch (err) {
      ok('Модель вызывает инструмент', false, err.message);
    }
  }

  async function checkEmbeddings() {
    if (!EMBED_MODEL) {
      console.log('\n[5] Эмбеддинги — пропущено (провайдер не предоставляет эмбеддинги)');
      return;
    }
    console.log('\n[5] Эмбеддинги');
    try {
      const res = await timed('эмбеддинги', () => client.embeddings.create({ model: EMBED_MODEL, input: 'тест эмбеддинга' }));
      const dim = res.data?.[0]?.embedding?.length || 0;
      console.log('     размерность вектора:', dim);
      ok(`Эмбеддинги работают (модель ${EMBED_MODEL})`, dim > 0);
    } catch (err) {
      ok(`Эмбеддинги работают (модель ${EMBED_MODEL})`, false, err.message);
    }
  }

  console.log(`\n############### Провайдер: ${provider.label} ###############`);
  console.log(`Базовый адрес: ${provider.baseURL || 'по умолчанию (api.openai.com)'}`);
  console.log(`Проверяемая модель: ${MODEL}`);
  if (!provider.apiKey) {
    console.log('  ⚠️  Ключ доступа не задан — провайдер пропущен.');
    return { provider, passed: 0, failed: 0, timings, skipped: true };
  }

  await checkChat();
  await checkJsonObject();
  await checkJsonSchema();
  await checkJsonSchemaFreeform();
  await checkTool();
  await checkEmbeddings();

  console.log(`\n  Итог по «${provider.label}»: пройдено ${passed}, провалено ${failed}`);
  return { provider, passed, failed, timings, skipped: false };
}

async function main() {
  const results = [];
  for (const provider of PROVIDERS) {
    results.push(await runSuite(provider));
  }

  // Общий итог по числу пройденных и проваленных проверок.
  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);
  console.log(`\n================ ИТОГ ================`);
  console.log(`Пройдено: ${totalPassed}, провалено: ${totalFailed}`);

  // Сравнение скорости. Собираем все встретившиеся виды запросов и для каждого
  // показываем время отклика каждого провайдера рядом — так видно, кто быстрее.
  const active = results.filter((r) => !r.skipped && r.timings.length);
  if (active.length) {
    const labels = [];
    for (const r of active) {
      for (const t of r.timings) if (!labels.includes(t.label)) labels.push(t.label);
    }

    console.log(`\n============ СРАВНЕНИЕ СКОРОСТИ (мс) ============`);
    const header = ['запрос'.padEnd(22), ...active.map((r) => r.provider.label.padStart(16))].join(' | ');
    console.log(header);
    console.log('-'.repeat(header.length));
    for (const label of labels) {
      const row = [label.padEnd(22)];
      for (const r of active) {
        const t = r.timings.find((x) => x.label === label);
        row.push((t ? String(t.ms) : '—').padStart(16));
      }
      console.log(row.join(' | '));
    }

    const avgRow = ['среднее'.padEnd(22)];
    for (const r of active) {
      const avg = Math.round(r.timings.reduce((s, t) => s + t.ms, 0) / r.timings.length);
      avgRow.push(String(avg).padStart(16));
    }
    console.log('-'.repeat(header.length));
    console.log(avgRow.join(' | '));
  }

  process.exit(totalFailed > 0 ? 1 : 0);
}

main();
