// Эмиттер журнала LLM-запросов: единая точка записи с асинхронной пакетной выгрузкой в БД.
// Логирование не блокирует ответ пользователю и никогда не роняет основной поток: любая ошибка подготовки
// или вставки гасится внутри. Записи копятся в буфере, фоновый таймер раз в config.llmLog.flushIntervalMs
// забирает пакет и одним многострочным INSERT пишет его в log.llm_request; триггер БД сам заполняет
// узкую таблицу log.llm_usage. При штатной остановке flushLlmLog() сливает остаток буфера.
import { config } from '../config.js';
import { query } from '../db.js';
import { getLlmContext } from './llm-context.js';
import { priceUsd } from './llm-pricing.js';

// Словарь типов запросов (request_kind). Единственное место, куда добавляется новый тип. Для конечных
// точек со строго одним назначением (эмбеддинги, распознавание и синтез речи) тип выводится по конечной
// точке. Для chat.completions тип ОБЯЗАН передаваться вызывающим кодом явно: у этой конечной точки много
// разных назначений, поэтому угаданного значения по умолчанию для неё нет.
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
  // Запасной маркер: тип запроса не был передан. Это сигнал об ошибке вызывающего кода — каждый вызов
  // chat.completions обязан указывать kind. Записи с этим типом в журнале выдают «нелегальные» вызовы.
  UNTYPED: 'untyped',
});

// Тип запроса по умолчанию для конечной точки. Намеренно НЕ содержит chat.completions: для неё пропуск
// kind считается ошибкой и помечается REQUEST_KINDS.UNTYPED, а не подменяется правдоподобным значением.
const DEFAULT_KIND_BY_ENDPOINT = {
  embeddings: REQUEST_KINDS.EMBEDDING,
  'audio.transcriptions': REQUEST_KINDS.STT,
  'audio.speech': REQUEST_KINDS.TTS,
};

// Функция записи в БД. По умолчанию — общая обёртка query() из src/db.js; в модульных тестах подменяется
// через __setDbQueryForTests, чтобы проверять буферизацию и выгрузку без реальной базы.
let dbQuery = query;

// Подменить функцию записи в БД (только для тестов). Возвращает прежнюю реализацию, чтобы её можно было вернуть.
export function __setDbQueryForTests(fn) {
  const prev = dbQuery;
  dbQuery = fn || query;
  return prev;
}

// Колонки полного журнала в порядке вставки. Индексы payload и binary_meta помечены как jsonb.
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

// Внутренний буфер подготовленных записей и состояние фоновой выгрузки.
const buffer = [];
let flushTimer = null;
let flushing = false;
// Жёсткий потолок размера буфера: при недоступной БД он не должен расти бесконечно. Сверх потолка
// отбрасываем самые старые записи с предупреждением (явное усечение, без тихой потери).
const MAX_BUFFER = 5000;
// Порог досрочной выгрузки: как только в буфере накопилось столько записей, выгружаем не дожидаясь таймера.
const EARLY_FLUSH_AT = 50;

// Текущие настройки логирования (с разумными значениями по умолчанию, если секция llmLog отсутствует).
function llmLogConfig() {
  const c = config.llmLog || {};
  return {
    enabled: c.enabled !== false,
    batchSize: Number(c.batchSize) > 0 ? Number(c.batchSize) : 200,
    flushIntervalMs: Number(c.flushIntervalMs) > 0 ? Number(c.flushIntervalMs) : 1000,
    maxPayloadChars: Number(c.maxPayloadChars) > 0 ? Number(c.maxPayloadChars) : 100000,
  };
}

// Признак прогона тестов: записи помечаются is_test, чтобы их можно было подчистить после прогона.
function isTestRun() {
  return process.env.NODE_ENV === 'test';
}

// Вывести провайдера из базового URL: groq → 'groq', пустой/api.openai.com → 'openai', иначе 'proxy'.
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

