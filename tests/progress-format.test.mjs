// Модульные тесты применения разметки канала в потоковой доставке. Проверяется, что промежуточный
// черновик идёт сырым текстом (без parse_mode), а финал — с разметкой канала и откатом при ошибке парсинга.
import assert from 'node:assert/strict';
import { createTelegramProgress } from '../src/telegram/progress.js';
import { telegramPostProcess, telegramSplit } from '../src/telegram/format.js';

const TELEGRAM_FORMAT = { parseMode: 'HTML', postProcess: telegramPostProcess, split: telegramSplit };

// Fake-канал: запоминает вызовы. Опционально роняет sendMessage/editMessageText с parse_mode, имитируя
// отказ Telegram на битой разметке, чтобы проверить откат.
function fakeTg({ failHtml = false } = {}) {
  const calls = [];
  let nextId = 100;
  const tg = async (method, body) => {
    calls.push({ method, body });
    if (failHtml && body.parse_mode && (method === 'sendMessage' || method === 'editMessageText')) {
      throw new Error("can't parse entities");
    }
    if (method === 'sendMessage') return { message_id: ++nextId };
    return {};
  };
  return { tg, calls };
}

// 1. Промежуточный черновик идёт без parse_mode, финал — с parse_mode=HTML.
{
  const { tg, calls } = fakeTg();
  let clock = 0;
  const progress = createTelegramProgress({
    chatId: 1, tg, startTyping: () => () => {},
    options: { minFirstDraftChars: 0, editIntervalMs: 0, minEditChars: 0, now: () => clock, format: TELEGRAM_FORMAT },
  });
  clock += 1; await progress.onEvent({ type: 'assistant.delta', text: 'Привет, ' });
  clock += 1; await progress.onEvent({ type: 'assistant.delta', text: 'это черновик.' });

  const draftSend = calls.find((c) => c.method === 'sendMessage');
  assert.ok(draftSend && draftSend.body.parse_mode === undefined, 'черновик отправлен сырым текстом, без разметки');

  await progress.complete('<b>Готовый</b> ответ');
  const finalEdit = calls.filter((c) => c.method === 'editMessageText').pop();
  assert.equal(finalEdit.body.parse_mode, 'HTML', 'финальное редактирование идёт с parse_mode=HTML');
  assert.equal(finalEdit.body.text, '<b>Готовый</b> ответ', 'финальный текст сохраняет допустимую разметку');
}

// 2. Откат: если Telegram отверг разметку финала, тот же текст уходит повторно без parse_mode.
{
  const { tg, calls } = fakeTg({ failHtml: true });
  const progress = createTelegramProgress({
    chatId: 1, tg, startTyping: () => () => {},
    options: { minFirstDraftChars: 100, now: () => 0, format: TELEGRAM_FORMAT },   // порог высокий — черновика не будет
  });
  await progress.onEvent({ type: 'assistant.delta', text: 'коротко' });            // ниже порога, черновик не создан
  const sent = await progress.complete('<b>финал</b>');

  const sends = calls.filter((c) => c.method === 'sendMessage');
  assert.equal(sends.length, 2, 'первая попытка с HTML упала, вторая — без разметки');
  assert.equal(sends[0].body.parse_mode, 'HTML', 'первая попытка пыталась применить разметку');
  assert.equal(sends[1].body.parse_mode, undefined, 'откат отправил сырой текст без разметки');
  assert.equal(sent.length, 1, 'пользователь получил ровно одно итоговое сообщение');
}

// 3. Без профиля формата поведение прежнее: финал идёт сырым текстом без parse_mode.
{
  const { tg, calls } = fakeTg();
  const progress = createTelegramProgress({
    chatId: 1, tg, options: { minFirstDraftChars: 100, now: () => 0 },
  });
  await progress.complete('обычный текст');
  const send = calls.find((c) => c.method === 'sendMessage');
  assert.equal(send.body.parse_mode, undefined, 'без формата канал не навязывает разметку');
}

console.log('progress-format.test.mjs: ok');
