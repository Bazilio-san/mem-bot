// Распознавание входящего аудио из Telegram (речь в текст, STT) в режиме готового файла (pre-recorded).
// Модуль превращает вложение Telegram (голосовое сообщение, видео-кружок, присланный аудио- или видеофайл)
// в строку текста. Внутри: определение типа вложения, проверка лимитов, скачивание файла на сторону бота,
// выбор распознавателя по конфигурации и сам вызов распознавания. Telegram-адаптер про детали не знает —
// он лишь вызывает функции этого модуля и получает текст, который дальше идёт в обычный пайплайн агента.
//
// Распознавание выполняется одним HTTP-запросом к облачному сервису: внешняя утилита ffmpeg не нужна, все
// поддерживаемые сервисы принимают сжатые форматы Telegram (OGG/OPUS, MP4, M4A, WebM) напрямую. Рабочие
// реализации адаптеров перенесены из проверочного скрипта scripts/stt-experiment.js практически без изменений.
import path from 'node:path';

const OPENAI_COMPATIBLE = 'openai-compatible';
const ASSEMBLYAI = 'assemblyai';
const AAI_BASE = 'https://api.assemblyai.com';

// Реестр поддерживаемых распознавателей. Значение переменной окружения VOICE_INPUT_PROVIDER выбирает строку.
// Группа openai-compatible использует единый интерфейс audio/transcriptions (Groq и LiteLLM-прокси), поэтому
// добавление нового варианта — это одна запись в реестре, а не отдельная интеграция.
export const VOICE_PROVIDERS = {
  'groq-whisper-large-v3-turbo': {
    type: OPENAI_COMPATIBLE, keyEnv: 'GROQ_API_KEY', baseEnv: 'GROQ_BASE_URL',
    defaultBase: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo',
  },
  'groq-whisper-large-v3': {
    type: OPENAI_COMPATIBLE, keyEnv: 'GROQ_API_KEY', baseEnv: 'GROQ_BASE_URL',
    defaultBase: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3',
  },
  'assemblyai-universal-2': {
    type: ASSEMBLYAI, keyEnv: 'ASSEMBLYAI_API_KEY',
  },
  'openai-gpt-4o-transcribe': {
    type: OPENAI_COMPATIBLE, keyEnv: 'OPENAI_API_KEY', baseEnv: 'OPENAI_BASE_URL',
    defaultBase: 'https://litellm.finam.ru/v1', model: 'openai/gpt-4o-transcribe',
  },
  'openai-gpt-4o-mini-transcribe': {
    type: OPENAI_COMPATIBLE, keyEnv: 'OPENAI_API_KEY', baseEnv: 'OPENAI_BASE_URL',
    defaultBase: 'https://litellm.finam.ru/v1', model: 'openai/gpt-4o-mini-transcribe',
  },
};

// Типы вложений, для которых распознанный текст показывается пользователю перед ответом: присланные файлы.
// Для живого голосового общения (голосовое сообщение, видео-кружок) эхо не показываем — отвечаем сразу по сути.
const ECHO_KINDS = new Set(['audio', 'video', 'document']);

// Имя переменной окружения с ключом доступа для выбранного распознавателя (или null, если имя неизвестно).
export function providerKeyEnv(provider) {
  return VOICE_PROVIDERS[provider]?.keyEnv || null;
}

// Готов ли распознаватель к работе: распознаватель известен и для него задан ключ доступа в окружении.
export function isProviderConfigured(provider) {
  const spec = VOICE_PROVIDERS[provider];
  if (!spec) return false;
  return Boolean(process.env[spec.keyEnv]);
}

// Распознать ли тип вложения как «присланный файл», для которого показываем распознанный текст пользователю.
export function shouldEchoTranscript(kind) {
  return ECHO_KINDS.has(kind);
}