// Усечь payload до предельного размера: длинные строковые значения внутри обрезаются, флаг truncated
// поднимается. Возвращает строку JSON, готовую для вставки в колонку jsonb, и признак усечения.
function buildPayloadJson(payload, maxChars) {
  if (payload === null || payload === undefined) {
    return { json: null, truncated: false };
  }
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return { json: JSON.stringify({ error: 'payload не сериализуется' }), truncated: true };
  }
  if (serialized.length <= maxChars) {
    return { json: serialized, truncated: false };
  }
  // Рекурсивно обрезаем длинные строки (тексты сообщений, input эмбеддинга) до разумной длины.
  const perString = 2000;
  const trunc = (v) => {
    if (typeof v === 'string') {
      return v.length > perString ? `${v.slice(0, perString)}…[+${v.length - perString} симв.]` : v;
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
    // Крайний случай: даже после обрезки строк объект велик — сохраняем усечённый снимок строкой.
    reduced = JSON.stringify({ _truncated: reduced.slice(0, maxChars) });
  }
  return { json: reduced, truncated: true };
}

// Собрать одну запись журнала из входных данных и контекста корреляции. Возвращает плоский объект под
// колонки log.llm_request (payload/binary_meta — уже строки JSON). Никогда не бросает: при сбое вернёт null.
export function buildRecord(input) {
  try {
    const cfg = llmLogConfig();
    const ctx = getLlmContext();
    const endpoint = input.endpoint || null;
    let kind = input.kind || ctx.kind || (endpoint ? DEFAULT_KIND_BY_ENDPOINT[endpoint] : null) || null;
    if (!kind) {
      // Тип не передан и не выводится по конечной точке (для chat.completions это всегда так). Помечаем
      // запись как «нелегальную» отдельным типом и шумим в лог, чтобы пропущенный kind было видно.
      kind = REQUEST_KINDS.UNTYPED;
      const where = endpoint || 'неизвестной конечной точки';
      console.warn(
        `[llm-log] Вызов ${where} без request_kind — запись помечена «${REQUEST_KINDS.UNTYPED}». Каждый вызов обязан передавать kind.`,
      );
    }

    const promptTokens = input.promptTokens ?? null;
    const completionTokens = input.completionTokens ?? null;
    const totalTokens =
      input.totalTokens ??
      (promptTokens != null || completionTokens != null ? (promptTokens || 0) + (completionTokens || 0) : null);

    // Стоимость рассчитываем только при наличии токенов. Для эмбеддингов считаем по total как по входящим.
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

// Положить запись в буфер. Возвращает управление немедленно (ничего не ждёт) и никогда не бросает.
// input — объект для buildRecord; если передан уже собранный record (с полем request_kind), кладём его как есть.
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
      console.warn(`[llm-log] Буфер переполнен: отброшено ${dropped} самых старых записей журнала.`);
    }
    ensureTimer();
    if (buffer.length >= EARLY_FLUSH_AT) {
      flushLlmLog().catch(() => {});
    }
  } catch {
    // Логирование не должно влиять на основной ответ — глушим любые сбои.
  }
}

// Запустить фоновый таймер выгрузки, если он ещё не запущен. unref(), чтобы таймер не удерживал процесс.
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

// Выполнить один многострочный INSERT для пакета записей.
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

// Принудительно выгрузить накопленные записи. Берёт из буфера пакеты до batchSize и пишет их по очереди.
// При ошибке вставки возвращает записи пакета обратно в начало буфера (с учётом потолка) и прекращает
// текущий проход — следующая попытка случится по таймеру или при следующем вызове.
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
        // Возвращаем неудавшийся пакет в начало буфера, чтобы не потерять записи при временной недоступности БД.
        buffer.unshift(...batch);
        if (buffer.length > MAX_BUFFER) {
          buffer.splice(MAX_BUFFER);
        }
        console.warn(`[llm-log] Не удалось записать журнал (${batch.length} зап.): ${String(err.message || err)}`);
        break;
      }
    }
  } finally {
    flushing = false;
  }
}

