-- ============================================================================
-- БД журналов (mem_bot_logs): журнал обращений к LLM и смежным сервисам (распознавание речи,
-- синтез речи, эмбеддинги) и журнал агентных событий. Отдельная база от рабочей mem_bot:
-- объёмные быстрорастущие логи не раздувают пользовательские данные, имеют независимые
-- бэкапы и ретеншн (см. src/pipeline/log-retention.js). Связь с пользователями и разговорами —
-- только по текстовым идентификаторам, без внешних ключей и каскадов.
--
-- Миграция применяется при КАЖДОМ старте (src/migrate.js прогоняет все файлы подряд), поэтому она
-- полностью идемпотентна: только CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / CREATE OR REPLACE.
-- DROP TABLE запрещён — иначе журнал стирался бы при каждом запуске. Триггер пересоздаётся через
-- DROP TRIGGER IF EXISTS, это безопасно: данные таблиц не трогаются.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS log;

-- Полный журнал: одна строка на каждое обращение к модели или смежному сервису.
CREATE TABLE IF NOT EXISTS log.llm_request (
  llm_request_id    bigserial PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  request_id        text,
  request_kind      text,
  endpoint          text,
  provider          text,
  model             text,
  model_priced      text,
  user_id           text,
  conversation_id   text,
  domain_key        text,
  channel           text,
  is_binary         boolean NOT NULL DEFAULT false,
  payload           jsonb,
  response          jsonb,
  binary_meta       jsonb,
  payload_truncated boolean NOT NULL DEFAULT false,
  response_truncated boolean NOT NULL DEFAULT false,
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,
  price_usd         numeric(12,6),
  duration_ms       integer,
  status            text NOT NULL DEFAULT 'ok',
  error             text,
  is_test           boolean NOT NULL DEFAULT false
);

-- Идемпотентное добавление колонок ответа для баз, созданных переносом из mem_bot (там их не было).
ALTER TABLE log.llm_request ADD COLUMN IF NOT EXISTS response jsonb;
ALTER TABLE log.llm_request ADD COLUMN IF NOT EXISTS response_truncated boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS llm_request_created_at_ix  ON log.llm_request (created_at);
CREATE INDEX IF NOT EXISTS llm_request_request_id_ix  ON log.llm_request (request_id);
CREATE INDEX IF NOT EXISTS llm_request_kind_ix        ON log.llm_request (request_kind);
CREATE INDEX IF NOT EXISTS llm_request_user_ix        ON log.llm_request (user_id, created_at);
CREATE INDEX IF NOT EXISTS llm_request_model_ix       ON log.llm_request (model);
CREATE INDEX IF NOT EXISTS llm_request_is_test_ix     ON log.llm_request (is_test) WHERE is_test;

-- Узкий журнал: только то, что нужно для быстрых агрегатов по токенам и стоимости.
CREATE TABLE IF NOT EXISTS log.llm_usage (
  llm_usage_id      bigserial PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  llm_request_id    bigint,
  request_kind      text,
  model             text,
  user_id           text,
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,
  price_usd         numeric(12,6),
  duration_ms       integer,
  is_test           boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS llm_usage_created_at_ix ON log.llm_usage (created_at);
CREATE INDEX IF NOT EXISTS llm_usage_user_ix       ON log.llm_usage (user_id, created_at);
CREATE INDEX IF NOT EXISTS llm_usage_model_ix      ON log.llm_usage (model);
CREATE INDEX IF NOT EXISTS llm_usage_kind_ix       ON log.llm_usage (request_kind);
CREATE INDEX IF NOT EXISTS llm_usage_is_test_ix    ON log.llm_usage (is_test) WHERE is_test;

-- Триггерная функция: при вставке в полный журнал переносит биллинговую часть в узкий журнал,
-- но только если есть что считать (есть токены или рассчитанная цена). Неудавшиеся обращения
-- без полезной нагрузки для биллинга в узкую таблицу не попадают и не засоряют агрегаты.
CREATE OR REPLACE FUNCTION log.llm_request_to_usage() RETURNS trigger AS $$
BEGIN
  IF NEW.total_tokens IS NOT NULL OR NEW.price_usd IS NOT NULL THEN
    INSERT INTO log.llm_usage (
      created_at, llm_request_id, request_kind, model, user_id,
      prompt_tokens, completion_tokens, total_tokens, price_usd, duration_ms, is_test
    ) VALUES (
      NEW.created_at, NEW.llm_request_id, NEW.request_kind, NEW.model_priced, NEW.user_id,
      NEW.prompt_tokens, NEW.completion_tokens, NEW.total_tokens, NEW.price_usd, NEW.duration_ms, NEW.is_test
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS llm_request_to_usage_trg ON log.llm_request;
CREATE TRIGGER llm_request_to_usage_trg
  AFTER INSERT ON log.llm_request
  FOR EACH ROW EXECUTE FUNCTION log.llm_request_to_usage();

-- Журнал агентных событий: стадии хода диалога, вызовы и результаты инструментов, подключения MCP.
-- Вместе с log.llm_request даёт исчерпывающую ленту цикла «фраза пользователя → ответ» в просмотрщике
-- логов админки. request_id — тот же корреляционный идентификатор, что и в log.llm_request.
CREATE TABLE IF NOT EXISTS log.agent_event (
  agent_event_id  bigserial PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  request_id      text,
  user_id         text,
  conversation_id text,
  event_type      text NOT NULL,
  title           text,
  data            jsonb,
  duration_ms     integer,
  status          text NOT NULL DEFAULT 'ok',
  error           text,
  is_test         boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS agent_event_request_ix ON log.agent_event (request_id, agent_event_id);
CREATE INDEX IF NOT EXISTS agent_event_created_ix ON log.agent_event (created_at);
CREATE INDEX IF NOT EXISTS agent_event_user_ix    ON log.agent_event (user_id, created_at);
CREATE INDEX IF NOT EXISTS agent_event_is_test_ix ON log.agent_event (is_test) WHERE is_test;

COMMENT ON TABLE log.llm_request IS 'Полный журнал обращений к LLM и смежным сервисам. Текст запроса и ответа — целиком, бинарь — только метаданные файла';
COMMENT ON TABLE log.llm_usage   IS 'Узкий журнал токенов и стоимости для быстрого подсчёта затрат на LLM';
COMMENT ON TABLE log.agent_event IS 'Журнал агентных событий: стадии, инструменты (с аргументами и результатами), подключения MCP';
