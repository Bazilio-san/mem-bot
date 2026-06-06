-- Стартовая миграция: схема mem, типы, таблицы, индексы, базовые домены.
-- Рассчитана на PostgreSQL 16 + pgvector. Идемпотентна: повторный запуск не ломает БД.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE SCHEMA IF NOT EXISTS mem;

-- ---- Справочные ENUM-типы (создаются только если ещё нет) -------------------
DO $$ BEGIN
  CREATE TYPE mem.memory_status AS ENUM ('active','archived','deleted','pending_confirmation','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mem.sensitivity_level AS ENUM ('public','low','normal','high','secret');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mem.memory_kind AS ENUM
    ('fact','preference','constraint','goal','history','state','progress','instruction','relationship','reminder','secure_reference');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mem.task_status AS ENUM ('active','paused','completed','cancelled','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mem.task_schedule_kind AS ENUM ('one_time','interval','cron','rrule');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mem.task_run_status AS ENUM ('queued','running','success','failed','skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---- Пользователи -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS mem.users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id  text UNIQUE,
    display_name text,
    locale       text NOT NULL DEFAULT 'ru',
    timezone     text NOT NULL DEFAULT 'Europe/Moscow',
    metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ---- Домены/специализации агента -------------------------------------------
CREATE TABLE IF NOT EXISTS mem.agent_domains (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_key    text NOT NULL UNIQUE,
    title         text NOT NULL,
    description   text,
    default_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
    memory_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

INSERT INTO mem.agent_domains (domain_key, title, description) VALUES
  ('general',       'Универсальный помощник',  'Базовый домен без узкой специализации'),
  ('flight_search', 'Поиск авиабилетов',       'Авиабилеты, рейсы, аэропорты, даты вылета и пересадки'),
  ('joke_teller',   'Знаток анекдотов',        'Поиск свежих анекдотов в интернете и их рассказ'),
  ('math_tutor',    'Репетитор по математике', 'Темы, ошибки, прогресс ученика')
ON CONFLICT (domain_key) DO NOTHING;

-- ---- Диалоги ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mem.conversations (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    domain_id     uuid REFERENCES mem.agent_domains(id),
    channel       text NOT NULL DEFAULT 'chat',
    title         text,
    status        text NOT NULL DEFAULT 'active',
    current_state jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON mem.conversations (user_id, updated_at DESC);

-- ---- Сообщения диалога ------------------------------------------------------
CREATE TABLE IF NOT EXISTS mem.conversation_messages (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES mem.conversations(id) ON DELETE CASCADE,
    user_id         uuid REFERENCES mem.users(id) ON DELETE CASCADE,
    role            text NOT NULL CHECK (role IN ('system','user','assistant','tool')),
    content         text NOT NULL,
    tool_name       text,
    tool_call_id    text,
    token_count     integer,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON mem.conversation_messages (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_user_created ON mem.conversation_messages (user_id, created_at DESC);

-- ---- Сводки диалога (сжатая краткосрочная память) ---------------------------
CREATE TABLE IF NOT EXISTS mem.conversation_summaries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES mem.conversations(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    summary_text    text NOT NULL,
    state_json      jsonb NOT NULL DEFAULT '{}'::jsonb,
    importance      numeric(3,2) NOT NULL DEFAULT 0.50 CHECK (importance >= 0 AND importance <= 1),
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_summaries_conversation_created ON mem.conversation_summaries (conversation_id, created_at DESC);

-- ---- Главная таблица памяти: профиль + предметные знания --------------------
CREATE TABLE IF NOT EXISTS mem.memory_items (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    domain_id   uuid REFERENCES mem.agent_domains(id),

    scope       text NOT NULL CHECK (scope IN ('profile','domain','dialog','system')),
    memory_kind mem.memory_kind NOT NULL,

    entity_type text,
    entity_key  text,
    title       text,
    memory_text text NOT NULL,
    data        jsonb NOT NULL DEFAULT '{}'::jsonb,

    importance  numeric(3,2) NOT NULL DEFAULT 0.50 CHECK (importance >= 0 AND importance <= 1),
    confidence  numeric(3,2) NOT NULL DEFAULT 0.70 CHECK (confidence >= 0 AND confidence <= 1),
    sensitivity mem.sensitivity_level NOT NULL DEFAULT 'normal',
    status      mem.memory_status NOT NULL DEFAULT 'active',

    source_conversation_id uuid REFERENCES mem.conversations(id) ON DELETE SET NULL,
    source_message_id      uuid REFERENCES mem.conversation_messages(id) ON DELETE SET NULL,

    valid_from   timestamptz,
    expires_at   timestamptz,
    last_used_at timestamptz,
    usage_count  integer NOT NULL DEFAULT 0,

    embedding    vector(1536),
    search_tsv   tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(memory_text,''))
    ) STORED,

    metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_user_scope_status  ON mem.memory_items (user_id, scope, status);
CREATE INDEX IF NOT EXISTS idx_memory_user_domain_status ON mem.memory_items (user_id, domain_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_entity            ON mem.memory_items (user_id, domain_id, entity_type, entity_key);
CREATE INDEX IF NOT EXISTS idx_memory_expires           ON mem.memory_items (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_importance        ON mem.memory_items (user_id, importance DESC, updated_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_memory_search_tsv        ON mem.memory_items USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_memory_data_gin          ON mem.memory_items USING gin (data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_memory_embedding_hnsw    ON mem.memory_items USING hnsw (embedding vector_cosine_ops) WHERE embedding IS NOT NULL;

-- ---- Защищённая память (шифрованные персональные данные) --------------------
CREATE TABLE IF NOT EXISTS mem.secure_records (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    domain_id         uuid REFERENCES mem.agent_domains(id),

    record_type       text NOT NULL,
    subject_key       text,
    display_name      text,
    redacted_summary  text NOT NULL,

    encrypted_payload bytea NOT NULL,
    payload_hash      bytea,
    key_version       text NOT NULL DEFAULT 'v1',

    consent_status    text NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('unknown','granted','revoked')),
    consent_at        timestamptz,

    expires_at        timestamptz,
    last_used_at      timestamptz,
    metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_secure_user_type ON mem.secure_records (user_id, record_type);
CREATE INDEX IF NOT EXISTS idx_secure_subject   ON mem.secure_records (user_id, domain_id, subject_key);
CREATE INDEX IF NOT EXISTS idx_secure_expires   ON mem.secure_records (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS mem.memory_secure_links (
    memory_item_id   uuid NOT NULL REFERENCES mem.memory_items(id) ON DELETE CASCADE,
    secure_record_id uuid NOT NULL REFERENCES mem.secure_records(id) ON DELETE CASCADE,
    relation_type    text NOT NULL DEFAULT 'references',
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (memory_item_id, secure_record_id)
);

-- ---- Планировщик: задачи, запуски, исходящие уведомления --------------------
CREATE TABLE IF NOT EXISTS mem.scheduled_tasks (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    domain_id        uuid REFERENCES mem.agent_domains(id),
    conversation_id  uuid REFERENCES mem.conversations(id) ON DELETE SET NULL,

    task_type        text NOT NULL,
    title            text NOT NULL,
    instruction      text NOT NULL,
    payload          jsonb NOT NULL DEFAULT '{}'::jsonb,

    schedule_kind    mem.task_schedule_kind NOT NULL,
    timezone         text NOT NULL DEFAULT 'Europe/Moscow',

    run_at           timestamptz,
    interval_seconds integer,
    cron_expr        text,
    rrule            text,
    next_run_at      timestamptz NOT NULL,

    status           mem.task_status NOT NULL DEFAULT 'active',
    priority         integer NOT NULL DEFAULT 100,
    max_attempts     integer NOT NULL DEFAULT 3,
    attempts         integer NOT NULL DEFAULT 0,

    locked_by        text,
    locked_until     timestamptz,
    last_run_at      timestamptz,
    completed_at     timestamptz,

    metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_due         ON mem.scheduled_tasks (next_run_at, priority) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON mem.scheduled_tasks (user_id, status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_tasks_lock        ON mem.scheduled_tasks (locked_until) WHERE locked_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS mem.scheduled_task_runs (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    task_id     uuid NOT NULL REFERENCES mem.scheduled_tasks(id) ON DELETE CASCADE,
    status      mem.task_run_status NOT NULL DEFAULT 'queued',
    worker_id   text,
    started_at  timestamptz,
    finished_at timestamptz,
    result      jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_text  text,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task_created ON mem.scheduled_task_runs (task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mem.notification_outbox (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    task_id         uuid REFERENCES mem.scheduled_tasks(id) ON DELETE SET NULL,
    channel         text NOT NULL,
    recipient       text,
    message_text    text NOT NULL,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','cancelled')),
    attempts        integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    error_text      text,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON mem.notification_outbox (next_attempt_at) WHERE status = 'pending';

-- ---- Журнал вызовов инструментов агента ------------------------------------
CREATE TABLE IF NOT EXISTS mem.tool_calls (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid REFERENCES mem.conversations(id) ON DELETE SET NULL,
    user_id         uuid REFERENCES mem.users(id) ON DELETE SET NULL,
    tool_name       text NOT NULL,
    tool_call_id    text,
    input_json      jsonb NOT NULL DEFAULT '{}'::jsonb,
    output_json     jsonb,
    status          text NOT NULL DEFAULT 'started' CHECK (status IN ('started','success','failed','blocked')),
    latency_ms      integer,
    error_text      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    finished_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_user_created         ON mem.tool_calls (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_calls_conversation_created ON mem.tool_calls (conversation_id, created_at DESC);

-- ---- Очередь асинхронной записи памяти -------------------------------------
CREATE TABLE IF NOT EXISTS mem.memory_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    conversation_id uuid REFERENCES mem.conversations(id) ON DELETE CASCADE,
    job_type        text NOT NULL DEFAULT 'extract_memory',
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','success','failed')),
    attempts        integer NOT NULL DEFAULT 0,
    locked_by       text,
    locked_until    timestamptz,
    error_text      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_memory_jobs_pending ON mem.memory_jobs (created_at) WHERE status = 'pending';
