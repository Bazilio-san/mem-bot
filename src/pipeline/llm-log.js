// LLM request log emitter: a single write point with asynchronous batched flushing to the database.
// Logging doesn't block the user's response and never crashes the main flow: any preparation or insertion
// error is swallowed inside. Records accumulate in a buffer; a background timer, once per
// config.llmLog.flushIntervalMs, takes a batch and writes it to log.llm_request with a single multi-row
// INSERT; a database trigger fills the narrow log.llm_usage table itself. On a graceful shutdown
// flushLlmLog() drains the rest of the buffer.
import { config } from '../config.js';
import { query } from '../db.js';
import { getLlmContext } from './llm-context.js';
import { priceUsd } from './llm-pricing.js';

// Dictionary of request kinds (request_kind). The single place where a new kind is added. For endpoints
// with a strictly single purpose (embeddings, speech recognition and synthesis) the kind is inferred from
// the endpoint. For chat.completions the kind MUST be passed by the calling code explicitly: this endpoint
// has many different purposes, so there's no guessed default value for it.
export const REQUEST_KINDS = Object.freeze({
  MAIN_AGENT_ANSWER: 'main_agent_answer',
  DELIVERY_INTENT: 'delivery_intent',
  INTENT_CLASSIFY: 'intent_classify',
  FACT_EXTRACT: 'fact_extract',
  TOPIC_EXTRACT: 'topic_extract',
  EVENT_RELEVANCE: 'event_relevance',
  PROACTIVE_MESSAGE: 'proactive_message',
  HISTORY_COMPRESS: 'history_compress',
  SKILL_AUTHORING: 'skill_authoring',
  VOICE_SUMMARY: 'voice_summary',
  EMBEDDING: 'embedding',
  STT: 'stt',
  TTS: 'tts',
  // Fallback marker: the request kind wasn't passed. This signals a bug in the calling code — every
  // chat.completions call must specify kind. Records with this kind in the log expose "illegal" calls.
  UNTYPED: 'untyped',
});

// Default request kind by endpoint. Deliberately does NOT include chat.completions: for it a missing
// kind is treated as an error and marked REQUEST_KINDS.UNTYPED, rather than substituted with a plausible value.
const DEFAULT_KIND_BY_ENDPOINT = {
  embeddings: REQUEST_KINDS.EMBEDDING,
  'audio.transcriptions': REQUEST_KINDS.STT,
  'audio.speech': REQUEST_KINDS.TTS,
};

// The database write function. By default it's the shared query() wrapper from src/db.js; in unit tests it's
// swapped via __setDbQueryForTests to verify buffering and flushing without a real database.
let dbQuery = query;

// Swap the database write function (tests only). Returns the previous implementation so it can be restored.
export function __setDbQueryForTests(fn) {
  const prev = dbQuery;
  dbQuery = fn || query;
  return prev;
}

// Columns of the full log in insertion order. The payload and binary_meta indexes are marked as jsonb.
export const COLUMNS = [
  'request_id',
  'request_kind',
  'endpoint',
  'provider',
  'model',
  'model_priced',
  'user_id',
  'conversation_id',
  'domain_key',
  'channel',
  'is_binary',
  'payload',
  'binary_meta',
  'payload_truncated',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'price_usd',
  'duration_ms',
  'status',
  'error',
  'is_test',
];
const JSONB_INDEXES = new Set([COLUMNS.indexOf('payload'), COLUMNS.indexOf('binary_meta')]);

// Internal buffer of prepared records and the background flush state.
const buffer = [];
let flushTimer = null;
let flushing = false;
// Hard cap on the buffer size: with the database unavailable it must not grow without bound. Above the cap
// we drop the oldest records with a warning (explicit truncation, no silent loss).
const MAX_BUFFER = 5000;
// Early flush threshold: as soon as this many records have accumulated in the buffer, we flush without waiting for the timer.
const EARLY_FLUSH_AT = 50;

