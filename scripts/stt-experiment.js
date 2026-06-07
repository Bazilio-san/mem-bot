// Экспериментальный модуль распознавания речи (речь в текст, STT).
// Назначение: получить на вход один готовый аудио- или видеофайл (как его присылает Telegram —
// голосовое сообщение в формате OGG/OPUS, видео-кружок в формате MP4, аудиофайл или видеофайл)
// и прогнать его через несколько облачных распознавателей, замерив время и показав результат.
//
// Проверяемые модели:
//   AssemblyAI  : universal-2          (распознавание готового файла, поддержка русского)
//   OpenAI      : gpt-4o-transcribe, gpt-4o-mini-transcribe   (через прокси litellm.finam.ru)
//   Groq        : whisper-large-v3, whisper-large-v3-turbo    (напрямую через api.groq.com)
//
// Запуск: node scripts/stt-experiment.js путь/к/файлу [код_языка]
//   код_языка необязателен (по умолчанию «ru»). Влияет на OpenAI и Groq; для AssemblyAI включается
//   автоопределение языка.
//
// Важное наблюдение: все перечисленные сервисы принимают сжатые форматы (ogg/opus, mp3, mp4, m4a, wav,
// webm) напрямую, поэтому для пути «распознавание готового файла» внешняя утилита ffmpeg НЕ требуется.
// ffmpeg нужен только для потокового whisper-rt, где на вход идёт сырой PCM.
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const FILE = process.argv[2];
const LANG = process.argv[3] || 'ru';

if (!FILE) {
  console.error('Укажите путь к аудио- или видеофайлу: node scripts/stt-experiment.js путь/к/файлу [код_языка]');
  process.exit(1);
}

const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://litellm.finam.ru/v1').replace(/\/$/, '');
const GROQ_BASE = (process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const AAI_BASE = 'https://api.assemblyai.com';

// Угадать MIME-тип по расширению, чтобы корректно подписать файл в multipart-запросе.
function guessMime(file) {
  const ext = path.extname(file).toLowerCase();
  const map = {
    '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
    '.flac': 'audio/flac', '.webm': 'audio/webm', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  };
  return map[ext] || 'application/octet-stream';
}

// --- Распознавание через OpenAI-совместимый интерфейс (подходит и для прокси, и для Groq) -------------
async function transcribeOpenAICompatible({ baseURL, apiKey, model, fileBuf, fileName, language }) {
  const form = new FormData();
  form.append('file', new Blob([fileBuf], { type: guessMime(fileName) }), path.basename(fileName));
  form.append('model', model);
  if (language) form.append('language', language);
  form.append('response_format', 'json');

  // Прокси иногда обрывает соединение по тайм-ауту (UND_ERR_CONNECT_TIMEOUT) — делаем несколько повторов.
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(`${baseURL}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const elapsedMs = Date.now() - started;
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 300)}`);
      }
      const data = await res.json();
      return { elapsedMs, text: data.text ?? JSON.stringify(data).slice(0, 300), attempts: attempt };
    } catch (err) {
      lastErr = err;
      const cause = err.cause ? ` (${err.cause.code || err.cause.message})` : '';
      if (attempt < 3) process.stdout.write(`повтор ${attempt}${cause}… `);
    }
  }
  throw lastErr;
}

// --- Распознавание через AssemblyAI (загрузка файла, создание задачи, опрос готовности) ---------------
async function transcribeAssemblyAI({ apiKey, fileBuf, language }) {
  const started = Date.now();

  // Шаг 1: загрузка файла. Заголовок авторизации у AssemblyAI — сам ключ без префикса Bearer.
  const up = await fetch(`${AAI_BASE}/v2/upload`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/octet-stream' },
    body: fileBuf,
  });
  if (!up.ok) throw new Error(`upload HTTP ${up.status}: ${(await up.text()).slice(0, 200)}`);
  const { upload_url: uploadUrl } = await up.json();

  // Шаг 2: создание задачи распознавания. Модель universal-2 поддерживает 99 языков, включая русский.
  // Параметр speech_model устарел; текущий интерфейс принимает приоритетный список speech_models.
  // Берём universal-2, так как universal-3-pro русский язык не поддерживает.
  // Включаем автоопределение языка; код языка передаётся подсказкой через language_code, если задан.
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
    if (t.status === 'completed') return { elapsedMs: Date.now() - started, text: t.text };
    if (t.status === 'error') throw new Error(`распознавание не удалось: ${t.error}`);
  }
}

// --- Перечень проверяемых распознавателей ------------------------------------------------------------
function buildTargets() {
  const targets = [];
  if (process.env.ASSEMBLYAI_API_KEY) {
    targets.push({
      label: 'AssemblyAI/universal-2',
      run: (fileBuf, fileName) =>
        transcribeAssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY, fileBuf, language: LANG }),
    });
  }
  if (process.env.OPENAI_API_KEY) {
    for (const model of ['openai/gpt-4o-transcribe', 'openai/gpt-4o-mini-transcribe']) {
      targets.push({
        label: `proxy/${model}`,
        run: (fileBuf, fileName) =>
          transcribeOpenAICompatible({
            baseURL: OPENAI_BASE, apiKey: process.env.OPENAI_API_KEY, model, fileBuf, fileName, language: LANG,
          }),
      });
    }
  }
  if (process.env.GROQ_API_KEY) {
    for (const model of ['whisper-large-v3', 'whisper-large-v3-turbo']) {
      targets.push({
        label: `groq/${model}`,
        run: (fileBuf, fileName) =>
          transcribeOpenAICompatible({
            baseURL: GROQ_BASE, apiKey: process.env.GROQ_API_KEY, model, fileBuf, fileName, language: LANG,
          }),
      });
    }
  }
  return targets;
}

async function main() {
  const fileBuf = await readFile(FILE);
  const sizeKb = (fileBuf.length / 1024).toFixed(1);
  console.log(`Файл: ${FILE} (${sizeKb} КБ, тип «${guessMime(FILE)}»), язык-подсказка: ${LANG}\n`);

  const targets = buildTargets();
  const summary = [];
  // Запускаем распознаватели по очереди (а не параллельно), чтобы замеры времени не влияли друг на друга
  // через общий сетевой канал и ограничения прокси.
  for (const target of targets) {
    process.stdout.write(`[${target.label}] распознаю… `);
    try {
      const { elapsedMs, text } = await target.run(fileBuf, FILE);
      console.log(`готово за ${elapsedMs} мс`);
      console.log(`   текст: ${text}\n`);
      summary.push({ label: target.label, ms: elapsedMs, ok: true, text });
    } catch (err) {
      console.log(`ОШИБКА: ${err.message}\n`);
      summary.push({ label: target.label, ms: null, ok: false, text: err.message });
    }
  }

  console.log('================ Сводка ================');
  for (const s of summary) {
    const time = s.ok ? `${String(s.ms).padStart(6)} мс` : '   —    ';
    console.log(`${s.label.padEnd(34)} ${s.ok ? 'OK ' : 'ОШ '} ${time}`);
  }
}

main().catch((err) => {
  console.error('Критическая ошибка эксперимента распознавания:', err);
  process.exit(1);
});
