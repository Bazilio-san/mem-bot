// Модульные тесты Telegram-отображения потоковых событий. Реальный Telegram Bot API не вызывается: вместо
// него подставляется fake-функция tg, которая накапливает вызовы. Часы now тоже подставляются, чтобы
// троттлинг редактирования был детерминированным и не зависел от реального времени.
import assert from 'node:assert/strict';
import { createTelegramProgress } from '../src/telegram/progress.js';

// Fake-канал Telegram: запоминает все вызовы и выдаёт растущие message_id для sendMessage.
function fakeTg() {
  const calls = [];
  let nextId = 100;
  const tg = async (method, body) => {
    calls.push({ method, body });
    if (method === 'sendMessage') return { message_id: ++nextId };
    return {};
  };
  return { tg, calls };
}

// 1. Серия фрагментов текста создаёт ровно один черновик (sendMessage) и несколько редактирований,
//    а финал гарантированно содержит полный текст. Индикатор набора при этом останавливается.
{
  const { tg, calls } = fakeTg();
  let clock = 0;
  const typingStops = [];
  const progress = createTelegramProgress({
    chatId: 1,
    tg,
    startTyping: () => { const s = { stopped: false }; typingStops.push(s); return () => { s.stopped = true; }; },
    options: { editIntervalMs: 900, minEditChars: 5, maxLen: 4000, now: () => clock },
  });

  await progress.onEvent({ type: 'stage.started', stage: 'llm' });   // запускает индикатор «печатает…»
  for (let i = 0; i < 4; i++) {
    clock += 1000;                                                    // сдвигаем часы за порог троттлинга
    await progress.onEvent({ type: 'assistant.delta', text: `часть${i} ` });
  }
  const sent = await progress.complete('часть0 часть1 часть2 часть3 финал');
  progress.finish();

  const sends = calls.filter((c) => c.method === 'sendMessage');
  const edits = calls.filter((c) => c.method === 'editMessageText');
  assert.equal(sends.length, 1, 'ровно один черновик ответа');
  assert.ok(edits.length >= 2, `несколько редактирований черновика, получено ${edits.length}`);
  assert.equal(edits[edits.length - 1].body.text, 'часть0 часть1 часть2 часть3 финал', 'финальный текст полный');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message_id, 101);
  assert.ok(typingStops[0]?.stopped === true, 'индикатор набора остановлен при появлении текста');
}

// 2. Вызов инструмента до появления ответа создаёт отдельное status-сообщение «Вызываю инструмент: …»,
//    которое убирается, когда начинается текст ответа.
{
  const { tg, calls } = fakeTg();
  const progress = createTelegramProgress({
    chatId: 1,
    tg,
    startTyping: () => () => {},
    options: { toolStatuses: true, now: () => 0 },
  });

  await progress.onEvent({ type: 'tool.started', toolName: 'memory_search', toolTitle: 'Поиск в памяти' });
  const statusSend = calls.find((c) => c.method === 'sendMessage');
  assert.ok(statusSend, 'статус инструмента отправлен');
  assert.equal(statusSend.body.text, 'Вызываю инструмент: Поиск в памяти');

  await progress.onEvent({ type: 'assistant.delta', text: 'Нашёл нужное.' });
  assert.ok(calls.some((c) => c.method === 'deleteMessage'), 'статус инструмента убран при появлении ответа');
  await progress.complete('Нашёл нужное.');
}

// 3. Выключенные статусы инструментов: при toolStatuses=false событие tool.started не шлёт сообщений.
{
  const { tg, calls } = fakeTg();
  const progress = createTelegramProgress({
    chatId: 1, tg, startTyping: () => () => {}, options: { toolStatuses: false, now: () => 0 },
  });
  await progress.onEvent({ type: 'tool.started', toolName: 'memory_search', toolTitle: 'Поиск в памяти' });
  assert.equal(calls.length, 0, 'при выключенных статусах сообщения не отправляются');
  await progress.complete('Готово.');
}

// 4. Длинный финальный ответ без черновика разбивается на несколько сообщений.
{
  const { tg, calls } = fakeTg();
  const progress = createTelegramProgress({ chatId: 1, tg, options: { maxLen: 10, now: () => 0 } });
  const sent = await progress.complete('0123456789ABCDEFGHIJ');           // 20 символов при пределе 10
  assert.equal(sent.length, 2, 'ответ разбит на две части');
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 2);
}

console.log('progress.test.mjs: ok');
