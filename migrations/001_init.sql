-- Единая стартовая миграция: полная схема памяти в конечном состоянии.
-- Рассчитана на PostgreSQL 16 + pgvector. Идемпотентна: повторный запуск не ломает БД.
--
-- Этот файл — результат схлопывания прежних миграций 001–016 в одну. Сведение выполнено к КОНЕЧНОМУ
-- состоянию схемы, а не к простой конкатенации:
--   * таблица mem.domain_schemas (прежние 006 + 014) исключена — она создавалась и тут же удалялась;
--   * companion-виды памяти (прежняя 013) уже включены в определение типа mem.memory_kind ниже;
--   * RAG-статья «Что умеет бот» (прежние 011 + 012) засевается сразу в финальном виде;
--   * колонки, прежде добавлявшиеся через ALTER (003/005/007/009/015/016), встроены в CREATE TABLE.
-- Журнала применённых миграций в проекте нет: src/migrate.js прогоняет все .sql каждый раз, поэтому
-- все операторы здесь идемпотентны (IF NOT EXISTS / ON CONFLICT / WHERE NOT EXISTS).

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

-- Включает виды для режима собеседника (прежняя миграция 013): emotional_pattern, activity_rhythm,
-- communication_style, open_loop, topic_energy, discovery_seed.
DO $$ BEGIN
  CREATE TYPE mem.memory_kind AS ENUM
    ('fact','preference','constraint','goal','history','state','progress','instruction','relationship','reminder',
     'secure_reference','emotional_pattern','activity_rhythm','communication_style','open_loop','topic_energy',
     'discovery_seed');
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
-- Колонки is_admin (005), proactivity_enabled (007), reply_mode (009), voice_output_voice (016)
-- встроены сразу в определение таблицы.
-- Флаг is_test помечает технических пользователей, создаваемых автотестами, по аналогии с
-- log.llm_request.is_test. Он позволяет отличать и при необходимости вычищать тестовые записи,
-- не затрагивая реальных пользователей.
CREATE TABLE IF NOT EXISTS mem.users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id  text UNIQUE,
    display_name text,
    locale       text NOT NULL DEFAULT 'ru',
    timezone     text NOT NULL DEFAULT 'Europe/Moscow',
    is_admin     boolean NOT NULL DEFAULT false,
    proactivity_enabled boolean NOT NULL DEFAULT false,
    reply_mode   text NOT NULL DEFAULT 'text' CHECK (reply_mode IN ('text', 'voice')),
    voice_output_voice text
      CONSTRAINT users_voice_output_voice_check CHECK (
        voice_output_voice IS NULL
        OR voice_output_voice IN (
          'alloy', 'ash', 'ballad', 'cedar', 'coral', 'marin',
          'nova', 'fable', 'onyx', 'sage', 'verse'
        )
      ),
    is_test      boolean NOT NULL DEFAULT false,
    metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Идемпотентное добавление is_test для уже существующих баз: CREATE TABLE IF NOT EXISTS выше