// Определить тип вложения и собрать его описание из полей сообщения Telegram.
// Возвращает описание вложения с речью либо null, если поддерживаемого вложения в сообщении нет.
// Для документа берём только аудио- и видео-MIME-типы, прочие документы игнорируем.
export function detectAttachment(message) {
  if (!message) return null;
  if (message.voice) {
    const v = message.voice;
    return {
      kind: 'voice', fileId: v.file_id, fileName: null,
      mimeType: v.mime_type || 'audio/ogg', durationSeconds: v.duration || 0, fileSize: v.file_size || 0,
    };
  }
  if (message.video_note) {
    const v = message.video_note;
    return {
      kind: 'video_note', fileId: v.file_id, fileName: null,
      mimeType: 'video/mp4', durationSeconds: v.duration || 0, fileSize: v.file_size || 0,
    };
  }
  if (message.audio) {
    const a = message.audio;
    return {
      kind: 'audio', fileId: a.file_id, fileName: a.file_name || null,
      mimeType: a.mime_type || 'audio/mpeg', durationSeconds: a.duration || 0, fileSize: a.file_size || 0,
    };
  }
  if (message.video) {
    const v = message.video;
    return {
      kind: 'video', fileId: v.file_id, fileName: v.file_name || null,
      mimeType: v.mime_type || 'video/mp4', durationSeconds: v.duration || 0, fileSize: v.file_size || 0,
    };
  }
  if (message.document) {
    const d = message.document;
    const mime = d.mime_type || '';
    if (mime.startsWith('audio/') || mime.startsWith('video/')) {
      return {
        kind: 'document', fileId: d.file_id, fileName: d.file_name || null,
        mimeType: mime, durationSeconds: 0, fileSize: d.file_size || 0,
      };
    }
  }
  return null;
}

// Проверить лимиты вложения до скачивания. Если длительность известна — сверяем её с пределом в секундах;
// если длительность неизвестна (документ или сервис её не прислал) — сверяем размер файла с пределом в байтах.
// Возвращает { ok: true } либо { ok: false, reason: 'too_long' | 'too_large' }.
export function checkAttachmentLimits(attachment, { maxSeconds, maxBytes }) {
  const duration = attachment.durationSeconds || 0;
  if (duration > 0 && duration > maxSeconds) return { ok: false, reason: 'too_long' };
  if (duration === 0 && attachment.fileSize > 0 && attachment.fileSize > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }
  return { ok: true };
}

