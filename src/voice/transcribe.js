// Recognition of incoming audio from Telegram (speech to text, STT) in pre-recorded file mode.
// The module turns a Telegram attachment (voice message, video note, sent audio or video file) into a text
// string. Internally: detect the attachment type, check limits, download the file to the bot side, pick a
// recognizer based on configuration, and perform the recognition call itself. The Telegram adapter knows
// nothing about the details — it just calls this module's functions and gets text that then flows into the
// regular agent pipeline.
//
// Recognition is done with a single HTTP request to a cloud service: the external ffmpeg utility is not
// needed, all supported services accept Telegram's compressed formats (OGG/OPUS, MP4, M4A, WebM) directly.
// The working adapter implementations were carried over from the test script scripts/stt-experiment.js
// almost unchanged.
import path from 'node:path';
import { config } from '../config.js';
import { logLlmRequest } from '../pipeline/llm-log.js';

const OPENAI_COMPATIBLE = 'openai-compatible';
const ASSEMBLYAI = 'assemblyai';
const AAI_BASE = 'https://api.assemblyai.com';

// The recognizer registry keeps environment variable names (keyEnv/baseEnv) as a historical label for
// diagnostic messages. The values themselves are read only through config — there is no direct process.env
// here. These tables map a variable name to the location of its value in the configuration tree.
const KEY_RESOLVERS = {
  GROQ_API_KEY: () => config.providers.groqApiKey,
  ASSEMBLYAI_API_KEY: () => config.providers.assemblyaiApiKey,
  OPENAI_API_KEY: () => config.llm.apiKey,
};
const BASE_RESOLVERS = {
  GROQ_BASE_URL: () => config.providers.groqBaseURL,
  OPENAI_BASE_URL: () => config.llm.baseURL,
};

// Access key value for a recognizer by its environment variable name (or undefined if absent).
function resolveProviderKey(envName) {
  const resolver = KEY_RESOLVERS[envName];
  return resolver ? resolver() : undefined;
}

// Base URL for a recognizer by its environment variable name (or undefined if not set).
function resolveProviderBase(envName) {
  const resolver = BASE_RESOLVERS[envName];
  return resolver ? resolver() : undefined;
}

// Registry of supported recognizers. The VOICE_INPUT_PROVIDER environment variable value selects an entry.
// The openai-compatible group uses a single audio/transcriptions interface (Groq and LiteLLM proxy), so
// adding a new option is a single registry entry rather than a separate integration.
export const VOICE_PROVIDERS = {
  'groq-whisper-large-v3-turbo': {
    type: OPENAI_COMPATIBLE,
    keyEnv: 'GROQ_API_KEY',
    baseEnv: 'GROQ_BASE_URL',
    defaultBase: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
  },
  'groq-whisper-large-v3': {
    type: OPENAI_COMPATIBLE,
    keyEnv: 'GROQ_API_KEY',
    baseEnv: 'GROQ_BASE_URL',
    defaultBase: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3',
  },
  'assemblyai-universal-2': {
    type: ASSEMBLYAI,
    keyEnv: 'ASSEMBLYAI_API_KEY',
  },
  'openai-gpt-4o-transcribe': {
    type: OPENAI_COMPATIBLE,
    keyEnv: 'OPENAI_API_KEY',
    baseEnv: 'OPENAI_BASE_URL',
    model: 'openai/gpt-4o-transcribe',
  },
  'openai-gpt-4o-mini-transcribe': {
    type: OPENAI_COMPATIBLE,
    keyEnv: 'OPENAI_API_KEY',
    baseEnv: 'OPENAI_BASE_URL',
    model: 'openai/gpt-4o-mini-transcribe',
  },
};

// Attachment kinds for which the recognized text is shown to the user before the reply: sent files.
// For live voice interaction (voice message, video note) we don't echo — we reply straight to the point.
const ECHO_KINDS = new Set(['audio', 'video', 'document']);

// Environment variable name holding the access key for the chosen recognizer (or null if name is unknown).
export function providerKeyEnv(provider) {
  return VOICE_PROVIDERS[provider]?.keyEnv || null;
}

// Whether the recognizer is ready: the recognizer is known and its access key is set in the environment.
export function isProviderConfigured(provider) {
  const spec = VOICE_PROVIDERS[provider];
  if (!spec) {
    return false;
  }
  return Boolean(resolveProviderKey(spec.keyEnv));
}

// Whether to treat the attachment kind as a "sent file" for which we show the recognized text to the user.
export function shouldEchoTranscript(kind) {
  return ECHO_KINDS.has(kind);
}