-- не меняет схему существующей таблицы, поэтому колонку для ранее созданных баз добавляем
-- отдельной инструкцией. ADD COLUMN IF NOT EXISTS с DEFAULT false не трогает данные.
ALTER TABLE mem.users ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

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
-- Поля поджатия истории (прежняя миграция 003) встроены в определение таблицы.
CREATE TABLE IF NOT EXISTS mem.conversation_summaries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL REFERENCES mem.conversations(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    summary_text    text NOT NULL,
    state_json      jsonb NOT NULL DEFAULT '{}'::jsonb,
    importance      numeric(3,2) NOT NULL DEFAULT 0.50 CHECK (importance >= 0 AND importance <= 1),
    -- Слой дайджеста. При зонировании активна одна строка 'full'; при послойном досжатии — near/middle/far.
    layer           text NOT NULL DEFAULT 'full' CHECK (layer IN ('near','middle','far','full')),
    -- Границы покрытой холодной зоны: от какого до какого сообщения и до какого момента времени.
    covered_from_message_id uuid,
    covered_to_message_id   uuid,
    covered_until           timestamptz,
    -- Сколько сообщений и токенов исходной холодной зоны вошло в дайджест (считается нашим кодом).
    source_message_count integer NOT NULL DEFAULT 0,
    source_token_count   integer NOT NULL DEFAULT 0,
    -- Итоговый размер дайджеста в токенах (для контроля порога HISTORY_SHRINK_TOKENS).
    summary_token_count  integer NOT NULL DEFAULT 0,
    -- Какие факты не вошли в историю, потому что уже есть в долговременной памяти.
    memory_dedupe jsonb NOT NULL DEFAULT '{}'::jsonb,
    -- Версия записи дайджеста и признак активности (активна только последняя сводка диалога).
    summary_version integer NOT NULL DEFAULT 1,
    is_active boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_summaries_conversation_created ON mem.conversation_summaries (conversation_id, created_at DESC);
-- Быстрый доступ к активной сводке диалога.
CREATE INDEX IF NOT EXISTS idx_summaries_active_conversation
  ON mem.conversation_summaries (conversation_id, created_at DESC)
  WHERE is_active = true;
-- Поиск по покрытому моменту времени (для определения непокрытой холодной зоны).
CREATE INDEX IF NOT EXISTS idx_summaries_covered_until
  ON mem.conversation_summaries (conversation_id, covered_until DESC);

-- ---- Главная таблица памяти: профиль + предметные знания --------------------
-- Поля смысловой дедупликации (прежняя миграция 015) встроены в определение таблицы.
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

    -- Смысловая дедупликация: устойчивый ключ, каноническая группа и статус в группе.
    dedupe_key         text,
    canonical_group_id uuid,
    dedupe_status      text NOT NULL DEFAULT 'candidate',

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
CREATE INDEX IF NOT EXISTS idx_memory_dedupe_key
  ON mem.memory_items (user_id, dedupe_key)
  WHERE status = 'active' AND dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_canonical_group
  ON mem.memory_items (user_id, canonical_group_id)
  WHERE canonical_group_id IS NOT NULL;

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

-- Событийная доставка очереди (прежняя миграция 004): при вставке строки со статусом «pending» база
-- сама посылает уведомление PostgreSQL NOTIFY на канал «outbox_new». Адаптер слушает этот канал и
-- опустошает очередь немедленно, а не по таймеру.
CREATE OR REPLACE FUNCTION mem.notify_outbox() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'pending' THEN
    PERFORM pg_notify('outbox_new', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_outbox ON mem.notification_outbox;
CREATE TRIGGER trg_notify_outbox
  AFTER INSERT ON mem.notification_outbox
  FOR EACH ROW EXECUTE FUNCTION mem.notify_outbox();

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

-- ---- Проактивность (прежняя миграция 002): тематический трекинг, триггеры, журнал доставок --------
-- 1. Тематический трекинг. Одна строка на пару «пользователь + домен + тема».
CREATE TABLE IF NOT EXISTS mem.topic_mentions (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    domain_id             uuid REFERENCES mem.agent_domains(id),
    topic_key             text NOT NULL,                 -- стабильный ключ темы: fitness, work_stress, sleep
    mention_count         integer NOT NULL DEFAULT 1,
    user_engagement_score real    NOT NULL DEFAULT 0.5 CHECK (user_engagement_score >= 0 AND user_engagement_score <= 1),
    first_mentioned_at    timestamptz NOT NULL DEFAULT now(),
    last_mentioned_at     timestamptz NOT NULL DEFAULT now(),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, domain_id, topic_key)
);
CREATE INDEX IF NOT EXISTS idx_topic_mentions_user_last       ON mem.topic_mentions (user_id, last_mentioned_at DESC);
CREATE INDEX IF NOT EXISTS idx_topic_mentions_user_engagement ON mem.topic_mentions (user_id, user_engagement_score DESC);

-- 2. Триггеры проактивности. Набор триггеров на пользователя.
CREATE TABLE IF NOT EXISTS mem.proactive_triggers (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    domain_id     uuid REFERENCES mem.agent_domains(id),
    trigger_type  text NOT NULL,                          -- inactivity | daily_checkin | goal_reminder | welcome_back
    config        jsonb NOT NULL DEFAULT '{}'::jsonb,      -- пороги срабатывания: {"minutes_inactive":1440}
    enabled       boolean NOT NULL DEFAULT true,
    last_fired_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, trigger_type)
);
CREATE INDEX IF NOT EXISTS idx_proactive_triggers_enabled ON mem.proactive_triggers (enabled) WHERE enabled = true;

-- 3. Журнал доставленных внешних событий. Защита от повторной доставки одного события.
CREATE TABLE IF NOT EXISTS mem.event_deliveries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    event_id        text NOT NULL,                         -- стабильный идентификатор события из источника
    event_type      text NOT NULL DEFAULT 'news',
    relevance_score real,
    reason          text,
    delivered_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_event_deliveries_user ON mem.event_deliveries (user_id, delivered_at DESC);

-- ---- Глобальная память (прежняя миграция 005): глобальные факты и общая база знаний (RAG) ---------
-- 1. Глобальные факты (always-on). Короткие записи, которые подмешиваются в каждый запрос как
--    авторитетные общие сведения и политика. Источник доверенный (только администратор).
CREATE TABLE IF NOT EXISTS mem.global_facts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id   uuid REFERENCES mem.agent_domains(id),    -- NULL = факт действует во всех доменах
    fact_text   text NOT NULL,
    priority    integer NOT NULL DEFAULT 100,             -- меньше число — выше в списке при отборе под лимит
    enabled     boolean NOT NULL DEFAULT true,
    created_by  uuid REFERENCES mem.users(id) ON DELETE SET NULL,
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_global_facts_enabled ON mem.global_facts (enabled, priority) WHERE enabled = true;

