# 05. Схема данных PostgreSQL

## Вкратце

Вся память живёт в отдельной схеме `mem` выделенной базы `agent_mem` — всего двадцать таблиц. Их определяют миграции:
`001_init.sql` — тринадцать базовых таблиц, типы и индексы; `002_proactive.sql` — три таблицы проактивности;
`005_global_memory.sql` — две таблицы глобальной памяти и колонка `is_admin`; `006_domain_schemas.sql` — таблица-реестр
схем `data` под домен; `007_proactivity_flag.sql` — колонка `proactivity_enabled` в `mem.users`;
`008_message_external_refs.sql` — внешние идентификаторы сообщений в каналах доставки; `009_reply_mode.sql` —
колонка `reply_mode` в `mem.users` (предпочитаемая форма ответа); `013_companion_memory_kinds.sql` — виды памяти
режима собеседника. Все миграции идемпотентны
(`CREATE ... IF NOT EXISTS`, защищённые `CREATE TYPE`). Используются расширения `pgcrypto` и `pgvector`.

## Зачем отдельная схема и идемпотентность

Отдельная схема `mem` не смешивает память агента с прочими данными. Идемпотентность позволяет безопасно прогонять
миграцию повторно (важно для разработки и CI): объекты создаются через `IF NOT EXISTS`, а ENUM-типы — через защищённый
блок `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;`.

---

## [DATA-1] Расширения, схема и ENUM-типы

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS mem;

CREATE TYPE mem.memory_status     AS ENUM ('active','archived','deleted','pending_confirmation','rejected');
CREATE TYPE mem.sensitivity_level AS ENUM ('public','low','normal','high','secret');
CREATE TYPE mem.memory_kind       AS ENUM
  ('fact','preference','constraint','goal','history','state','progress','instruction','relationship',
   'reminder','secure_reference','emotional_pattern','activity_rhythm','communication_style','open_loop',
   'topic_energy','discovery_seed');
CREATE TYPE mem.task_status        AS ENUM ('active','paused','completed','cancelled','failed');
CREATE TYPE mem.task_schedule_kind AS ENUM ('one_time','interval','cron','rrule');
CREATE TYPE mem.task_run_status    AS ENUM ('queued','running','success','failed','skipped');
```

В самой миграции каждый `CREATE TYPE` обёрнут в защищённый блок ради идемпотентности.

---

## [DATA-2] Пользователи и домены

`mem.users` хранит пользователей; `external_id` связывает запись с внешней системой (например, идентификатор в
мессенджере, CRM или системе авторизации); `timezone` нужен планировщику и темпоральному контексту. Колонку `is_admin`
(права на запись в глобальную память) добавляет миграция `005`, а мастер-переключатель проактивности
`proactivity_enabled` — миграция `007`. Колонку `reply_mode` (предпочитаемая форма ответа — текст или голос)
добавляет миграция `009`; это управляющая настройка пользователя, которую канал доставки читает на каждом ответе
(см. [MEM-8]).
`mem.agent_domains` описывает области контекста и предметной памяти агента; базовые домены засеваются прямо в миграции.
Домен используется для классификации, выборки памяти, схем `data`, тем и доменных глобальных фактов. Он не является
реестром публичных умений: наличие строки домена само по себе не означает, что бот умеет выполнять действие в этой
области. Реальные действия выводятся из доступных инструментов и явно описанных функций.

```sql
CREATE TABLE IF NOT EXISTS mem.users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id  text UNIQUE,
    display_name text,
    locale       text NOT NULL DEFAULT 'ru',
    timezone     text NOT NULL DEFAULT 'Europe/Moscow',
    is_admin     boolean NOT NULL DEFAULT false,    -- ручная пометка администратора (управление глобальной памятью)
    proactivity_enabled boolean NOT NULL DEFAULT false, -- мастер-переключатель проактивности пользователя (см. 09)
    reply_mode   text NOT NULL DEFAULT 'text'           -- предпочитаемая форма ответа: 'text' | 'voice' (см. [MEM-8])
                 CHECK (reply_mode IN ('text', 'voice')),
    metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

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
  ('joke_teller',   'Знаток анекдотов',        'Поиск свежих анекдотов в интернете и их рассказ'),
  ('math_tutor',    'Репетитор по математике', 'Темы, ошибки, прогресс ученика')