// Угадать MIME-тип по расширению имени файла, чтобы корректно подписать файл в multipart-запросе.
function guessMime(fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
  const map = {
    '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
    '.flac': 'audio/flac', '.webm': 'audio/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  };
  return map[ext] || 'application/octet-stream';
}

// OpenAI-совместимые сервисы (Groq) определяют формат файла по расширению в имени, а не по MIME-типу запроса.
// Telegram отдаёт голосовое сообщение как файл с расширением .oga, которого нет в списке принимаемых Groq
// форматов, хотя по содержимому это обычный OGG/OPUS. Поэтому имя для отправки приводим к расширению из
// разрешённого списка: если расширение уже допустимо — оставляем как есть, иначе подбираем по MIME-типу.
const ACCEPTED_UPLOAD_EXT = new Set(['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'opus', 'wav', 'webm']);
function safeUploadName(fileName) {
  const ext = path.extname(fileName || '').slice(1).toLowerCase();
  if (ACCEPTED_UPLOAD_EXT.has(ext)) return path.basename(fileName);
  const mimeToExt = {
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'audio/wav': 'wav', 'audio/flac': 'flac', 'audio/webm': 'webm', 'video/mp4': 'mp4',
  };
  const target = mimeToExt[guessMime(fileName)] || 'ogg';
  const base = path.basename(fileName || 'audio', path.extname(fileName || '')) || 'audio';
  return `${base}.${target}`;
}

// Скачать файл Telegram по file_id в память процесса. Сначала методом getFile получаем относительный путь к
// файлу на серверах Telegram, затем скачиваем его по файловому адресу. Прямую ссылку наружу не отдаём: она
// содержит токен бота, поэтому стороннему сервису передаём уже сами байты, а не URL.
async function downloadTelegramFile({ telegramApiBase, botToken, fileId }) {
  const infoRes = await fetch(`${telegramApiBase}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  const info = await infoRes.json();
  if (!info.ok) throw new Error(`getFile: ${info.description || infoRes.status}`);
  const filePath = info.result.file_path;

  // Файловый адрес строим из базового адреса API, заменяя «/bot<токен>» на «/file/bot<токен>».
  // Это сохраняет хост (в том числе локальный сервер Bot API), а токен остаётся внутри процесса.
  const fileBase = telegramApiBase.replace(/\/bot[^/]+$/, `/file/bot${botToken}`);
  const fileRes = await fetch(`${fileBase}/${filePath}`);
  if (!fileRes.ok) throw new Error(`скачивание файла, код ответа HTTP ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, filePath };
}

// Распознавание через OpenAI-совместимый интерфейс audio/transcriptions (подходит и для Groq, и для прокси).
// Прокси периодически обрывает соединение по тайм-ауту (превышение времени ожидания), поэтому делаем несколько
// повторных попыток одного и того же запроса.
async function transcribeOpenAICompatible({ baseURL, apiKey, model, fileBuf, fileName, language }) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([fileBuf], { type: guessMime(fileName) }), safeUploadName(fileName));
      form.append('model', model);
      if (language) form.append('language', language);
      form.append('response_format', 'json');
      const res = await fetch(`${baseURL}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
      }
      const data = await res.json();
      return data.text ?? '';
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// Распознавание через AssemblyAI: загрузка файла, постановка задачи и опрос готовности.
// Модель universal-2 поддерживает русский язык. Параметр speech_model устарел; текущий интерфейс принимает
// приоритетный список speech_models. Код языка передаём подсказкой через language_code, если он задан, иначе
// включаем автоопределение языка через language_detection.
async function transcribeAssemblyAI({ apiKey, fileBuf, language }) {
  // Шаг 1: загрузка файла. Заголовок авторизации у AssemblyAI — сам ключ без префикса Bearer.
  const up = await fetch(`${AAI_BASE}/v2/upload`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/octet-stream' },
    body: fileBuf,
  });
  if (!up.ok) throw new Error(`upload HTTP ${up.status}: ${(await up.text()).slice(0, 200)}`);
  const { upload_url: uploadUrl } = await up.json();

  // Шаг 2: постановка задачи распознавания.
  const body = { audio_url: uploadUrl, speech_models: ['universal-2'] };
  if (language) body.language_code = language; else body.language_detection = true;
  const cr = await fetch(`${AAI_BASE}/v2/transcript`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!cr.ok) throw new Error(`create HTTP ${cr.status}: ${(await cr.text()).slice(0, 300)}`);
  const created = await cr.json();

  // Шаг 3: опрос готовности раз в секунду, пока статус не станет completed или error.
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const pr = await fetch(`${AAI_BASE}/v2/transcript/${created.id}`, { headers: { Authorization: apiKey } });
    if (!pr.ok) throw new Error(`poll HTTP ${pr.status}: ${(await pr.text()).slice(0, 200)}`);
    const t = await pr.json();
    if (t.status === 'completed') return t.text || '';
    if (t.status === 'error') throw new Error(`распознавание не удалось: ${t.error}`);
  }
}

// Скачать вложение Telegram и распознать его выбранным распознавателем. Возвращает распознанный текст вместе
// со служебными сведениями: признак пустого результата, длительность, размер и имя распознавателя.
// Контракт явный: модуль получает базовый адрес Telegram API и токен бота аргументами и не читает приватные
// детали Telegram-адаптера.
export async function transcribeTelegramAttachment({ attachment, telegramApiBase, botToken, provider, language }) {
  const spec = VOICE_PROVIDERS[provider];
  if (!spec) throw new Error(`Неизвестный распознаватель речи: ${provider}`);
  const apiKey = process.env[spec.keyEnv];
  if (!apiKey) throw new Error(`Не задан ключ ${spec.keyEnv} для распознавателя ${provider}`);

  const { buffer, filePath } = await downloadTelegramFile({
    telegramApiBase, botToken, fileId: attachment.fileId,
  });
  const fileName = attachment.fileName || (filePath ? filePath.split('/').pop() : 'audio');

  let text;
  if (spec.type === ASSEMBLYAI) {
    text = await transcribeAssemblyAI({ apiKey, fileBuf: buffer, language });
  } else {
    const baseURL = (process.env[spec.baseEnv] || spec.defaultBase).replace(/\/$/, '');
    text = await transcribeOpenAICompatible({
      baseURL, apiKey, model: spec.model, fileBuf: buffer, fileName, language,
    });
  }

  const clean = (text || '').trim();
  return {
    text: clean,
    empty: clean.length === 0,
    durationSeconds: attachment.durationSeconds,
    fileSize: attachment.fileSize,
    provider,
  };
}