// Current logging settings (with sensible defaults if the llmLog section is absent).
function llmLogConfig() {
  const c = config.llmLog || {};
  return {
    enabled: c.enabled !== false,
    batchSize: Number(c.batchSize) > 0 ? Number(c.batchSize) : 200,
    flushIntervalMs: Number(c.flushIntervalMs) > 0 ? Number(c.flushIntervalMs) : 1000,
    maxPayloadChars: Number(c.maxPayloadChars) > 0 ? Number(c.maxPayloadChars) : 100000,
  };
}

// Test-run flag: records are marked is_test so they can be cleaned up after the run.
function isTestRun() {
  return process.env.NODE_ENV === 'test';
}

// Infer the provider from the base URL: groq → 'groq', empty/api.openai.com → 'openai', otherwise 'proxy'.
function providerFromBaseURL(baseURL) {
  const url = String(baseURL || '').toLowerCase();
  if (!url || url.includes('api.openai.com')) {
    return 'openai';
  }
  if (url.includes('groq')) {
    return 'groq';
  }
  return 'proxy';
}

// Truncate the payload to the size limit: long string values inside are clipped and the truncated flag is
// raised. Returns a JSON string ready for insertion into the jsonb column, and a truncation flag.
function buildPayloadJson(payload, maxChars) {
  if (payload === null || payload === undefined) {
    return { json: null, truncated: false };
  }
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return { json: JSON.stringify({ error: 'payload is not serializable' }), truncated: true };
  }
  if (serialized.length <= maxChars) {
    return { json: serialized, truncated: false };
  }
  // Recursively clip long strings (message texts, embedding input) to a reasonable length.
  const perString = 2000;
  const trunc = (v) => {
    if (typeof v === 'string') {
      return v.length > perString ? `${v.slice(0, perString)}…[+${v.length - perString} chars]` : v;
    }
    if (Array.isArray(v)) {
      return v.map(trunc);
    }
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v)) {
        out[k] = trunc(v[k]);
      }
      return out;
    }
    return v;
  };
  let reduced = JSON.stringify(trunc(payload));
  if (reduced.length > maxChars) {
    // Edge case: even after clipping strings the object is large — store a truncated snapshot as a string.
    reduced = JSON.stringify({ _truncated: reduced.slice(0, maxChars) });
  }
  return { json: reduced, truncated: true };
}

// Build a single log record from the input data and the correlation context. Returns a flat object matching
// the log.llm_request columns (payload/binary_meta are already JSON strings). Never throws: on failure returns null.
export function buildRecord(input) {
  try {
    const cfg = llmLogConfig();
    const ctx = getLlmContext();
    const endpoint = input.endpoint || null;
    let kind = input.kind || ctx.kind || (endpoint ? DEFAULT_KIND_BY_ENDPOINT[endpoint] : null) || null;
    if (!kind) {
      // The kind wasn't passed and can't be inferred from the endpoint (for chat.completions this is always
      // the case). We mark the record as "illegal" with a dedicated kind and warn in the log so the missing
      // kind is visible.
      kind = REQUEST_KINDS.UNTYPED;
      const where = endpoint || 'an unknown endpoint';
      console.warn(
        `[llm-log] Call to ${where} without request_kind — record marked "${REQUEST_KINDS.UNTYPED}". Every call must pass kind.`,
      );
    }

    const promptTokens = input.promptTokens ?? null;
    const completionTokens = input.completionTokens ?? null;
    const totalTokens =
      input.totalTokens ??
      (promptTokens != null || completionTokens != null ? (promptTokens || 0) + (completionTokens || 0) : null);

    // Compute cost only when tokens are present. For embeddings we count by total as if they were input tokens.
    let price = { priceUsd: null, modelPriced: null };
    if (input.model && (promptTokens != null || completionTokens != null || totalTokens != null)) {
      if (endpoint === 'embeddings') {
        price = priceUsd({ model: input.model, promptTokens: totalTokens ?? promptTokens ?? 0 });
      } else {
        price = priceUsd({
          model: input.model,
          promptTokens: promptTokens ?? 0,
          completionTokens: completionTokens ?? 0,
          cachedTokens: input.cachedTokens ?? 0,
        });
      }
    }

    const { json: payloadJson, truncated } = buildPayloadJson(input.payload, cfg.maxPayloadChars);
    const binaryMetaJson = input.binaryMeta ? JSON.stringify(input.binaryMeta) : null;
    const provider = input.provider || providerFromBaseURL(input.baseURL ?? config.llm.baseURL);

    return {
      request_id: ctx.requestId ?? null,
      request_kind: kind,
      endpoint,
      provider,
      model: input.model ?? null,
      model_priced: price.modelPriced,
      user_id: ctx.userId != null ? String(ctx.userId) : null,
      conversation_id: ctx.conversationId != null ? String(ctx.conversationId) : null,
      domain_key: ctx.domainKey ?? null,
      channel: ctx.channel ?? null,
      is_binary: input.isBinary === true,
      payload: payloadJson,
      binary_meta: binaryMetaJson,
      payload_truncated: truncated,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      price_usd: price.priceUsd,
      duration_ms: input.durationMs ?? null,
      status: input.status || 'ok',
      error: input.error ? String(input.error).slice(0, 4000) : null,
      is_test: isTestRun(),
    };
  } catch {
    return null;
  }
}

