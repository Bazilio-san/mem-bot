// Проверка модуля распознавания входящего аудио (речь в текст) src/voice/transcribe.js.
// Сетевые вызовы к Telegram и распознавателям подменяются заглушкой global.fetch, поэтому тест не зависит
// от внешних сервисов и ключей. Базы данных тест не касается и в базовый прогон npm test не входит.
// Запуск: npm run test:voice
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detectAttachment,
  checkAttachmentLimits,
  shouldEchoTranscript,
  transcribeTelegramAttachment,
  isProviderConfigured,
  VOICE_PROVIDERS,
} from '../src/voice/transcribe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0,
  failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

// Заглушка ответа fetch с минимальным набором методов, которые использует модуль.
function fakeResponse({ ok = true, status = 200, json = null, text = '', bytes = 8 }) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => text,
    arrayBuffer: async () => new ArrayBuffer(bytes),
  };
}

const TELEGRAM_API = 'https://api.telegram.org/bot12345:TESTTOKEN';
const TELEGRAM_TOKEN = '12345:TESTTOKEN';

// Поставить заглушку global.fetch, маршрутизирующую по адресу запроса. Возвращает журнал вызовов: для каждого
// адреса сохраняем сам адрес и — если телом был multipart с полем file — имя отправленного файла. Имя нужно,
// чтобы проверить нормализацию расширения (Groq принимает формат по расширению имени, а не по MIME-типу).
function installFetch(routes) {
  const calls = [];
  const uploadNames = [];
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    calls.push(u);
    const body = options?.body;
    if (body && typeof body.get === 'function') {
      const file = body.get('file');
      if (file && typeof file.name === 'string') {
        uploadNames.push(file.name);
      }
    }
    for (const [needle, response] of routes) {
      if (u.includes(needle)) {
        return response;
      }
    }
    throw new Error(`Заглушка fetch не знает адрес: ${u}`);
  };
  calls.uploadNames = uploadNames;
  return calls;
}

// ---- 1. Определение типа вложения -------------------------------------------
function layerDetect() {
  section('1. Определение типа вложения');

  const voice = detectAttachment({ voice: { file_id: 'v1', duration: 12, file_size: 4000, mime_type: 'audio/ogg' } });
  check('1.1. Голосовое сообщение распознаётся как voice', voice?.kind === 'voice' && voice.fileId === 'v1');

  const note = detectAttachment({ video_note: { file_id: 'n1', duration: 8, file_size: 9000 } });
  check(
    '1.2. Видео-кружок распознаётся как video_note с MIME video/mp4',
    note?.kind === 'video_note' && note.mimeType === 'video/mp4',
  );

  const audio = detectAttachment({
    audio: { file_id: 'a1', duration: 30, file_name: 'song.mp3', mime_type: 'audio/mpeg' },
  });
  check(
    '1.3. Аудиофайл распознаётся как audio с именем файла',
    audio?.kind === 'audio' && audio.fileName === 'song.mp3',
  );

  const video = detectAttachment({ video: { file_id: 'vd1', duration: 40, mime_type: 'video/mp4' } });
  check('1.4. Видеофайл распознаётся как video', video?.kind === 'video');

  const docAudio = detectAttachment({ document: { file_id: 'd1', mime_type: 'audio/mp4', file_size: 1000 } });
  check('1.5. Документ с аудио-MIME распознаётся как document', docAudio?.kind === 'document');

  const docOther = detectAttachment({ document: { file_id: 'd2', mime_type: 'application/pdf', file_size: 1000 } });
  check('1.6. Документ с посторонним MIME игнорируется (null)', docOther === null);

  const plain = detectAttachment({ text: 'просто текст' });
  check('1.7. Сообщение без вложения даёт null', plain === null);
}

// ---- 2. Политика показа распознанного текста --------------------------------
function layerEchoPolicy() {
  section('2. Политика показа распознанного текста (эхо)');
  check('2.1. Голос не показывает эхо', shouldEchoTranscript('voice') === false);
  check('2.2. Видео-кружок не показывает эхо', shouldEchoTranscript('video_note') === false);
  check('2.3. Аудиофайл показывает эхо', shouldEchoTranscript('audio') === true);
  check('2.4. Видеофайл показывает эхо', shouldEchoTranscript('video') === true);
  check('2.5. Документ показывает эхо', shouldEchoTranscript('document') === true);
}

