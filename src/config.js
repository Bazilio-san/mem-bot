// Конфигурация приложения. Полностью строится пакетом node-config из YAML-иерархии config/:
// значения по умолчанию — config/default.yaml; окружение — development/production/test.yaml
// (выбирается по NODE_ENV); секреты — config/local.yaml; переопределения окружением —
// config/custom-environment-variables.yaml. Существующий .env по-прежнему читается (через bootstrap-загрузчик
// ниже) и переопределяет значения через ту же карту переменных окружения.
//
// Здесь структура НЕ пересобирается: config — это снимок готового дерева node-config. Код добавляет лишь
// проверку обязательных параметров и несколько инвариантов, которые невозможно выразить средствами YAML,
// и в случае ошибки валит процесс с понятным сообщением.
//
// Модели по умолчанию: основной агент и извлечение фактов — gpt-5.4-mini, классификация запроса — gpt-5.4-nano,
// эмбеддинги — text-embedding-3-small (1536 измерений). Любую модель можно переопределить переменными
// окружения MAIN_MODEL/AUX_MODEL/EXTRACT_MODEL/EMBED_MODEL или в config/local.yaml. Если задан llm.baseURL
// (OPENAI_BASE_URL), клиент OpenAI шлёт запросы в OpenAI-совместимый прокси (например, LiteLLM); пустое
// значение означает прямой вызов https://api.openai.com/v1.
import './bootstrap/dotenv.js'; // ПЕРВОЙ строкой: наполняет process.env до загрузки node-config
import nodeConfig from 'config'; // node-config читает каталог config/ при первом импорте
import { normalizeVoiceId } from './voice/voices.js';

// Готовое дерево конфигурации как обычный изменяемый объект. Форма совпадает со структурой config/default.yaml.
export const config = nodeConfig.util.toObject();

// Падение с понятным сообщением, если обязательные параметры не заданы.
// Пустая строка, null или отсутствие ключа считаются «не задано» (пустой host у af-db-ts = выключенная БД).
export function requireConfig(paths) {
  const missing = paths.filter((p) => {
    const v = nodeConfig.has(p) ? nodeConfig.get(p) : undefined;
    return v === undefined || v === null || v === '';
  });
  if (missing.length) {
    throw new Error(
      `Не заданы обязательные параметры конфигурации: ${missing.join(', ')}. ` +
        `Задайте их в config/local.yaml или через переменные окружения ` +
        `(см. config/custom-environment-variables.yaml).`,
    );
  }
}

// Универсальный минимум для любого процесса: рабочая БД и доступ к LLM.
// Канальные и частные требования каждая точка входа проверяет сама (например, telegram.apiKey в боте).
requireConfig([
  'db.postgres.dbs.main.host',
  'db.postgres.dbs.main.database',
  'db.postgres.dbs.main.user',
  'db.postgres.dbs.main.password',
  'llm.apiKey',
]);

// --- Инварианты: тоже падаем с понятным сообщением ---
// Гистерезис: целевой размер дайджеста строго меньше порога запуска, иначе сжатие будет срабатывать сразу
// после самого себя и зациклится.
if (config.historyCompression.shrinkTokens >= config.historyCompression.maxTokens) {
  throw new Error('historyCompression.shrinkTokens должен быть строго меньше historyCompression.maxTokens.');
}
// Жёсткий потолок длины озвучиваемого текста.
if (config.voiceOutput.maxChars > 500) {
  throw new Error('voiceOutput.maxChars не может превышать 500.');
}

// --- Минимальные неизбежные нормализации (то, что нельзя выразить в YAML) ---
// Пустой baseURL означает «прямой OpenAI API» — приводим '' к undefined для клиента OpenAI.
if (!config.llm.baseURL) {
  config.llm.baseURL = undefined;
}
// Тембр голоса канонизируем и проверяем на известность (только если синтез включён).
if (config.voiceOutput.enabled) {
  const v = normalizeVoiceId(config.voiceOutput.voice);
  if (!v) {
    throw new Error(`Неизвестный voiceOutput.voice: "${config.voiceOutput.voice}".`);
  }
  config.voiceOutput.voice = v;
}

// debug в YAML и окружении — строка категорий через запятую; разбираем её только здесь.
export function debugEnabled(category) {
  const list = String(config.debug || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes('*') || list.includes(category);
}