ON CONFLICT (domain_key) DO NOTHING;
```

Идентификатор пользователя: внутренний ключ — `mem.users.id` (UUID), внешний — `external_id`. Мультиюзерность заложена на
уровне данных: все таблицы памяти ссылаются на `user_id uuid`. Точка входа `handleMessage` принимает `external_id`, а
дальше работа идёт по внутреннему UUID.

---

## [DATA-3] Диалоги, сообщения и сводки

`mem.conversations` — отдельные диалоги; `current_state` хранит оперативное состояние задачи. `mem.conversation_messages`
— сырые сообщения; в промпт идут только последние несколько. `mem.conversation_summaries` хранит сжатую краткосрочную
память: резюме диалога плюс структурированное состояние.

```sql
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
CREATE INDEX IF NOT EXISTS idx_messages_user_created         ON mem.conversation_messages (user_id, created_at DESC);

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
```

Слой поджатия истории диалога наполняет именно `conversation_summaries`. Её служебные колонки определяет идемпотентная
миграция `003_history_summaries.sql` через `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`:
`layer` (`near` / `middle` / `far` / `full`), `covered_from_message_id`, `covered_to_message_id`, `covered_until`,
`source_message_count`, `source_token_count`, `summary_token_count`, `memory_dedupe`, `summary_version` и `is_active`
(в каждом диалоге активна ровно одна сводка). Число таблиц при этом остаётся шестнадцать.
Полный DDL миграции и смысл колонок — в [13-history-compression.md](13-history-compression.md).

---

## [DATA-4] Главная таблица памяти `memory_items`

Одна универсальная таблица закрывает и профильную, и предметную память. Различие задаёт поле `scope`: `profile`, `domain`,
`dialog`, `system`. Человекочитаемый текст факта — в `memory_text` (он попадает в промпт), структурированные данные домена
— в `data jsonb`. Столбец `search_tsv` — автоматический полнотекстовый вектор, `embedding` — вектор размерности 1536 для
смыслового поиска.

```sql
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
    status      mem.memory_status     NOT NULL DEFAULT 'active',
    source_conversation_id uuid REFERENCES mem.conversations(id)        ON DELETE SET NULL,
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
CREATE INDEX IF NOT EXISTS idx_memory_entity             ON mem.memory_items (user_id, domain_id, entity_type, entity_key);
CREATE INDEX IF NOT EXISTS idx_memory_expires            ON mem.memory_items (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_importance         ON mem.memory_items (user_id, importance DESC, updated_at DESC)
                                                          WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_memory_search_tsv         ON mem.memory_items USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_memory_data_gin           ON mem.memory_items USING gin (data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS idx_memory_embedding_hnsw     ON mem.memory_items USING hnsw (embedding vector_cosine_ops)
                                                          WHERE embedding IS NOT NULL;
```

Размерность `vector(1536)` соответствует модели `<EMBED_MODEL>`. Если векторный поиск не нужен, поле `embedding`
и HNSW-индекс можно убрать — система корректно откатывается на полнотекстовый и структурный поиск.

---

## [DATA-5] Защищённая память

Секретные данные хранятся в `mem.secure_records` в зашифрованном виде (`encrypted_payload bytea`), а в обычную память и
в промпт идёт только безопасное описание `redacted_summary`. Таблица `memory_secure_links` связывает безопасный факт с
секретной записью. Подробности работы — в [07-secure-privacy.md](07-secure-privacy.md).

```sql
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
    memory_item_id   uuid NOT NULL REFERENCES mem.memory_items(id)   ON DELETE CASCADE,
    secure_record_id uuid NOT NULL REFERENCES mem.secure_records(id) ON DELETE CASCADE,
    relation_type    text NOT NULL DEFAULT 'references',
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (memory_item_id, secure_record_id)
);
```

---

## [DATA-6] Планировщик: задачи, запуски, исходящие уведомления

`scheduled_tasks` хранит напоминания и фоновые проверки; главное поле — `next_run_at`. Поля `locked_by` и `locked_until`
обеспечивают безопасный захват задачи одним воркером. `scheduled_task_runs` хранит историю запусков,
`notification_outbox` — очередь сообщений пользователю (её же использует проактивный контур). Работа планировщика — в
[10-operations.md](10-operations.md).

```sql
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
```

---

## [DATA-7] Журнал инструментов и очередь записи памяти

`tool_calls` — журнал всех вызовов инструментов (вход, выход, статус, задержка, ошибка) для отладки, аудита и
безопасности. Таблица `memory_jobs` обслуживает очередь асинхронной записи памяти отдельным воркером; в
базовом контуре запись запускается после ответа неблокирующим промисом внутри процесса ответа.

```sql
CREATE TABLE IF NOT EXISTS mem.tool_calls (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid REFERENCES mem.conversations(id) ON DELETE SET NULL,
    user_id         uuid REFERENCES mem.users(id)         ON DELETE SET NULL,
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
```

Итого базовая схема — тринадцать таблиц: `users`, `agent_domains`, `conversations`, `conversation_messages`,
`conversation_summaries`, `memory_items`, `secure_records`, `memory_secure_links`, `scheduled_tasks`,
`scheduled_task_runs`, `notification_outbox`, `tool_calls`, `memory_jobs`.

---

## [DATA-8] Три таблицы проактивности (миграция `002_proactive.sql`)

Идемпотентная миграция `002_proactive.sql` определяет три таблицы проактивности. Назначение и поведение — в
[09-proactivity.md](09-proactivity.md).

```sql
-- Тематический трекинг (критерий 13): одна строка на пару «пользователь + домен + тема».
CREATE TABLE IF NOT EXISTS mem.topic_mentions (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id               uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    domain_id             uuid REFERENCES mem.agent_domains(id),
    topic_key             text NOT NULL,
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

-- Триггеры проактивности (критерии 15 и 16): набор триггеров на пользователя.
CREATE TABLE IF NOT EXISTS mem.proactive_triggers (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    domain_id     uuid REFERENCES mem.agent_domains(id),
    trigger_type  text NOT NULL,
    config        jsonb NOT NULL DEFAULT '{}'::jsonb,
    enabled       boolean NOT NULL DEFAULT true,
    last_fired_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, trigger_type)
);
CREATE INDEX IF NOT EXISTS idx_proactive_triggers_enabled ON mem.proactive_triggers (enabled) WHERE enabled = true;

-- Состояние контакта: общий анти-спам и реакция на молчание пользователя.
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

-- Журнал доставленных внешних событий (критерий 17): защита от повторной доставки.
CREATE TABLE IF NOT EXISTS mem.event_deliveries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    event_id        text NOT NULL,
    event_type      text NOT NULL DEFAULT 'news',
    relevance_score real,
    reason          text,
    delivered_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_event_deliveries_user ON mem.event_deliveries (user_id, delivered_at DESC);
```

Признак `enabled` отдельного триггера выбирает активные поводы, а мастер-переключатель `mem.users.proactivity_enabled`
(миграция `007_proactivity_flag.sql`) стоит над ним и управляет всем контуром у пользователя. Набор триггеров заводится
выключенным, когда пользователь включает проактивность. Таблица `proactive_contact_state` хранит общий режим контакта,
лимиты мягкой инициативы и состояние тишины; она не зависит от конкретного канала доставки. Подробности — в
[09-proactivity.md](09-proactivity.md).

Итого с проактивностью — семнадцать таблиц.

---

## [DATA-9] Две таблицы глобальной памяти (миграция `005_global_memory.sql`)

Идемпотентная миграция `005_global_memory.sql` добавляет колонку `is_admin` в `mem.users`, определяет две таблицы
глобальной памяти, общей для всех пользователей, и засевает базовый набор глобальных фактов. Назначение и поведение — в
[14-global-memory.md](14-global-memory.md).

```sql
-- Глобальные факты (критерий 19): always-on записи, видимые всем и подмешиваемые в каждый запрос.
CREATE TABLE IF NOT EXISTS mem.global_facts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id   uuid REFERENCES mem.agent_domains(id),    -- NULL = факт действует во всех доменах
    fact_text   text NOT NULL,
    priority    integer NOT NULL DEFAULT 100,             -- меньше число — выше при отборе под лимит
    enabled     boolean NOT NULL DEFAULT true,
    created_by  uuid REFERENCES mem.users(id) ON DELETE SET NULL,
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_global_facts_enabled ON mem.global_facts (enabled, priority) WHERE enabled = true;

-- Общая база знаний (критерий 20): корпус текстов, видимый всем, поиск по релевантности (вектор + полнотекст).
CREATE TABLE IF NOT EXISTS mem.global_knowledge (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id   uuid REFERENCES mem.agent_domains(id),    -- NULL = знание общее для всех доменов
    title       text,
    content     text NOT NULL,
    tags        text[] NOT NULL DEFAULT '{}',
    importance  numeric(3,2) NOT NULL DEFAULT 0.50 CHECK (importance >= 0 AND importance <= 1),
    status      mem.memory_status NOT NULL DEFAULT 'active',
    source      text,
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
```

Глобальные таблицы не содержат `user_id`: записи общие для всех. Запись закрыта правами администратора (пометка
`is_admin`), а секреты пользователей в глобальную память не попадают — они остаются в личной защищённой памяти.

---

## [DATA-10] Реестр схем `data` под домен (миграция `006`)

Таблица `mem.domain_schemas` хранит версионируемые определения схем `data` и правил канонизации `entity_key` по доменам.
Это источник истины во время выполнения: на каждый домен приходится не более одной активной версии (гарантирует
частичный уникальный индекс), а при сохранении новой версии прежняя активная уходит в архив. Подробно слой описан в
[11-per-domain-schema.md](11-per-domain-schema.md).

```sql
CREATE TABLE IF NOT EXISTS mem.domain_schemas (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_key  text NOT NULL,
    version     integer NOT NULL,
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','draft')),
    title       text NOT NULL,
    description text,
    definition  jsonb NOT NULL,        -- entities[].data_schema (закрытая JSON Schema) + словари entity_key
    created_by  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (domain_key, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_schemas_active
ON mem.domain_schemas (domain_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_domain_schemas_domain ON mem.domain_schemas (domain_key, version DESC);
```

## [DATA-11] Внешние ссылки сообщений (миграция `008`)

Таблица `mem.message_external_refs` связывает внутреннюю строку истории с сообщением во внешнем канале доставки. Она
нужна для событий, которые ссылаются на уже доставленное сообщение: реакции, прочтения, клики или другие канальные
события. Таблица остаётся канально-нейтральной: конкретный адаптер сам выбирает значение `channel` и формат внешних
идентификаторов.

```sql
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
```

Итого с глобальной памятью, реестром схем доменов и внешними ссылками сообщений — двадцать таблиц.

---

## Связанные документы

- Как используется память — [06-memory.md](06-memory.md)
- Защищённая память — [07-secure-privacy.md](07-secure-privacy.md)
- Планировщик и инструменты — [10-operations.md](10-operations.md)
- Проактивность — [09-proactivity.md](09-proactivity.md)
- Поджатие истории и миграция `003` — [13-history-compression.md](13-history-compression.md)
- Глобальная память и миграция `005` — [14-global-memory.md](14-global-memory.md)