// ---- 3. Лимиты длительности и размера ----------------------------------------
function layerLimits() {
  section('3. Лимиты длительности и размера');
  const opts = { maxSeconds: 300, maxBytes: 25000000 };

  check(
    '3.1. Запись в пределах длительности проходит',
    checkAttachmentLimits({ durationSeconds: 120, fileSize: 5000 }, opts).ok === true,
  );

  const tooLong = checkAttachmentLimits({ durationSeconds: 600, fileSize: 5000 }, opts);
  check('3.2. Слишком длинная запись отклоняется (too_long)', !tooLong.ok && tooLong.reason === 'too_long');

  const tooLarge = checkAttachmentLimits({ durationSeconds: 0, fileSize: 30000000 }, opts);
  check(
    '3.3. Без длительности слишком большой файл отклоняется (too_large)',
    !tooLarge.ok && tooLarge.reason === 'too_large',
  );

  check(
    '3.4. Без длительности файл в пределах размера проходит',
    checkAttachmentLimits({ durationSeconds: 0, fileSize: 1000000 }, opts).ok === true,
  );
}

// ---- 4. Готовность распознавателя по ключу -----------------------------------
function layerConfigured() {
  section('4. Готовность распознавателя по наличию ключа');
  const saved = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  check('4.1. Без ключа распознаватель не готов', isProviderConfigured('groq-whisper-large-v3-turbo') === false);
  process.env.GROQ_API_KEY = 'test-key';
  check('4.2. С ключом распознаватель готов', isProviderConfigured('groq-whisper-large-v3-turbo') === true);
  check('4.3. Неизвестный распознаватель не готов', isProviderConfigured('nonexistent') === false);
  if (saved === undefined) {
    delete process.env.GROQ_API_KEY;
  } else {
    process.env.GROQ_API_KEY = saved;
  }
}

