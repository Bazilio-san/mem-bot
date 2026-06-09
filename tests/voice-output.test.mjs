// Проверка модуля синтеза голосового ответа src/voice/tts.js и развилки доставки в Telegram-адаптере.
// Сеть и модель подменяются заглушками (через инъекцию параметров opts), поэтому тест не зависит от внешних
// сервисов, ключей и базы данных и в базовый прогон npm test не входит. Запуск: npm run test:voice-output
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import {
  hasCodeOrList, clampToLimit, buildVoiceText, synthesizeSpeech,
} from '../src/voice/tts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(title) { console.log(`\n=== ${title} ===`); }

// ---- 1. Распознавание кода и списков ----------------------------------------
function layerMarkup() {
  section('1. Распознавание кода и списков в ответе');
  check('1.1. Блок кода в тройных кавычках распознаётся', hasCodeOrList('Вот пример:\n```js\nx=1\n```') === true);
  check('1.2. Маркированный список из двух пунктов распознаётся',
    hasCodeOrList('Список:\n- первый пункт\n- второй пункт') === true);
  check('1.3. Нумерованный список распознаётся', hasCodeOrList('1. раз\n2. два') === true);
  check('1.4. Обычный связный текст не считается кодом или списком',
    hasCodeOrList('Это просто короткий ответ из одного предложения.') === false);
  check('1.5. Один пункт списком не считается', hasCodeOrList('- единственный пункт') === false);
}

// ---- 2. Обрезка по пределу длины --------------------------------------------
function layerClamp() {
  section('2. Обрезка текста по пределу длины');
  check('2.1. Короткая строка не меняется', clampToLimit('Привет, как дела?', 500) === 'Привет, как дела?');

  const long = 'Первое предложение. Второе предложение. Третье предложение, которое уже выходит за лимит.';
  const cut = clampToLimit(long, 40);
  check('2.2. Обрезка не превышает лимит', cut.length <= 40, `длина ${cut.length}`);
  check('2.3. Обрезка идёт по границе предложения', /[.!?…]$/.test(cut), `«${cut}»`);

  const noBoundary = 'а'.repeat(100);
  check('2.4. Без границы предложения режется жёстко по лимиту', clampToLimit(noBoundary, 30).length === 30);
}

// ---- 3. Выбор текста для озвучивания ----------------------------------------
async function layerBuildVoiceText() {
  section('3. Выбор текста для озвучивания (целиком или резюме)');

  // 3.1. Короткий ответ без кода и списков озвучивается целиком, резюме не строится.
  {
    let summarizeCalled = false;
    const summarize = async () => { summarizeCalled = true; return 'резюме'; };
    const r = await buildVoiceText('Короткий ответ без кода.', { summarize });
    check('3.1. Короткий ответ озвучивается целиком без резюме',
      r.summarized === false && r.text === 'Короткий ответ без кода.' && summarizeCalled === false);
  }

  // 3.2. Длинный ответ озвучивается через резюме, полный ответ помечается как требующий текстовой доставки.
  {
    const longAnswer = 'Очень длинный ответ. '.repeat(60);                  // заведомо больше 500 символов
    const summarize = async (text, limit) => {
      check('3.2a. В резюмирование передан предел не больше жёсткого лимита', limit <= config.voiceOutput.maxChars);
      return 'Краткое резюме длинного ответа.';
    };
    const r = await buildVoiceText(longAnswer, { summarize });
    check('3.2b. Длинный ответ озвучивается через резюме',
      r.summarized === true && r.text === 'Краткое резюме длинного ответа.');
  }

  // 3.3. Ответ с кодом озвучивается через резюме, даже если он короткий.
  {
    const summarize = async () => 'Объяснение без кода.';
    const r = await buildVoiceText('Решение:\n```js\nconst x = 1;\n```', { summarize });
    check('3.3. Короткий ответ с кодом всё равно идёт через резюме',
      r.summarized === true && r.text === 'Объяснение без кода.');
  }

  // 3.4. Слишком длинное резюме обрезается до предела (жёсткий лимит 500 соблюдается).
  {
    const longAnswer = 'Длинный ответ. '.repeat(60);
    const summarize = async () => 'А. '.repeat(400);                        // резюме заведомо длиннее лимита
    const r = await buildVoiceText(longAnswer, { summarize });
    check('3.4. Резюме обрезается до жёсткого лимита 500 символов',
      r.summarized === true && r.text.length <= config.voiceOutput.maxChars, `длина ${r.text?.length}`);
  }

  // 3.5. Пустое резюме даёт text=null — сигнал каналу откатиться на текстовую доставку.
  {
    const longAnswer = 'Длинный ответ. '.repeat(60);
    const summarize = async () => '';
    const r = await buildVoiceText(longAnswer, { summarize });
    check('3.5. Пустое резюме даёт сигнал отката на текст (text=null)', r.summarized === true && r.text === null);
  }
}