// Detect the attachment kind and assemble its description from Telegram message fields.
// Returns a speech attachment description or null if there is no supported attachment in the message.
// For a document we take only audio and video MIME types, ignoring other documents.
export function detectAttachment(message) {
  if (!message) {
    return null;
  }
  if (message.voice) {
    const v = message.voice;
    return {
      kind: 'voice',
      fileId: v.file_id,
      fileName: null,
      mimeType: v.mime_type || 'audio/ogg',
      durationSeconds: v.duration || 0,
      fileSize: v.file_size || 0,
    };
  }
  if (message.video_note) {
    const v = message.video_note;
    return {
      kind: 'video_note',
      fileId: v.file_id,
      fileName: null,
      mimeType: 'video/mp4',
      durationSeconds: v.duration || 0,
      fileSize: v.file_size || 0,
    };
  }
  if (message.audio) {
    const a = message.audio;
    return {
      kind: 'audio',
      fileId: a.file_id,
      fileName: a.file_name || null,
      mimeType: a.mime_type || 'audio/mpeg',
      durationSeconds: a.duration || 0,
      fileSize: a.file_size || 0,
    };
  }
  if (message.video) {
    const v = message.video;
    return {
      kind: 'video',
      fileId: v.file_id,
      fileName: v.file_name || null,
      mimeType: v.mime_type || 'video/mp4',
      durationSeconds: v.duration || 0,
      fileSize: v.file_size || 0,
    };
  }
  if (message.document) {
    const d = message.document;
    const mime = d.mime_type || '';
    if (mime.startsWith('audio/') || mime.startsWith('video/')) {
      return {
        kind: 'document',
        fileId: d.file_id,
        fileName: d.file_name || null,
        mimeType: mime,
        durationSeconds: 0,
        fileSize: d.file_size || 0,
      };
    }
  }
  return null;
}

// Check attachment limits before downloading. If duration is known — compare it against the limit in seconds;
// if duration is unknown (a document, or the service did not send it) — compare file size against the limit
// in bytes. Returns { ok: true } or { ok: false, reason: 'too_long' | 'too_large' }.
export function checkAttachmentLimits(attachment, { maxSeconds, maxBytes }) {
  const duration = attachment.durationSeconds || 0;
  if (duration > 0 && duration > maxSeconds) {
    return { ok: false, reason: 'too_long' };
  }
  if (duration === 0 && attachment.fileSize > 0 && attachment.fileSize > maxBytes) {
    return { ok: false, reason: 'too_large' };
  }
  return { ok: true };
}