// ---- 5. Сквозное распознавание через заглушку сети ---------------------------
async function layerTranscribe() {
  section('5. Сквозное распознавание (заглушка сети)');
  const savedFetch = globalThis.fetch;
  const savedGroq = process.env.GROQ_API_KEY;
  const savedOpenai = process.env.OPENAI_API_KEY;

  // 5.1. Распознанный текст доходит без искажений (OpenAI-совместимый путь, Groq).
  {
    process.env.GROQ_API_KEY = 'test-key';
    const calls = installFetch([
      ['/getFile', fakeResponse({ json: { ok: true, result: { file_path: 'voice/file_1.oga' } } })],
      ['/file/bot', fakeResponse({ bytes: 16 })],
      ['/audio/transcriptions', fakeResponse({ json: { text: 'привет мир, как дела' } })],
    ]);
    const res = await transcribeTelegramAttachment({
      attachment: { kind: 'voice', fileId: 'v1', fileName: null, durationSeconds: 5, fileSize: 4000 },
      telegramApiBase: TELEGRAM_API,
      botToken: TELEGRAM_TOKEN,
      provider: 'groq-whisper-large-v3-turbo',
      language: 'ru',
    });
    check('5.1. Распознанный текст доходит без искажений', res.text === 'привет мир, как дела' && res.empty === false);
    const usedFileEndpoint = calls.some((c) => c.includes('/file/bot12345:TESTTOKEN/voice/file_1.oga'));
    check('5.1b. Файл скачивается по файловому адресу с токеном (а не отдаётся ссылкой)', usedFileEndpoint);
    // Telegram отдаёт голос с расширением .oga, которого нет в списке принимаемых Groq форматов. Имя файла в
    // запросе распознавания должно быть приведено к допустимому расширению .ogg, иначе сервис вернёт HTTP 400.
    const sentName = calls.uploadNames[0] || '';
    check(
      '5.1c. Имя файла нормализуется с .oga на .ogg для распознавателя',
      sentName.endsWith('.ogg') && !sentName.endsWith('.oga'),
      `отправлено имя: ${sentName}`,
    );
  }

  // 5.2. Пустой результат распознавания помечается признаком empty.
  {
    process.env.GROQ_API_KEY = 'test-key';
    installFetch([
      ['/getFile', fakeResponse({ json: { ok: true, result: { file_path: 'voice/file_2.oga' } } })],
      ['/file/bot', fakeResponse({ bytes: 16 })],
      ['/audio/transcriptions', fakeResponse({ json: { text: '   ' } })],
    ]);
    const res = await transcribeTelegramAttachment({
      attachment: { kind: 'voice', fileId: 'v2', fileName: null, durationSeconds: 5, fileSize: 4000 },
      telegramApiBase: TELEGRAM_API,
      botToken: TELEGRAM_TOKEN,
      provider: 'groq-whisper-large-v3-turbo',
      language: 'ru',
    });
    check('5.2. Пустой результат распознавания даёт empty=true', res.empty === true && res.text === '');
  }

  // 5.3. Неизвестный распознаватель отклоняется до скачивания.
  {
    let threw = false;
    try {
      await transcribeTelegramAttachment({
        attachment: { kind: 'voice', fileId: 'v3', durationSeconds: 5, fileSize: 4000 },
        telegramApiBase: TELEGRAM_API,
        botToken: TELEGRAM_TOKEN,
        provider: 'no-such-provider',
        language: 'ru',
      });
    } catch {
      threw = true;
    }
    check('5.3. Неизвестный распознаватель бросает ошибку', threw);
  }

  // 5.4. Отсутствие ключа доступа отклоняется до скачивания.
  {
    delete process.env.OPENAI_API_KEY;
    let threw = false;
    try {
      await transcribeTelegramAttachment({
        attachment: { kind: 'audio', fileId: 'a1', durationSeconds: 5, fileSize: 4000 },
        telegramApiBase: TELEGRAM_API,
        botToken: TELEGRAM_TOKEN,
        provider: 'openai-gpt-4o-transcribe',
        language: 'ru',
      });
    } catch {
      threw = true;
    }
    check('5.4. Отсутствие ключа доступа бросает ошибку', threw);
  }

  globalThis.fetch = savedFetch;
  if (savedGroq === undefined) {
    delete process.env.GROQ_API_KEY;
  } else {
    process.env.GROQ_API_KEY = savedGroq;
  }
  if (savedOpenai === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = savedOpenai;
  }
}

// ---- 6. Реестр распознавателей и сохранность инлайн-кнопок --------------------
function layerRegistryAndAdapter() {
  section('6. Реестр распознавателей и сохранность инлайн-кнопок');

  const need = [
    'groq-whisper-large-v3-turbo',
    'groq-whisper-large-v3',
    'assemblyai-universal-2',
    'openai-gpt-4o-transcribe',
    'openai-gpt-4o-mini-transcribe',
  ];
  check(
    '6.1. В реестре все пять распознавателей',
    need.every((p) => p in VOICE_PROVIDERS),
  );

  // Развилка распознавания не должна задеть приём нажатий инлайн-кнопок: callback_query остаётся в allowed_updates.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'telegram', 'bot.js'), 'utf8');
  check(
    '6.2. allowed_updates сохраняет callback_query (инлайн-кнопки не сломаны)',
    /allowed_updates:\s*\[[^\]]*'callback_query'[^\]]*\]/.test(src),
  );
  check(
    '6.3. Telegram-адаптер вызывает распознавание вложения',
    /transcribeTelegramAttachment/.test(src) && /detectAttachment/.test(src),
  );
}

async function main() {
  console.log('Проверка модуля распознавания входящего аудио.\n');
  try {
    layerDetect();
    layerEchoPolicy();
    layerLimits();
    layerConfigured();
    await layerTranscribe();
    layerRegistryAndAdapter();
  } catch (err) {
    console.error('\nКритическая ошибка прогона:', err);
    failed++;
  }
  console.log(`\n================ ИТОГ ================`);
  console.log(`Пройдено: ${passed}, провалено: ${failed}`);
  if (failures.length) {
    console.log('Провалены:', failures.join('; '));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main();