// Put a record into the buffer. Returns control immediately (waits for nothing) and never throws.
// input is an object for buildRecord; if an already-built record (with a request_kind field) is passed, we store it as is.
export function logLlmRequest(input) {
  try {
    if (!llmLogConfig().enabled || !input) {
      return;
    }
    const record = input.__isRecord ? input : buildRecord(input);
    if (!record) {
      return;
    }
    buffer.push(record);
    if (buffer.length > MAX_BUFFER) {
      const dropped = buffer.length - MAX_BUFFER;
      buffer.splice(0, dropped);
      console.warn(`[llm-log] Buffer overflow: dropped ${dropped} oldest log records.`);
    }
    ensureTimer();
    if (buffer.length >= EARLY_FLUSH_AT) {
      flushLlmLog().catch(() => {});
    }
  } catch {
    // Logging must not affect the main response — we swallow any failures.
  }
}

// Start the background flush timer if it isn't running yet. unref() so the timer doesn't keep the process alive.
function ensureTimer() {
  if (flushTimer) {
    return;
  }
  const { flushIntervalMs } = llmLogConfig();
  flushTimer = setInterval(() => {
    flushLlmLog().catch(() => {});
  }, flushIntervalMs);
  if (typeof flushTimer.unref === 'function') {
    flushTimer.unref();
  }
}

// Perform a single multi-row INSERT for a batch of records.
async function insertBatch(records) {
  const values = [];
  const tuples = records.map((r) => {
    const placeholders = COLUMNS.map((col, i) => {
      values.push(r[col] ?? null);
      const pos = values.length;
      return JSONB_INDEXES.has(i) ? `$${pos}::jsonb` : `$${pos}`;
    });
    return `(${placeholders.join(',')})`;
  });
  const sql = `INSERT INTO log.llm_request (${COLUMNS.join(',')}) VALUES ${tuples.join(',')}`;
  await dbQuery(sql, values);
}

// Force-flush the accumulated records. Takes batches of up to batchSize from the buffer and writes them one by
// one. On an insertion error it returns the batch's records back to the front of the buffer (respecting the cap)
// and stops the current pass — the next attempt happens on the timer or on the next call.
export async function flushLlmLog() {
  if (flushing || buffer.length === 0) {
    return;
  }
  flushing = true;
  const { batchSize } = llmLogConfig();
  try {
    while (buffer.length > 0) {
      const batch = buffer.splice(0, batchSize);
      try {
        await insertBatch(batch);
      } catch (err) {
        // Return the failed batch to the front of the buffer so records aren't lost during a temporary DB outage.
        buffer.unshift(...batch);
        if (buffer.length > MAX_BUFFER) {
          buffer.splice(MAX_BUFFER);
        }
        console.warn(`[llm-log] Failed to write log (${batch.length} records): ${String(err.message || err)}`);
        break;
      }
    }
  } finally {
    flushing = false;
  }
}
