// Конфигурация приложения. Значения берутся из .env.
// Модели соответствуют рекомендациям архитектуры и проверены через LiteLLM-прокси
// скриптом tests/check-llm.js (все отвечают 5/5: чат, JSON, инструменты, эмбеддинги):
//   основной агент и извлечение фактов : gpt-5.4-mini
//   классификация запроса              : gpt-5.4-nano
//   эмбеддинги                         : text-embedding-3-small (1536 измерений)
// Любую модель можно переопределить переменными окружения MAIN_MODEL/AUX_MODEL/EXTRACT_MODEL/EMBED_MODEL.
// Замечание по скорости: на этом прокси gpt-5.4-* отвечают за ~5–10 с, а gpt-4o-mini — за ~1.2 с;
// если нужен максимально быстрый отклик, задайте MAIN_MODEL/AUX_MODEL/EXTRACT_MODEL=gpt-4o-mini.
import 'dotenv/config';

const env = process.env;

// Чтение булевых флагов из окружения. Включают значения 1/true/on/yes; всё прочее — выключено.
const flag = (v, d = false) =>
  v === undefined ? d : ['1', 'true', 'on', 'yes'].includes(String(v).trim().toLowerCase());

// Базовая БД, к которой подключаемся для создания целевой БД памяти.
const adminUrl = env.DATABASE_URL || 'postgresql://postgres:1@localhost:5432/postgres';

// Целевая БД для памяти агента. Отдельная, чтобы не смешивать с прочими данными.
const MEM_DB = env.MEM_DB_NAME || 'agent_mem';

function withDb(url, dbName) {
  return url.replace(/\/[^/]*$/, `/${dbName}`);
}

