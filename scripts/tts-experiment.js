// Экспериментальный модуль синтеза речи (текст в речь, TTS).
// Назначение: проверить, отдаёт ли OpenAI-совместимый прокси litellm.my-proxy.com конечную точку audio/speech,
// и в первую очередь модель gpt-4o-mini-tts, а также сравнить её с запасными вариантами.
// Запуск: node scripts/tts-experiment.js ["произвольный текст для озвучивания"]
//
// Для каждой модели замеряется время синтеза, проверяется, что вернулись непустые аудиоданные,
// и результат сохраняется в каталог _tmp/ для прослушивания. Ошибки каждой модели перехватываются
// по отдельности, чтобы сбой одной не мешал проверить остальные.
import 'dotenv/config';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = path.resolve('_tmp/tts');

// Текст по умолчанию на русском — именно поддержку русского нам и нужно подтвердить.
const DEFAULT_TEXT = process.argv[2]
  || 'Привет! Это проверка синтеза речи. Если вы слышите этот текст по-русски, значит синтез работает.';

// Перечень проверяемых конфигураций синтеза. Каждая описывает поставщика, базовый адрес, ключ и модель.
// Замечание по именам моделей: прокси litellm.my-proxy.com использует имена с префиксом поставщика,
// поэтому модель называется «openai/gpt-4o-mini-tts», а не «gpt-4o-mini-tts».
const TARGETS = [
  {
    label: 'proxy/openai/gpt-4o-mini-tts (opus)',
    baseURL: process.env.OPENAI_BASE_URL || '',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'openai/gpt-4o-mini-tts',
    voice: 'alloy',
    format: 'opus',                 // Telegram sendVoice ожидает OGG/OPUS — проверяем именно этот формат
  },
  {
    label: 'proxy/openai/gpt-4o-mini-tts (mp3)',
    baseURL: process.env.OPENAI_BASE_URL || '',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'openai/gpt-4o-mini-tts',
    voice: 'alloy',
    format: 'mp3',                  // запасной формат на случай, если прокси не поддерживает opus
  },
  {
    label: 'proxy/openai/tts-1 (opus)',
    baseURL: process.env.OPENAI_BASE_URL || '',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'openai/tts-1',
    voice: 'alloy',
    format: 'opus',
  },
];

// Один вызов синтеза напрямую через HTTP (без SDK), чтобы точно видеть исходный ответ прокси и коды ошибок.
async function synthesize(target, text) {
  const url = `${target.baseURL.replace(/\/$/, '')}/audio/speech`;
  const started = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: target.model,
      input: text,
      voice: target.voice,
      response_format: target.format,
    }),
  });
  const elapsedMs = Date.now() - started;
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${errText.slice(0, 400)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { elapsedMs, buf, contentType: res.headers.get('content-type') || '' };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  console.log(`Текст для озвучивания: «${DEFAULT_TEXT}»`);
  console.log(`Каталог для результатов: ${OUT_DIR}\n`);

  for (const target of TARGETS) {
    if (!target.apiKey) {
      console.log(`[${target.label}] пропуск: не задан ключ доступа.`);
      continue;
    }
    try {
      const { elapsedMs, buf, contentType } = await synthesize(target, DEFAULT_TEXT);
      const ext = target.format === 'opus' ? 'ogg' : target.format;
      const outPath = path.join(OUT_DIR, `${target.label.replace(/[^\w.-]+/g, '_')}.${ext}`);
      await writeFile(outPath, buf);
      console.log(
        `[${target.label}] УСПЕХ за ${elapsedMs} мс: получено ${buf.length} байт `
        + `(тип содержимого «${contentType}»), сохранено в ${outPath}.`,
      );
    } catch (err) {
      const cause = err.cause ? ` (причина: ${err.cause.code || err.cause.message})` : '';
      console.log(`[${target.label}] ОШИБКА: ${err.message}${cause}`);
    }
  }
}

main().catch((err) => {
  console.error('Критическая ошибка эксперимента синтеза речи:', err);
  process.exit(1);
});
