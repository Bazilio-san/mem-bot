// Модульные тесты инструмента генерации картинок (generate_image). Внешний API не вызывается по-настоящему:
// глобальный fetch подменяется заглушкой, чтобы проверить тело запроса, разбор успешного ответа, поведение при
// ошибках и срабатывание ограничения размеров. Запуск: cross-env NODE_ENV=test node tests/generate_image.test.mjs
import assert from 'node:assert/strict';
import { imageGenerateTool } from '../src/pipeline/agent-tools/image/generate_image.js';
import { config } from '../src/config.js';

const realFetch = globalThis.fetch;

// Подменяет fetch на заглушку, запоминает аргументы вызова и возвращает заданный ответ.
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return handler({ url, opts });
  };
  return calls;
}

function jsonResponse(obj, ok = true, status = 200) {
  return { ok, status, json: async () => obj };
}

// 1. Успешная генерация: правильное тело запроса и артефакт structuredContent.image в ответе.
{
  const calls = stubFetch(() => jsonResponse({ imageUrl: 'https://example/img/abc.png', model: 'flux', seed: 123 }));
  const res = await imageGenerateTool.handler(
    {},
    { prompt: 'a red cube', negative_prompt: 'blurry', width: 512, height: 512 },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, config.imageGen.apiUrl);
  assert.equal(calls[0].body.prompt, 'a red cube');
  assert.equal(calls[0].body.negative_prompt, 'blurry');
  assert.equal(calls[0].body.width, 512);
  assert.equal(calls[0].body.height, 512);
  assert.equal(res.ok, true);
  assert.equal(res.structuredContent.image.url, 'https://example/img/abc.png');
  assert.equal(res.structuredContent.image.model, 'flux');
  assert.equal(res.structuredContent.image.seed, 123);
}

// 2. Неподдерживаемый или отсутствующий размер заменяется значением по умолчанию из конфигурации.
{
  const calls = stubFetch(() => jsonResponse({ imageUrl: 'https://example/x.png', model: 'flux', seed: 1 }));
  await imageGenerateTool.handler({}, { prompt: 'p', negative_prompt: null, width: 999, height: null });
  assert.equal(calls[0].body.width, config.imageGen.width); // 999 не входит в allowedSizes → дефолт
  assert.equal(calls[0].body.height, config.imageGen.height); // null → дефолт
  assert.equal(calls[0].body.negative_prompt, ''); // null → пустая строка
}

// 3. Ненулевой код ответа возвращает понятную ошибку, а не падает.
{
  stubFetch(() => jsonResponse({}, false, 500));
  const res = await imageGenerateTool.handler({}, { prompt: 'p', negative_prompt: '', width: 512, height: 512 });
  assert.ok(res.error);
  assert.match(res.error, /HTTP 500/);
}

// 4. Ответ без поля imageUrl — тоже ошибка.
{
  stubFetch(() => jsonResponse({ model: 'flux' }));
  const res = await imageGenerateTool.handler({}, { prompt: 'p', negative_prompt: '', width: 512, height: 512 });
  assert.ok(res.error);
  assert.match(res.error, /imageUrl/);
}

// 5. Прерывание по тайм-ауту (превышение времени ожидания) сообщается отдельным понятным текстом.
{
  stubFetch(() => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  });
  const res = await imageGenerateTool.handler({}, { prompt: 'p', negative_prompt: '', width: 512, height: 512 });
  assert.ok(res.error);
  assert.match(res.error, /timed out/);
}

globalThis.fetch = realFetch;
console.log('generate_image.test.mjs: ok');
