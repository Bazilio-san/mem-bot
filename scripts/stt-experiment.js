// Experimental speech recognition module (speech to text, STT).
// Purpose: take one finished audio or video file as input (as Telegram sends it —
// a voice message in OGG/OPUS format, a video note in MP4 format, an audio file or a video file)
// and run it through several cloud recognizers, measuring time and showing the result.
//
// Models under test:
//   AssemblyAI  : universal-2          (pre-recorded file transcription, Russian supported)
//   OpenAI      : gpt-4o-transcribe, gpt-4o-mini-transcribe   (via the litellm.my-proxy.com proxy)
//   Groq        : whisper-large-v3, whisper-large-v3-turbo    (directly via api.groq.com)
//
// Run: node scripts/stt-experiment.js path/to/file [language_code]
//   language_code is optional (defaults to "ru"). Affects OpenAI and Groq; for AssemblyAI automatic
//   language detection is enabled.
//
// Important observation: all the listed services accept compressed formats (ogg/opus, mp3, mp4, m4a, wav,
// webm) directly, so the external ffmpeg utility is NOT required for the pre-recorded file path.
// ffmpeg is only needed for streaming whisper-rt, which takes raw PCM as input.
import { config } from '../src/config.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const FILE = process.argv[2];
const LANG = process.argv[3] || 'ru';

if (!FILE) {
  console.error('Provide a path to an audio or video file: node scripts/stt-experiment.js path/to/file [language_code]');
  process.exit(1);
}

const OPENAI_BASE = (config.llm.baseURL || '').replace(/\/$/, '');
const GROQ_BASE = (config.providers.groqBaseURL || 'https://api.groq.com/openai/v1').replace(/\/$/, '');
const AAI_BASE = 'https://api.assemblyai.com';

// Guess the MIME type by extension to label the file correctly in the multipart request.
function guessMime(file) {
  const ext = path.extname(file).toLowerCase();
  const map = {
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.opus': 'audio/ogg',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.webm': 'audio/webm',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
  };
  return map[ext] || 'application/octet-stream';
}

// --- Transcription via the OpenAI-compatible interface (works for both the proxy and Groq) ------------
async function transcribeOpenAICompatible({ baseURL, apiKey, model, fileBuf, fileName, language }) {
  const form = new FormData();
  form.append('file', new Blob([fileBuf], { type: guessMime(fileName) }), path.basename(fileName));
  form.append('model', model);
  if (language) {
    form.append('language', language);
  }
  form.append('response_format', 'json');

  // The proxy occasionally drops the connection on a timeout (UND_ERR_CONNECT_TIMEOUT) — retry a few times.
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
      if (attempt < 3) {
        process.stdout.write(`retry ${attempt}${cause}… `);
      }
    }
  }
  throw lastErr;
}

// --- Transcription via AssemblyAI (file upload, job creation, polling for completion) -----------------
async function transcribeAssemblyAI({ apiKey, fileBuf, language }) {
  const started = Date.now();

  // Step 1: upload the file. AssemblyAI's authorization header is the key itself, no Bearer prefix.
  const up = await fetch(`${AAI_BASE}/v2/upload`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/octet-stream' },
    body: fileBuf,
  });
  if (!up.ok) {
    throw new Error(`upload HTTP ${up.status}: ${(await up.text()).slice(0, 200)}`);
  }
  const { upload_url: uploadUrl } = await up.json();

  // Step 2: create the transcription job. The universal-2 model supports 99 languages, including Russian.
  // The speech_model parameter is deprecated; the current interface takes a priority list speech_models.
  // We use universal-2 because universal-3-pro does not support Russian.
  // Language auto-detection is enabled; the language code is passed as a hint via language_code if set.
  const body = { audio_url: uploadUrl, speech_models: ['universal-2'] };
  if (language) {
    body.language_code = language;
  } else {
    body.language_detection = true;
  }
  const cr = await fetch(`${AAI_BASE}/v2/transcript`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!cr.ok) {
    throw new Error(`create HTTP ${cr.status}: ${(await cr.text()).slice(0, 300)}`);
  }
  const created = await cr.json();

  // Step 3: poll once a second until the status becomes completed or error.
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const pr = await fetch(`${AAI_BASE}/v2/transcript/${created.id}`, { headers: { Authorization: apiKey } });
    if (!pr.ok) {
      throw new Error(`poll HTTP ${pr.status}: ${(await pr.text()).slice(0, 200)}`);
    }
    const t = await pr.json();
    if (t.status === 'completed') {
      return { elapsedMs: Date.now() - started, text: t.text };
    }
    if (t.status === 'error') {
      throw new Error(`transcription failed: ${t.error}`);
    }
  }
}

// --- List of recognizers under test -------------------------------------------------------------------
function buildTargets() {
  const targets = [];
  if (config.providers.assemblyaiApiKey) {
    targets.push({
      label: 'AssemblyAI/universal-2',
      run: (fileBuf) => transcribeAssemblyAI({ apiKey: config.providers.assemblyaiApiKey, fileBuf, language: LANG }),
    });
  }
  if (config.llm.apiKey) {
    for (const model of ['openai/gpt-4o-transcribe', 'openai/gpt-4o-mini-transcribe']) {
      targets.push({
        label: `proxy/${model}`,
        run: (fileBuf, fileName) =>
          transcribeOpenAICompatible({
            baseURL: OPENAI_BASE,
            apiKey: config.llm.apiKey,
            model,
            fileBuf,
            fileName,
            language: LANG,
          }),
      });
    }
  }
  if (config.providers.groqApiKey) {
    for (const model of ['whisper-large-v3', 'whisper-large-v3-turbo']) {
      targets.push({
        label: `groq/${model}`,
        run: (fileBuf, fileName) =>
          transcribeOpenAICompatible({
            baseURL: GROQ_BASE,
            apiKey: config.providers.groqApiKey,
            model,
            fileBuf,
            fileName,
            language: LANG,
          }),
      });
    }
  }
  return targets;
}

async function main() {
  const fileBuf = await readFile(FILE);
  const sizeKb = (fileBuf.length / 1024).toFixed(1);
  console.log(`File: ${FILE} (${sizeKb} KB, type "${guessMime(FILE)}"), language hint: ${LANG}\n`);

  const targets = buildTargets();
  const summary = [];
  // Run the recognizers one by one (not in parallel) so the time measurements do not affect each other
  // through the shared network channel and proxy limits.
  for (const target of targets) {
    process.stdout.write(`[${target.label}] transcribing… `);
    try {
      const { elapsedMs, text } = await target.run(fileBuf, FILE);
      console.log(`done in ${elapsedMs} ms`);
      console.log(`   text: ${text}\n`);
      summary.push({ label: target.label, ms: elapsedMs, ok: true, text });
    } catch (err) {
      console.log(`ERROR: ${err.message}\n`);
      summary.push({ label: target.label, ms: null, ok: false, text: err.message });
    }
  }

  console.log('================ Summary ================');
  for (const s of summary) {
    const time = s.ok ? `${String(s.ms).padStart(6)} ms` : '   —    ';
    console.log(`${s.label.padEnd(34)} ${s.ok ? 'OK ' : 'ERR'} ${time}`);
  }
}

main().catch((err) => {
  console.error('Fatal error in the STT experiment:', err);
  process.exit(1);
});
