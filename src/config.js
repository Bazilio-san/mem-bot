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
    events: {
      // Контур внешних событий. Требует proactive.enabled (использует ту же доставку и анти-спам).
      enabled: flag(env.PROACTIVE_EVENTS_ENABLED, false),
      relevanceThreshold: Number(env.NEWS_RELEVANCE_THRESHOLD || 0.6),
    },
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