-- 2. Общая база знаний (RAG). Тексты, видимые всем, подмешиваются по релевантности к запросу.
CREATE TABLE IF NOT EXISTS mem.global_knowledge (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id   uuid REFERENCES mem.agent_domains(id),    -- NULL = знание общее для всех доменов
    title       text,
    content     text NOT NULL,
    tags        text[] NOT NULL DEFAULT '{}',
    importance  numeric(3,2) NOT NULL DEFAULT 0.50 CHECK (importance >= 0 AND importance <= 1),
    status      mem.memory_status NOT NULL DEFAULT 'active',
    source      text,                                     -- откуда взят текст (документ, ссылка, автор)
    created_by  uuid REFERENCES mem.users(id) ON DELETE SET NULL,
    embedding   vector(1536),
    search_tsv  tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,''))
    ) STORED,
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_global_knowledge_domain_status ON mem.global_knowledge (domain_id, status);
CREATE INDEX IF NOT EXISTS idx_global_knowledge_search_tsv    ON mem.global_knowledge USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_global_knowledge_embedding     ON mem.global_knowledge
                                                              USING hnsw (embedding vector_cosine_ops)
                                                              WHERE embedding IS NOT NULL;

-- 3. Засев базовых глобальных фактов. Идемпотентно: каждый факт вставляется, только если его ещё нет
--    (сверка по тексту), поэтому повторный прогон дублей не создаёт.
INSERT INTO mem.global_facts (fact_text, priority, metadata)
SELECT v.fact_text, v.priority, '{"seed":"005"}'::jsonb
FROM (VALUES
  ('Создатель бота — Кот Базилио. Он создал бота 6 июня 2026 года в 12:00 по московскому времени.', 10),
  ('Имя бота — Яша. Если пользователь дал боту другое имя, использовать имя, которое дал пользователь.', 10),
  ('Создатель бота, Кот Базилио, — программист.', 20),
  ('Стакан наполовину мангуст.', 100),
  ('Перевёрнутая кружка — без дна и с запаянным верхом.', 100),
  ('Вечером все кошки серые.', 100),
  ('Солнце светит — это ясно.', 100),
  ('Луна боится, что получит по жопе, поэтому всегда повёрнута к нам мордой.', 100)
) AS v(fact_text, priority)
WHERE NOT EXISTS (
  SELECT 1 FROM mem.global_facts gf WHERE gf.fact_text = v.fact_text
);

-- ---- Внешние идентификаторы сообщений (прежняя миграция 008) ---------------
-- Связь внутренней истории с сообщениями в каналах доставки. Используется обработчиками реакций.
CREATE TABLE IF NOT EXISTS mem.message_external_refs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_message_id uuid NOT NULL REFERENCES mem.conversation_messages(id) ON DELETE CASCADE,
    channel text NOT NULL,
    chat_external_id text NOT NULL,
    message_external_id text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (channel, chat_external_id, message_external_id)
);
CREATE INDEX IF NOT EXISTS idx_message_external_refs_message
ON mem.message_external_refs (conversation_message_id);