// ---- 4. Синтез речи через заглушку сети -------------------------------------
async function layerSynthesize() {
  section('4. Синтез речи (заглушка сети)');

  // 4.1. Успешный синтез возвращает байты аудио.
  {
    const fakeFetch = async () => ({
      ok: true, status: 200,
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(32),
    });
    const buf = await synthesizeSpeech('Привет.', { fetch: fakeFetch });
    check('4.1. Успешный синтез возвращает непустой буфер', Buffer.isBuffer(buf) && buf.length === 32);
  }

  // 4.2. Повторные попытки: первые две неудачи, третья успешна.
  {
    let calls = 0;
    const fakeFetch = async () => {
      calls += 1;
      if (calls < 3) throw new Error('обрыв соединения по тайм-ауту');
      return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => new ArrayBuffer(8) };
    };
    const buf = await synthesizeSpeech('Привет.', { fetch: fakeFetch });
    check('4.2. Синтез повторяет попытки и добивается успеха', buf.length === 8 && calls === 3, `попыток ${calls}`);
  }

  // 4.3. После трёх неудач синтез бросает ошибку.
  {
    const fakeFetch = async () => { throw new Error('прокси недоступен'); };
    let threw = false;
    try { await synthesizeSpeech('Привет.', { fetch: fakeFetch }); } catch { threw = true; }
    check('4.3. После трёх неудач синтез бросает ошибку', threw);
  }

  // 4.4. Пользовательский голос передаётся в тело запроса вместо глобального fallback.
  {
    let body = null;
    const fakeFetch = async (url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => '', arrayBuffer: async () => new ArrayBuffer(8) };
    };
    await synthesizeSpeech('Привет.', { fetch: fakeFetch, voice: 'onyx' });
    check('4.4. synthesizeSpeech передаёт opts.voice в audio/speech', body?.voice === 'onyx',
      `voice=${body?.voice}`);
  }
}

// ---- 5. Развилка доставки в Telegram-адаптере (проверка исходника) -----------
function layerAdapterWiring() {
  section('5. Развилка доставки в Telegram-адаптере');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'telegram', 'bot.js'), 'utf8');

  // Реакции должны проверяться ДО голоса: ветка реакции стоит в deliverAgentResult раньше голосовой ветки.
  const reactionIdx = src.indexOf("delivery?.kind === 'reaction'");
  const voiceIdx = src.indexOf("result.replyMode === 'voice'");
  check('5.1. Ветка реакции проверяется раньше голосовой (реакции допустимы в голосовом режиме)',
    reactionIdx > 0 && voiceIdx > 0 && reactionIdx < voiceIdx);

  check('5.2. Голос отправляется методом sendVoice', /async function sendVoice\(/.test(src) && /\/sendVoice/.test(src));
  check('5.3. Голосовые сообщения сохраняются с видом «voice»', /saveSentRefs\([^)]*'voice'\)/.test(src));
  check('5.4. На время синтеза показывается индикатор record_voice', /record_voice/.test(src));
  check('5.5. Голос гейтится флагом VOICE_OUTPUT_ENABLED', /config\.voiceOutput\.enabled/.test(src));
  check('5.6. В голосовую доставку передаётся пользовательский voiceOutputVoice',
    /voiceOutputVoice/.test(src) && /synthesizeSpeech\(text,\s*\{\s*voice/.test(src));
}

async function main() {
  console.log('Проверка модуля синтеза голосового ответа и развилки доставки.\n');
  try {
    layerMarkup();
    layerClamp();
    await layerBuildVoiceText();
    await layerSynthesize();
    layerAdapterWiring();
  } catch (err) {
    console.error('\nКритическая ошибка прогона:', err);
    failed++;
  }
  console.log(`\n================ ИТОГ ================`);
  console.log(`Пройдено: ${passed}, провалено: ${failed}`);
  if (failures.length) console.log('Провалены:', failures.join('; '));
  process.exit(failed > 0 ? 1 : 0);
}

main();
