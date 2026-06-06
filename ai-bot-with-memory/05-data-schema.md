# 05. Схема данных PostgreSQL

## Вкратце

Вся память живёт в отдельной схеме `mem` выделенной базы `agent_mem`. Базовая миграция `001_init.sql` создаёт тринадцать
таблиц, типы и индексы; миграция `002_proactive.sql` добавляет три таблицы проактивности — итого шестнадцать. Обе
миграции идемпотентны (`CREATE ... IF NOT EXISTS`, защищённые `CREATE TYPE`). Используются расширения `pgcrypto` и
`pgvector`.

## Зачем отдельная схема и идемпотентность

Отдельная схема `mem` не смешивает память агента с прочими данными. Идемпотентность позволяет безопасно прогонять
миграцию повторно (важно для разработки и CI): объекты создаются через `IF NOT EXISTS`, а ENUM-типы — через защищённый
блок `DO $$ ... EXCEPTION WHEN duplicate_object THEN NULL; END $$;`.

---

## Расширения, схема и ENUM-типы

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS mem;

CREATE TYPE mem.memory_status     AS ENUM ('active','archived','deleted','pending_confirmation','rejected');
CREATE TYPE mem.sensitivity_level AS ENUM ('public','low','normal','high','secret');
CREATE TYPE mem.memory_kind       AS ENUM
  ('fact','preference','constraint','goal','history','state','progress','instruction','relationship',
   'reminder','secure_reference');
CREATE TYPE mem.task_status        AS ENUM ('active','paused','completed','cancelled','failed');
CREATE TYPE mem.task_schedule_kind AS ENUM ('one_time','interval','cron','rrule');
CREATE TYPE mem.task_run_status    AS ENUM ('queued','running','success','failed','skipped');
```

В самой миграции каждый `CREATE TYPE` обёрнут в защищённый блок ради идемпотентности.

---

## Пользователи и домены

`mem.users` хранит пользователей; `external_id` связывает запись с внешней системой (Telegram ID, CRM ID, идентификатор
авторизации); `timezone` нужен планировщику и темпоральному контексту. `mem.agent_domains` описывает специализации
агента; базовые домены засеваются прямо в миграции.

```sql
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
  ('travel',        'Поиск поездок',           'Авиабилеты, маршруты, документы, города'),
  ('landing_sales', 'Продажа лендингов',       'Лиды, возражения, ниши, сделки'),
  ('math_tutor',    'Репетитор по математике', 'Темы, ошибки, прогресс ученика')
ON CONFLICT (domain_key) DO NOTHING;
```

Идентификатор пользователя: внутренний ключ — `mem.users.id` (UUID), внешний — `external_id`. Мультиюзерность заложена на
уровне данных: все таблицы памяти ссылаются на `user_id uuid`. Точка входа `handleMessage` принимает `external_id`, а
дальше работа идёт по внутреннему UUID.

---

## Диалоги, сообщения и сводки

`mem.conversations` — отдельные диалоги; `current_state` хранит оперативное состояние задачи. `mem.conversation_messages`
— сырые сообщения; в промпт идут только последние несколько. `mem.conversation_summaries` — сжатая краткосрочная память
(резюме плюс состояние); таблица создана, но её наполнение суммаризатором отнесено к доделкам (🔜).

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

---

## Главная таблица памяти `memory_items`

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

Размерность `vector(1536)` соответствует модели `text-embedding-3-small`. Если векторный поиск не нужен, поле `embedding`
и HNSW-индекс можно убрать — система корректно откатывается на полнотекстовый и структурный поиск.

---

## Защищённая память

Секретные данные хранятся в `mem.secure_records` в зашифрованном виде (`encrypted_payload bytea`), а в обычную память и
в промпт идёт только безопасное описание `redacted_summary`. Таблица `memory_secure_links` связывает безопасный факт с
секретной записью (создана, в текущем коде ещё не используется, 🔜). Подробности работы — в
[07-secure-privacy.md](07-secure-privacy.md).

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

## Планировщик: задачи, запуски, исходящие уведомления

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

## Журнал инструментов и очередь записи памяти

`tool_calls` — журнал всех вызовов инструментов (вход, выход, статус, задержка, ошибка) для отладки, аудита и
безопасности. `memory_jobs` — очередь асинхронной записи памяти (создана для будущего выноса записи в отдельный воркер;
сейчас запись идёт промисом сразу после ответа, 🟡).

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

## Три таблицы проактивности (миграция `002_proactive.sql`)

Аддитивная идемпотентная миграция добавляет три таблицы, не меняя базовые. Назначение и поведение — в
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

Итого с проактивностью — шестнадцать таблиц.

---

## Связанные документы

- Как используется память — [06-memory.md](06-memory.md)
- Защищённая память — [07-secure-privacy.md](07-secure-privacy.md)
- Планировщик и инструменты — [10-operations.md](10-operations.md)
- Проактивность — [09-proactivity.md](09-proactivity.md)
