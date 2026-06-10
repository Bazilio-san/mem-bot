// Модульные тесты клиентского разбора SSE-потока AI-анализа (runLogAnalysis из web/src/api.js):
// склейка кадров, разрезанных по границе сетевых чанков, многострочные data-кадры, кадр с ошибкой и
// ошибочный HTTP-статус. Сеть подменяется фейковым fetch с ReadableStream.
import assert from 'node:assert/strict';
import { runLogAnalysis } from '../web/src/api.js';

const savedFetch = globalThis.fetch;
const encoder = new TextEncoder();

// Фейковый fetch: отдаёт заданные чанки как поток тела ответа.
function fetchWithChunks(chunks, { ok = true, status = 200, json = null } = {}) {
  return async () => ({
    ok,
    status,
    json: async () => json,
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
  });
}

// 1. Кадры, разрезанные посреди строки и посреди разделителя, собираются корректно; onChunk получает куски.
{
  globalThis.fetch = fetchWithChunks([
    'data: {"text":"Пер',
    'вый"}\n\ndata: {"te',
    'xt":" второй"}\n',
    '\ndata: {"done":true}\n\n',
  ]);
  const pieces = [];
  const full = await runLogAnalysis({ llmRequestId: 1, question: 'q', engine: 'llm' }, (chunk) => {
    pieces.push(chunk);
  });
  assert.equal(full, 'Первый второй', 'кадры через границы чанков собраны в полный текст');
  assert.deepEqual(pieces, ['Первый', ' второй'], 'onChunk вызван на каждый текстовый кадр');
}

// 2. Кадр с ошибкой внутри потока превращается в исключение с текстом сервера.
{
  globalThis.fetch = fetchWithChunks(['data: {"text":"начало"}\n\n', 'data: {"error":"CLI упал"}\n\n']);
  await assert.rejects(
    runLogAnalysis({ llmRequestId: 1, question: 'q', engine: 'cli' }, () => {}),
    /CLI упал/,
  );
}

// 3. Ошибочный HTTP-статус (до начала потока) бросается с сообщением из JSON-тела.
{
  globalThis.fetch = fetchWithChunks([], { ok: false, status: 403, json: { error: 'только localhost' } });
  await assert.rejects(
    runLogAnalysis({ llmRequestId: 1, question: 'q', engine: 'cli' }, () => {}),
    /статус 403: только localhost/,
  );
}

globalThis.fetch = savedFetch;
console.log('llm-log-sse-client.test.mjs: ok');