export const config = {
  // Строка подключения к серверной БД (для административных операций: CREATE DATABASE).
  adminDatabaseUrl: withDb(adminUrl, 'postgres'),
  // Строка подключения к рабочей БД памяти.
  databaseUrl: env.MEM_DATABASE_URL || withDb(adminUrl, MEM_DB),
  memDbName: MEM_DB,

  llm: {
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL || 'https://litellm.finam.ru/v1',
    // Основной агент: отвечает пользователю и вызывает инструменты.
    mainModel: env.MAIN_MODEL || 'gpt-5.4-mini',
    // Вспомогательная быстрая модель: классификация запроса.
    auxModel: env.AUX_MODEL || 'gpt-5.4-nano',
    // Модель извлечения фактов в память.
    extractModel: env.EXTRACT_MODEL || 'gpt-5.4-mini',
    // Модель эмбеддингов для смыслового поиска памяти.
    embedModel: env.EMBED_MODEL || 'text-embedding-3-small',
    embedDim: 1536,
  },

  // Ключ для шифрования защищённых данных (AES-256-GCM). Берётся из AUTH_SECRET.
  authSecret: env.AUTH_SECRET || 'dev-insecure-secret-change-me',

  timezone: env.TZ_DEFAULT || 'Europe/Moscow',
  debug: (env.DEBUG || '').split(',').map((s) => s.trim()).filter(Boolean),

  // Режим собеседника: темпоральный и тематический контекст в онлайн-ответе + извлечение тем после ответа.
  companion: {
    enabled: flag(env.COMPANION_MODE, false),
  },

  // Проактивный контур: бот пишет первым по триггерам с анти-спамом. По умолчанию выключен.
  proactive: {
    enabled: flag(env.PROACTIVE_ENABLED, false),
    intervalMs: Number(env.PROACTIVE_INTERVAL_MS || 300000),       // как часто воркер проверяет триггеры
    inactivityMinutes: Number(env.PROACTIVE_INACTIVITY_MIN || 1440),
    checkinHour: Number(env.PROACTIVE_CHECKIN_HOUR || 10),
    goalIntervalMinutes: Number(env.PROACTIVE_GOAL_INTERVAL_MIN || 2880),
    welcomeBackGapMinutes: Number(env.PROACTIVE_WELCOME_GAP_MIN || 60),
    contactPolicy: {
      softDailyLimit: Number(env.PROACTIVE_SOFT_DAILY_LIMIT || 1),
      softWeeklyLimit: Number(env.PROACTIVE_SOFT_WEEKLY_LIMIT || 3),
      requestedReminderDailyLimit: Number(env.PROACTIVE_REQUESTED_REMINDER_DAILY_LIMIT || 2),
      minSoftPauseMinutes: Number(env.PROACTIVE_MIN_SOFT_PAUSE_MIN || 360),
      quietAfterUnanswered: Number(env.PROACTIVE_QUIET_AFTER_UNANSWERED || 2),
      quietHoursAfterIgnores: Number(env.PROACTIVE_QUIET_HOURS_AFTER_IGNORES || 24),
    },
    events: {
      // Контур внешних событий. Требует proactive.enabled (использует ту же доставку и анти-спам).
      enabled: flag(env.PROACTIVE_EVENTS_ENABLED, false),
      relevanceThreshold: Number(env.NEWS_RELEVANCE_THRESHOLD || 0.6),
    },
  },

  // Слой per-domain схем data: валидация data по схеме домена и канонизация entity_key при записи факта.
  // Схема обязательна: предметный факт (с entity_type) сохраняется только если у домена есть схема,
  // в ней объявлена эта сущность, и data проходит валидацию. Иначе факт отклоняется, а не сохраняется.
  schema: {
    // Порог косинусной близости при канонизации ключа fixed_vocab по эмбеддингу: ниже — не канонизируем.
    keyEmbedThreshold: Number(env.SCHEMA_KEY_EMBED_THRESHOLD || 0.82),
  },

  // Жёсткие лимиты минимизации памяти: сколько фактов каждой области попадает в промпт (раздел 10.7 архитектуры).
  // Список ранжируется по релевантности и обрезается до этих значений. По умолчанию совпадают с прежними константами.
  memoryLimits: {
    profile: Number(env.MEMORY_LIMIT_PROFILE || 7),     // устойчивые факты о пользователе и стиле общения
    dialog: Number(env.MEMORY_LIMIT_DIALOG || 5),       // факты текущего диалога
    domain: Number(env.MEMORY_LIMIT_DOMAIN || 12),      // факты предметной области
    reminder: Number(env.MEMORY_LIMIT_REMINDER || 3),   // активные напоминания
    secure: Number(env.MEMORY_LIMIT_SECURE || 3),       // безопасные резюме защищённых данных
    total: Number(env.MEMORY_LIMIT_TOTAL || 30),        // общий потолок числа фактов в промпте
  },

  // Глобальная память: общий для всех пользователей слой. Два независимых механизма, каждый со своим флагом.
  // Глобальные факты подмешиваются в каждый запрос; общая база знаний (RAG) — только релевантные фрагменты.
  // Наполнять и чистить оба хранилища может только администратор (пометка is_admin). По умолчанию всё выключено.
  globalMemory: {
    factsEnabled: flag(env.GLOBAL_MEMORY_ENABLED, false), // всегда-включённые глобальные факты + их инструменты
    factsLimit: Number(env.GLOBAL_FACTS_LIMIT || 5),      // сколько фактов подмешивать в каждый запрос
    ragEnabled: flag(env.GLOBAL_RAG_ENABLED, false),      // общая база знаний (RAG) + её инструменты
    ragLimit: Number(env.GLOBAL_RAG_LIMIT || 5),          // сколько фрагментов базы знаний подмешивать по релевантности
    ragMinRelevance: Number(env.GLOBAL_RAG_MIN_RELEVANCE || 0.3), // порог отсечения слабых совпадений базы знаний
  },

  // Распознавание входящего аудио (речь в текст). По умолчанию выключено, как и прочие необязательные контуры.
  // При выключенном флаге голосовые сообщения, кружки и присланные аудио/видео игнорируются, как и раньше.
  voiceInput: {
    enabled: flag(env.VOICE_INPUT_ENABLED, false),
    // Выбор распознавателя из реестра src/voice/transcribe.js. По умолчанию — самый быстрый и дешёвый.
    provider: env.VOICE_INPUT_PROVIDER || 'groq-whisper-large-v3-turbo',
    maxSeconds: Number(env.VOICE_INPUT_MAX_SECONDS || 300),        // предел длительности (пять минут)
    maxBytes: Number(env.VOICE_INPUT_MAX_BYTES || 25000000),       // предел размера, когда длительность неизвестна
    language: env.VOICE_INPUT_LANG || 'ru',                        // код языка-подсказки для распознавателя
  },

  // Голосовой ответ бота (текст в речь, TTS). Канальная настройка Telegram-адаптера: ядро лишь хранит и
  // возвращает предпочтение формы ответа, а сам синтез и доставка голосом живут в канале. По умолчанию
  // выключено — при выключенном флаге инструмент set_reply_mode не подключается и бот отвечает текстом.
  // Синтез идёт через тот же OpenAI-совместимый прокси (конечная точка audio/speech), что подтверждено
  // практической проверкой: прокси отдаёт модель gpt-4o-mini-tts и формат OGG/OPUS без перекодировки.
  voiceOutput: {
    enabled: flag(env.VOICE_OUTPUT_ENABLED, false),
    model: env.VOICE_OUTPUT_MODEL || 'openai/gpt-4o-mini-tts',  // модель синтеза речи на прокси
    voice: env.VOICE_OUTPUT_VOICE || 'alloy',                  // тембр (язык подстраивается под текст ответа)
    format: env.VOICE_OUTPUT_FORMAT || 'opus',                 // OGG/OPUS — прямая отправка в Telegram sendVoice
    // Жёсткий предел длины текста, отправляемого в синтез. Значение по умолчанию и максимум — 500 символов:
    // более длинный текст никогда не уходит в TTS, вместо него озвучивается резюме.
    maxChars: Math.min(500, Number(env.VOICE_OUTPUT_MAX_CHARS || 500)),
    // Порог длины самого резюме, чтобы голосовое сообщение оставалось коротким (не больше общего предела).
    summaryMaxChars: Number(env.VOICE_OUTPUT_SUMMARY_MAX_CHARS || 500),
    // Модель построения резюме для длинных ответов и ответов с кодом или списками (быстрая вспомогательная).
    summaryModel: env.VOICE_OUTPUT_SUMMARY_MODEL || env.AUX_MODEL || 'gpt-5.4-nano',
  },

  // Потоковая обратная связь. Ядро стримит финальный текст модели по частям и испускает абстрактные
  // события этапов и вызовов инструментов через callback onEvent (см. src/agent.js). Telegram-адаптер —
  // лишь один потребитель этих событий. По умолчанию включено: новый UX работает без настройки .env.
  // streaming.enabled управляет ядром (потоковый вызов модели), telegramEnabled — отображением в Telegram.
  streaming: {
    enabled: flag(env.LLM_STREAMING_ENABLED, true),              // потоковый вызов модели в ядре агента
    telegramEnabled: flag(env.TELEGRAM_STREAMING_ENABLED, true), // редактируемый черновик ответа в Telegram
    editIntervalMs: Number(env.TELEGRAM_STREAM_EDIT_INTERVAL_MS || 900),  // не чаще одного редактирования за это время
    minEditChars: Number(env.TELEGRAM_STREAM_MIN_EDIT_CHARS || 20),       // и не реже, чем накопится столько новых символов
    toolStatuses: flag(env.TELEGRAM_TOOL_STATUS_ENABLED, true),  // показывать ли «Вызываю инструмент: …»
  },

  // Поджатие старой части истории диалога. По умолчанию выключено, как и прочие необязательные контуры.
  // Последние hotWindow сообщений всегда передаются дословно; всё, что старше, сжимается в дайджест.
  historyCompression: {
    enabled: flag(env.HISTORY_COMPRESSION_ENABLED, false),
    hotWindow: Number(env.HISTORY_HOT_WINDOW || 8),       // сколько последних сообщений не сжимать вообще
    maxTokens: Number(env.HISTORY_MAX_TOKENS || 2000),    // порог запуска сжатия холодной зоны
    shrinkTokens: Number(env.HISTORY_SHRINK_TOKENS || 800), // целевой максимум размера дайджеста
    zoneWeights: String(env.HISTORY_ZONE_WEIGHTS || '0.55,0.30,0.15').split(',').map(Number), // ближняя/средняя/дальняя
    model: env.HISTORY_SUMMARY_MODEL || env.AUX_MODEL || 'gpt-5.4-nano',
    minCompressGain: Number(env.HISTORY_MIN_COMPRESS_GAIN || 0.35), // минимальный выигрыш сжатия, иначе не перезаписываем
  },
};

// Гистерезис: целевой размер дайджеста должен быть строго меньше порога запуска,
// иначе сжатие будет срабатывать сразу после самого себя и зациклится.
if (config.historyCompression.shrinkTokens >= config.historyCompression.maxTokens) {
  throw new Error('HISTORY_SHRINK_TOKENS должен быть меньше HISTORY_MAX_TOKENS');
}

export function debugEnabled(category) {
  return config.debug.includes('*') || config.debug.includes(category);
}