-- ---- Состояние контакта для проактивности (прежняя миграция 010) -----------
-- Каналонезависимое состояние контакта для человекоподобной проактивности.
CREATE TABLE IF NOT EXISTS mem.proactive_contact_state (
    user_id                           uuid PRIMARY KEY REFERENCES mem.users(id) ON DELETE CASCADE,
    mode                              text NOT NULL DEFAULT 'active'
                                      CHECK (mode IN ('active','cautious','quiet')),
    last_proactive_sent_at            timestamptz,
    last_soft_proactive_sent_at       timestamptz,
    last_user_reply_after_proactive_at timestamptz,
    unanswered_proactive_count        integer NOT NULL DEFAULT 0 CHECK (unanswered_proactive_count >= 0),
    ignored_soft_count_7d             integer NOT NULL DEFAULT 0 CHECK (ignored_soft_count_7d >= 0),
    daily_soft_count                  integer NOT NULL DEFAULT 0 CHECK (daily_soft_count >= 0),
    daily_requested_reminder_count    integer NOT NULL DEFAULT 0 CHECK (daily_requested_reminder_count >= 0),
    weekly_soft_count                 integer NOT NULL DEFAULT 0 CHECK (weekly_soft_count >= 0),
    counters_day                      date NOT NULL DEFAULT CURRENT_DATE,
    counters_week                     date NOT NULL DEFAULT date_trunc('week', now())::date,
    quiet_until                       timestamptz,
    last_trigger_type                 text,
    last_topic_key                    text,
    updated_at                        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_proactive_contact_state_mode
    ON mem.proactive_contact_state (mode, quiet_until);

-- ---- Засев RAG-статьи «Что умеет бот» (прежние миграции 011 + 012) ---------
-- Финальный вид статьи (после правки 012, убравшей сведения о конкретных доменах). Идемпотентно:
-- вставляется только если статьи с таким source/kind ещё нет, поэтому повторный прогон дублей не создаёт.
INSERT INTO mem.global_knowledge (title, content, tags, importance, source, metadata)
SELECT
  'Что умеет бот',
  $rag$
Эта статья нужна для ответов на вопросы: "Что ты можешь?", "Что ты умеешь?", "Какие у тебя функции?",
"Чем ты можешь помочь?", "Какие у тебя инструменты?".

Бот - агентское приложение с долговременной памятью, общей базой знаний и подключаемыми инструментами. Он умеет
поддерживать обычный диалог, помнить полезные факты о пользователе, искать по базе знаний, создавать напоминания и
выполнять доступные в текущем запуске инструменты, когда это действительно нужно для ответа или действия.

Основные возможности:
- Отвечает на вопросы и ведёт диалог с учётом текущей даты, времени, часового пояса и недавней истории разговора.
- Использует долговременную память: профиль пользователя, факты текущего диалога, активные напоминания и безопасные
  ссылки на защищённые записи.
- Управляет памятью по просьбе пользователя: может показать, что помнит, забыть конкретную сущность или полностью
  очистить память после явного подтверждения.
- Работает с общей базой знаний RAG: находит релевантные статьи и фрагменты, но не тащит весь корпус знаний в каждый
  ответ.
- Видит доступные инструменты во время ответа. Поэтому на вопрос о возможностях должен совмещать эту статью только с
  фактическим списком подключённых инструментов, который видит в текущем запуске.
- Домены агента — это внутренние области контекста и памяти. Они не являются умениями и не используются как источник
  публичного списка возможностей.
- Создаёт напоминания и задачи через планировщик, если пользователь просит напомнить, проверить или сделать что-то в
  будущем.
- Может переключать формат ответа между текстом и голосом, если в окружении включён голосовой вывод.
- Может принимать голосовые сообщения, если включено распознавание речи.
- Может работать проактивно, если пользователь явно включил проактивность: напоминать, возвращаться к целям или
  аккуратно писать после паузы с учётом антиспама.
- Для администратора доступны инструменты наполнения общей памяти: добавление и удаление глобальных фактов и статей
  базы знаний.

Как отвечать на вопрос "Что ты умеешь?":
1. Не ограничиваться сухим списком инструментов. Дать красивый, понятный обзор человеческим языком.
2. Сначала назвать главное: диалог, память, инструменты, напоминания и RAG.
3. Затем привести несколько практических примеров запросов пользователя.
4. Чётко отделять то, что включено сейчас, от того, что возможно только при включённом флаге или подключённом
   инструменте.
5. Не обещать недоступные функции. Если конкретный инструмент или флаг не виден в текущем контексте, формулировать
   осторожно: "могу, если это подключено" или "в этой сборке вижу такие инструменты".
6. Не выводить умения из доменов. Если в контексте есть домены, они обозначают только области памяти и классификации,
   а не действия вроде "искать", "покупать", "решать" или "рассказывать".

Пример хорошего тона ответа:
"Я могу быть собеседником с памятью: помнить важные факты, помогать с задачами, создавать напоминания, искать по базе
знаний и пользоваться подключёнными инструментами. Сейчас я вижу такие инструменты: ... Поэтому ты можешь спросить
меня, например: 'напомни завтра', 'что ты обо мне помнишь?', 'объясни по базе знаний', 'забудь этот факт'."
$rag$,
  ARRAY['bot', 'capabilities', 'about', 'tools', 'rag'],
  0.95,
  'seed:011',
  '{"seed":"011","kind":"bot_capabilities","seed_update":"012"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1
  FROM mem.global_knowledge
  WHERE source = 'seed:011'
     OR (title = 'Что умеет бот' AND metadata->>'kind' = 'bot_capabilities')
);

-- ============================================================================
-- Журналы LLM-запросов и агентных событий живут в ОТДЕЛЬНОЙ базе (mem_bot_logs, подключение
-- db.postgres.dbs.logs), а не здесь: объёмные быстрорастущие логи отделены от пользовательских
-- данных. Схема журналов — в migrations-log/001_log_init.sql; перенос исторических данных из
-- этой базы — scripts/migrate-llm-log-db.js. Оставшиеся здесь таблицы log.* (от прежних установок)
-- не используются кодом и могут быть удалены вручную после переноса.
-- ============================================================================
