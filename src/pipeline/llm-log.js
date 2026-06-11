// LLM request log emitter: a single write point with asynchronous batched flushing to the logs DB.
// Logging doesn't block the user's response and never crashes the main flow: any preparation or insertion
// error is swallowed inside. Records accumulate in a buffer; a background timer, once per
// config.llmLog.flushIntervalMs, takes a batch and writes it to log.llm_request (in the SEPARATE logs
// database, see src/db.js queryLog) with a single multi-row INSERT; a database trigger fills the narrow
// log.llm_usage table itself. On a graceful shutdown flushLlmLog() drains the rest of the buffer.
// The buffering machinery is shared with the agent event journal — see src/pipeline/log-writer.js.
import { config } from '../config.js';
import { getLlmContext } from './llm-context.js';
import { priceUsd } from './llm-pricing.js';
import { createBatchWriter, truncateJson } from './log-writer.js';

// Dictionary of request kinds (request_kind). The single place where a new kind is added. For endpoints
// with a strictly single purpose (embeddings, speech recognition and synthesis) the kind is inferred from
// the endpoint. For chat.completions the kind MUST be passed by the calling code explicitly: this endpoint
// has many different purposes, so there's no guessed default value for it.
export const REQUEST_KINDS = Object.freeze({
  MAIN_AGENT_ANSWER: 'main_agent_answer',
  DELIVERY_INTENT: 'delivery_intent',
  INTENT_CLASSIFY: 'intent_classify',
  FACT_EXTRACT: 'fact_extract',
  // Саммари ответа ассистента (хранится в metadata сообщения; контекст извлечения фактов).
  ANSWER_SUMMARY: 'answer_summary',
  TOPIC_EXTRACT: 'topic_extract',
  EVENT_RELEVANCE: 'event_relevance',
  PROACTIVE_MESSAGE: 'proactive_message',
  HISTORY_COMPRESS: 'history_compress',
  SKILL_AUTHORING: 'skill_authoring',
  VOICE_SUMMARY: 'voice_summary',
  EMBEDDING: 'embedding',
  STT: 'stt',
  TTS: 'tts',
  // AI analysis of a logged request from the admin log viewer (POST /api/llm-log/analyze).
  LOG_ANALYSIS: 'log_analysis',
  // Fallback marker: the request kind wasn't passed. This signals a bug in the calling code — every
  // chat.completions call must specify kind. Records with this kind in the log expose "illegal" calls.
  UNTYPED: 'untyped',
});

// Default display format of the RESPONSE CONTENT of each request kind in the admin log viewer
// (the "Ответ ← LLM" row; the request payload is always rendered by PayloadView). The format is a property
// of the kind and lives next to the kind dictionary — the single source of truth on the server.
// 'JSON' | 'RAW' | 'MD' | 'HTML' | null; null = frontend auto-detection (kinds with variable content).
export const REQUEST_KIND_DISPLAY = Object.freeze({
  // Strictly structured chatJSON responses.
  intent_classify: 'JSON',
  delivery_intent: 'JSON',
  fact_extract: 'JSON',
  topic_extract: 'JSON',
  event_relevance: 'JSON',
  history_compress: 'JSON',
  answer_summary: 'JSON',
  voice_summary: 'JSON',
  // Service/binary metadata.
  embedding: 'JSON',
  tts: 'JSON',
  // Recognized speech is plain text.
  stt: 'RAW',
  // The analysis is rendered as Markdown (as AnalyzeDialog already does).
  log_analysis: 'MD',
  // Variable content (channel HTML / MD / plain) — auto-detection.
  main_agent_answer: null,
  proactive_message: null,
  skill_authoring: null,
  untyped: null,
});

// Default request kind by endpoint. Deliberately does NOT include chat.completions: for it a missing
// kind is treated as an error and marked REQUEST_KINDS.UNTYPED, rather than substituted with a plausible value.
const DEFAULT_KIND_BY_ENDPOINT = {
  embeddings: REQUEST_KINDS.EMBEDDING,
  'audio.transcriptions': REQUEST_KINDS.STT,
  'audio.speech': REQUEST_KINDS.TTS,
};

// Columns of the full log in insertion order. payload, response and binary_meta are jsonb.
// created_at is set explicitly at record-build time (not by the DB default): records are flushed in batches
// up to a second later, and the whole batch would otherwise share one insertion timestamp — the admin log
// viewer needs real call times to order the cycle timeline.
export const COLUMNS = [
  'created_at',
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
  'response',
  'binary_meta',
  'payload_truncated',
  'response_truncated',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'price_usd',
  'duration_ms',
  'status',
  'error',
  'is_test',
];

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

const writer = createBatchWriter({
  table: 'log.llm_request',
  columns: COLUMNS,
  jsonbColumns: ['payload', 'response', 'binary_meta'],
  getSettings: llmLogConfig,
});

// Swap the database write function (tests only). Returns the previous implementation so it can be restored.
export function __setDbQueryForTests(fn) {
  return writer.setDbQueryForTests(fn);
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

// Build a single log record from the input data and the correlation context. Returns a flat object matching
// the log.llm_request columns (payload/response/binary_meta are already JSON strings). Never throws: on
// failure returns null.
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

    const { json: payloadJson, truncated: payloadTruncated } = truncateJson(input.payload, cfg.maxPayloadChars);
    const { json: responseJson, truncated: responseTruncated } = truncateJson(input.response, cfg.maxPayloadChars);
    const binaryMetaJson = input.binaryMeta ? JSON.stringify(input.binaryMeta) : null;
    const provider = input.provider || providerFromBaseURL(input.baseURL ?? config.llm.baseURL);

    return {
      created_at: new Date().toISOString(),
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
      response: responseJson,
      binary_meta: binaryMetaJson,
      payload_truncated: payloadTruncated,
      response_truncated: responseTruncated,
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
    writer.push(record);
  } catch {
    // Logging must not affect the main response — we swallow any failures.
  }
}

// Force-flush the accumulated records (graceful shutdown, tests).
export async function flushLlmLog() {
  await writer.flush();
}