// Guess the MIME type from the file name extension to label the file correctly in a multipart request.
function guessMime(fileName) {
  const ext = path.extname(fileName || '').toLowerCase();
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

// OpenAI-compatible services (Groq) determine the file format by the extension in the name, not by the
// request MIME type. Telegram delivers a voice message as a file with the .oga extension, which is not in
// Groq's list of accepted formats even though by content it's ordinary OGG/OPUS. So we coerce the upload
// name to an extension from the allowed list: if the extension is already valid we keep it, otherwise we
// pick one by MIME type.
const ACCEPTED_UPLOAD_EXT = new Set(['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'opus', 'wav', 'webm']);

function safeUploadName(fileName) {
  const ext = path
    .extname(fileName || '')
    .slice(1)
    .toLowerCase();
  if (ACCEPTED_UPLOAD_EXT.has(ext)) {
    return path.basename(fileName);
  }
  const mimeToExt = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'audio/flac': 'flac',
    'audio/webm': 'webm',
    'video/mp4': 'mp4',
  };
  const target = mimeToExt[guessMime(fileName)] || 'ogg';
  const base = path.basename(fileName || 'audio', path.extname(fileName || '')) || 'audio';
  return `${base}.${target}`;
}

// Download a Telegram file by file_id into process memory. First the getFile method gives us the relative
// path to the file on Telegram's servers, then we download it by its file address. We don't hand the direct
// link outside: it contains the bot token, so we pass the bytes themselves to a third-party service, not a URL.
async function downloadTelegramFile({ telegramApiBase, botToken, fileId }) {
  const infoRes = await fetch(`${telegramApiBase}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  const info = await infoRes.json();
  if (!info.ok) {
    throw new Error(`getFile: ${info.description || infoRes.status}`);
  }
  const filePath = info.result.file_path;

  // Build the file address from the base API address by replacing "/bot<token>" with "/file/bot<token>".
  // This preserves the host (including a local Bot API server), and the token stays inside the process.
  const fileBase = telegramApiBase.replace(/\/bot[^/]+$/, `/file/bot${botToken}`);
  const fileRes = await fetch(`${fileBase}/${filePath}`);
  if (!fileRes.ok) {
    throw new Error(`file download, HTTP response code ${fileRes.status}`);
  }
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, filePath };
}

// Recognition via the OpenAI-compatible audio/transcriptions interface (works for both Groq and the proxy).
// The proxy occasionally drops the connection on a timeout (waiting-time exceeded), so we make several retry
// attempts of the same request.
async function transcribeOpenAICompatible({ baseURL, apiKey, model, fileBuf, fileName, language }) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([fileBuf], { type: guessMime(fileName) }), safeUploadName(fileName));
      form.append('model', model);
      if (language) {
        form.append('language', language);
      }
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

// Recognition via AssemblyAI: file upload, job submission and readiness polling.
// The universal-2 model supports Russian. The speech_model parameter is deprecated; the current interface
// accepts a priority list speech_models. We pass the language code as a hint via language_code if it is set,
// otherwise we enable automatic language detection via language_detection.
async function transcribeAssemblyAI({ apiKey, fileBuf, language }) {
  // Step 1: file upload. AssemblyAI's authorization header is the key itself, without a Bearer prefix.
  const up = await fetch(`${AAI_BASE}/v2/upload`, {
    method: 'POST',
    headers: { Authorization: apiKey, 'Content-Type': 'application/octet-stream' },
    body: fileBuf,
  });
  if (!up.ok) {
    throw new Error(`upload HTTP ${up.status}: ${(await up.text()).slice(0, 200)}`);
  }
  const { upload_url: uploadUrl } = await up.json();

  // Step 2: submit the recognition job.
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

  // Step 3: poll for readiness once per second until the status becomes completed or error.
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const pr = await fetch(`${AAI_BASE}/v2/transcript/${created.id}`, { headers: { Authorization: apiKey } });
    if (!pr.ok) {
      throw new Error(`poll HTTP ${pr.status}: ${(await pr.text()).slice(0, 200)}`);
    }
    const t = await pr.json();
    if (t.status === 'completed') {
      return t.text || '';
    }
    if (t.status === 'error') {
      throw new Error(`recognition failed: ${t.error}`);
    }
  }
}

// Download a Telegram attachment and recognize it with the chosen recognizer. Returns the recognized text
// together with service info: an empty-result flag, duration, size and the recognizer name.
// The contract is explicit: the module receives the Telegram API base address and the bot token as arguments
// and does not read private details of the Telegram adapter.
export async function transcribeTelegramAttachment({ attachment, telegramApiBase, botToken, provider, language }) {
  const spec = VOICE_PROVIDERS[provider];
  if (!spec) {
    throw new Error(`Unknown speech recognizer: ${provider}`);
  }
  const apiKey = resolveProviderKey(spec.keyEnv);
  if (!apiKey) {
    throw new Error(`Key ${spec.keyEnv} is not set for recognizer ${provider}`);
  }

  const { buffer, filePath } = await downloadTelegramFile({
    telegramApiBase,
    botToken,
    fileId: attachment.fileId,
  });
  const fileName = attachment.fileName || (filePath ? filePath.split('/').pop() : 'audio');

  // Recognizer info for the log. The model name and provider depend on the recognizer type.
  const isAssembly = spec.type === ASSEMBLYAI;
  const logModel = isAssembly ? 'universal-2' : spec.model;
  const logProvider = isAssembly ? 'assemblyai' : spec.keyEnv === 'GROQ_API_KEY' ? 'groq' : 'openai';
  // Binary-request log: the file content and recognized text are not stored — only the file metadata in
  // binary_meta and the non-text request parameters in payload (the recognized text is user data and ends
  // up in the regular message history anyway).
  const binaryMeta = {
    kind: attachment.kind,
    mimeType: attachment.mimeType,
    fileName,
    fileSize: attachment.fileSize,
    durationSeconds: attachment.durationSeconds,
  };
  const logPayload = { model: logModel, language: language || null, response_format: 'json' };
  const startedAt = Date.now();

  let text;
  try {
    if (isAssembly) {
      text = await transcribeAssemblyAI({ apiKey, fileBuf: buffer, language });
    } else {
      const baseURL = (resolveProviderBase(spec.baseEnv) || spec.defaultBase || '').replace(/\/$/, '') || undefined;
      text = await transcribeOpenAICompatible({
        baseURL,
        apiKey,
        model: spec.model,
        fileBuf: buffer,
        fileName,
        language,
      });
    }
  } catch (err) {
    try {
      logLlmRequest({
        endpoint: 'audio.transcriptions',
        kind: 'stt',
        model: logModel,
        provider: logProvider,
        isBinary: true,
        payload: logPayload,
        binaryMeta,
        durationMs: Date.now() - startedAt,
        status: 'error',
        error: err?.message || err,
      });
    } catch {
      // logging must not affect recognition
    }
    throw err;
  }
  const clean = (text || '').trim();
  try {
    logLlmRequest({
      endpoint: 'audio.transcriptions',
      kind: 'stt',
      model: logModel,
      provider: logProvider,
      isBinary: true,
      payload: logPayload,
      // The recognized text is the response of this call — the log viewer shows it in the "← LLM" row.
      response: { text: clean },
      binaryMeta,
      durationMs: Date.now() - startedAt,
    });
  } catch {
    // logging must not affect recognition
  }

  return {
    text: clean,
    empty: clean.length === 0,
    durationSeconds: attachment.durationSeconds,
    fileSize: attachment.fileSize,
    provider,
  };
}
