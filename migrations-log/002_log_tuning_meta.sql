-- ============================================================================
-- Привязка записей журнала LLM к версии кода и промпта (инфраструктура тюнинга,
-- см. claudedocs/self-tuning-infrastructure.md §3.2). Без этих колонок нельзя сказать,
-- какой версией кода и какого текста системного промпта порождена конкретная запись,
-- и сравнение «до/после» по историческим данным ненадёжно.
--
-- Миграция применяется при КАЖДОМ старте (src/migrate.js прогоняет все файлы подряд),
-- поэтому она полностью идемпотентна: только ADD COLUMN IF NOT EXISTS.
-- ============================================================================

-- Короткий хеш git HEAD на момент запуска процесса (берётся один раз при старте).
ALTER TABLE log.llm_request ADD COLUMN IF NOT EXISTS git_commit text;

-- SHA-256 (первые 16 hex-символов) конкатенации system-сообщений запроса. Заполняется только
-- для chat.completions; у бинарных и embedding-запросов системного промпта нет — там NULL.
ALTER TABLE log.llm_request ADD COLUMN IF NOT EXISTS prompt_hash text;

COMMENT ON COLUMN log.llm_request.git_commit IS 'Короткий хеш git HEAD процесса, породившего запись';
COMMENT ON COLUMN log.llm_request.prompt_hash IS 'SHA-256 (16 hex) системного промпта запроса; NULL вне chat.completions';
