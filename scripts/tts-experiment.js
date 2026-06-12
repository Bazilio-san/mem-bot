// Experimental speech synthesis module (text to speech, TTS).
// Purpose: check whether the OpenAI-compatible proxy litellm.my-proxy.com exposes the audio/speech endpoint,
// primarily the gpt-4o-mini-tts model, and compare it with the fallback options.
// Run: node scripts/tts-experiment.js ["arbitrary text to synthesize"]
//
// For each model the synthesis time is measured, the response is checked for non-empty audio data,
// and the result is saved into the _tmp/ directory for listening. Errors of each model are caught
// individually so that one failure does not prevent checking the others.
import { config } from '../src/config.js';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT_DIR = path.resolve('_tmp/tts');

// Default text is in Russian — Russian support is exactly what we need to confirm.
const DEFAULT_TEXT =
  process.argv[2] || 'Привет! Это проверка синтеза речи. Если вы слышите этот текст по-русски, значит синтез работает.';

// List of synthesis configurations to test. Each one describes a provider, base URL, key and model.
// Note on model names: the litellm.my-proxy.com proxy uses provider-prefixed names,
// so the model is called "openai/gpt-4o-mini-tts", not "gpt-4o-mini-tts".
const TARGETS = [
  {
    label: 'proxy/openai/gpt-4o-mini-tts (opus)',
    baseURL: config.llm.baseURL || '',
    apiKey: config.llm.apiKey,
    model: 'openai/gpt-4o-mini-tts',
    voice: 'ash',
    format: 'opus', // Telegram sendVoice expects OGG/OPUS — this is the exact format we test
  },
  {
    label: 'proxy/openai/gpt-4o-mini-tts (mp3)',
    baseURL: config.llm.baseURL || '',
    apiKey: config.llm.apiKey,
    model: 'openai/gpt-4o-mini-tts',
    voice: 'ash',
    format: 'mp3', // fallback format in case the proxy does not support opus
  },
  {
    label: 'proxy/openai/tts-1 (opus)',
    baseURL: config.llm.baseURL || '',
    apiKey: config.llm.apiKey,
    model: 'openai/tts-1',
    voice: 'ash',
    format: 'opus',
  },
];

// One synthesis call directly over HTTP (no SDK), so we see the raw proxy response and error codes exactly.
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
  console.log(`Text to synthesize: "${DEFAULT_TEXT}"`);
  console.log(`Output directory: ${OUT_DIR}\n`);

  for (const target of TARGETS) {
    if (!target.apiKey) {
      console.log(`[${target.label}] skipped: no API key configured.`);
      continue;
    }
    try {
      const { elapsedMs, buf, contentType } = await synthesize(target, DEFAULT_TEXT);
      const ext = target.format === 'opus' ? 'ogg' : target.format;
      const outPath = path.join(OUT_DIR, `${target.label.replace(/[^\w.-]+/g, '_')}.${ext}`);
      await writeFile(outPath, buf);
      console.log(
        `[${target.label}] SUCCESS in ${elapsedMs} ms: received ${buf.length} bytes ` +
          `(content type "${contentType}"), saved to ${outPath}.`,
      );
    } catch (err) {
      const cause = err.cause ? ` (cause: ${err.cause.code || err.cause.message})` : '';
      console.log(`[${target.label}] ERROR: ${err.message}${cause}`);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error in the TTS experiment:', err);
  process.exit(1);
});
