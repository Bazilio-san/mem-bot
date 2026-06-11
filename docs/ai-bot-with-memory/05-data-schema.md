# 05. PostgreSQL Data Schema

## [DATA-1] Extensions, Schema, and ENUM Types

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS mem;

CREATE TYPE mem.memory_status     AS ENUM ('active','archived','deleted','pending_confirmation','rejected');
CREATE TYPE mem.sensitivity_level AS ENUM ('public','low','normal','high','secret');
CREATE TYPE mem.task_status        AS ENUM ('active','paused','completed','cancelled','failed');
CREATE TYPE mem.task_schedule_kind AS ENUM ('one_time','interval','cron','rrule');
CREATE TYPE mem.task_run_status    AS ENUM ('queued','running','success','failed','skipped');
```

In the migration itself, each `CREATE TYPE` is wrapped in a guarded block for idempotency.

---

## [DATA-2] Users and Domains

`mem.users` stores users; `external_id` links a record to an external system (for example, a messenger ID, CRM, or
auth system); `timezone` is used by the scheduler and the temporal context. The `is_admin` column grants write access
to global memory. The master proactivity switch `proactivity_enabled` controls the entire proactive loop for the user.
`reply_mode` stores the preferred response format (text or voice), and `voice_output_voice` stores the chosen voice
timbre for audio replies — these are user-level control settings that the delivery channel reads on every response
(see [MEM-8]). The `is_test` column marks technical users created by automated tests: the `ensureUser` entry point
sets it based on the `NODE_ENV === 'test'` condition, so any user created during a test run (including ones created
implicitly via `handleMessage`) is marked as a test user; the flag is not re-set on an already existing user. This
marker is later used to selectively purge test data, including test entries in the model-call log under the `log`
schema (see [DATA-12]).

`mem.agent_domains` is a thin lookup table mapping `domain_key` to a numeric `domain_id` referenced by foreign keys
in the memory tables. The human-readable domain description lives in the skills registry (see
[11-per-domain-schema.md](11-per-domain-schema.md)); rows in this table are created by the skills `sync` command and
are not edited manually. The base `general` domain is seeded directly in the migration so that memory addressing
works from the very first run. The skill-authoring editor `skill-author` (domain `skill_author`) lives in the same
table as a regular domain — there are no separate tables for the skill-editing toolset. The presence of a domain row
does not by itself mean the bot can perform actions in that area: actual actions are derived from the tools available
in the active skill and from explicitly described functions.

```sql
CREATE TABLE IF NOT EXISTS mem.users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_id  text UNIQUE,
    display_name text,
    locale       text NOT NULL DEFAULT 'ru',
    timezone     text NOT NULL DEFAULT 'Europe/Moscow',
    is_admin     boolean NOT NULL DEFAULT false,    -- manual admin flag (controls global memory writes)
    proactivity_enabled boolean NOT NULL DEFAULT false, -- master proactivity switch for the user (see 09)
    reply_mode   text NOT NULL DEFAULT 'text'           -- preferred response format: 'text' | 'voice' (see [MEM-8])
                 CHECK (reply_mode IN ('text', 'voice')),
    voice_output_voice text                             -- chosen voice timbre for audio replies, or NULL = fallback
                 CHECK (voice_output_voice IS NULL OR voice_output_voice IN
                   ('alloy','ash','ballad','cedar','coral','marin','nova','fable','onyx','sage','verse')),
    is_test      boolean NOT NULL DEFAULT false,         -- technical user created by automated tests (NODE_ENV=test)
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
  ('general',       'General Assistant',    'Base domain with no narrow specialization'),
  ('joke_teller',   'Joke Teller',          'Searching for fresh jokes online and telling them'),
  ('math_tutor',    'Math Tutor',           'Topics, errors, and student progress')
ON CONFLICT (domain_key) DO NOTHING;
```

User identifier: the internal key is `mem.users.id` (UUID) and the external key is `external_id`. Multi-user support
is built into the data layer: all memory tables reference `user_id uuid`. The `handleMessage` entry point accepts
`external_id`; from that point on, all operations use the internal UUID.

---

## [DATA-3] Conversations, Messages, and Summaries

`mem.conversations` holds individual conversations; `current_state` stores the active task state.
`mem.conversation_messages` holds raw messages; only the most recent ones are included in the prompt. The
`metadata` of the user and assistant messages of a turn carries the turn's correlation `request_id`, which links
the dialog to the call and event journals in the logs database (see [DATA-12]).
`mem.conversation_summaries` stores compressed short-term memory: a conversation summary plus structured state.

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

The conversation history compression layer populates `conversation_summaries`. Its service columns are
`layer` (`near` / `middle` / `far` / `full`), `covered_from_message_id`, `covered_to_message_id`, `covered_until`,
`source_message_count`, `source_token_count`, `summary_token_count`, `memory_dedupe`, `summary_version`, and
`is_active` (exactly one summary is active per conversation). The full DDL and column descriptions are in
[13-history-compression.md](13-history-compression.md).

---

## [DATA-4] The Primary Memory Table `user_facts`

Long-term memory is a single flat table of facts about the user. Each row is one short human-readable
statement (`fact_text`) with three storage coordinates: the user (`user_id`), the conversation domain
(`domain_key`, with `'general'` holding facts about the person that are valid in any domain), and the fact
type (`fact_type`, a closed set of ten types oriented at conversational quality — see
[06-memory.md](06-memory.md)). There is no per-entity structured payload and no separate importance score:
ranking relies on `confidence`, freshness (`last_confirmed_at`), and the number of repeated confirmations
(`evidence_count`). The `search_tsv` column is an automatically generated full-text vector; `embedding` is a
1536-dimensional vector for semantic search and write-time deduplication. Aging is expressed by
`expires_at` (always set for `open_loop` facts and refreshed when the fact is re-confirmed).

```sql
CREATE TABLE IF NOT EXISTS mem.user_facts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    domain_key  text NOT NULL DEFAULT 'general',
    fact_type   text NOT NULL CHECK (fact_type IN (
        'profile','preference','habit','goal','emotional_pattern','activity_rhythm',
        'communication_style','open_loop','topic_energy','discovery_seed')),
    fact_text   text NOT NULL,
    confidence  numeric(3,2) NOT NULL DEFAULT 0.80 CHECK (confidence >= 0 AND confidence <= 1),
    evidence_count integer NOT NULL DEFAULT 1,
    status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
    source_conversation_id uuid REFERENCES mem.conversations(id) ON DELETE SET NULL,
    embedding   vector(1536),
    search_tsv  tsvector GENERATED ALWAYS AS (to_tsvector('simple', fact_text)) STORED,
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    expires_at        timestamptz,
    last_confirmed_at timestamptz NOT NULL DEFAULT now(),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_facts_lookup    ON mem.user_facts (user_id, status, domain_key, fact_type);
CREATE INDEX IF NOT EXISTS idx_user_facts_rank      ON mem.user_facts (user_id, confidence DESC, last_confirmed_at DESC)
                                                    WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_user_facts_expires   ON mem.user_facts (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_facts_tsv       ON mem.user_facts USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_user_facts_embedding ON mem.user_facts USING hnsw (embedding vector_cosine_ops)
                                                    WHERE embedding IS NOT NULL;
```

The `vector(1536)` dimensionality matches the `<EMBED_MODEL>` model. If vector search is not needed, the `embedding`
field and the HNSW index can be removed — the system gracefully falls back to full-text and structural search, and
write-time deduplication degrades to exact-text matching.

Deduplication works at write time and leaves an audit trail in `metadata`: a confirming write bumps
`evidence_count` and `last_confirmed_at` on the existing row; a replacing write archives the old row with
`metadata.replaced_by` and stores `metadata.replaces` on the new one; the background sweep merges residual
duplicates and marks archived rows with `metadata.merged_into`.

---

## [DATA-5] Secure Memory

Secret data is stored in `mem.secure_records` in encrypted form (`encrypted_payload bytea`), while only the safe
description `redacted_summary` is included in the prompt. The table is self-contained: secure records carry their
own addressing (`record_type`, `subject_key`, `display_name`) and are never linked to rows in `user_facts`. For
details on how this works, see [07-secure-privacy.md](07-secure-privacy.md).

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
```

---

## [DATA-6] Scheduler: Tasks, Runs, and Outbound Notifications

`scheduled_tasks` stores reminders and background checks; the key field is `next_run_at`. The `locked_by` and
`locked_until` fields provide safe exclusive acquisition of a task by a single worker. `scheduled_task_runs` stores
the run history, and `notification_outbox` holds the message queue for the user (the proactive loop also uses it).
The scheduler's behavior is described in [10-operations.md](10-operations.md).

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

## [DATA-7] Tool Call Log and Memory Write Queue

`tool_calls` is a log of all tool invocations (input, output, status, latency, error) for debugging, auditing, and
security purposes. The `memory_jobs` table serves the asynchronous memory write queue, processed by a separate
worker; in the basic flow, writing is triggered after the response as a non-blocking promise inside the response
process.

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

The base schema totals twelve tables: `users`, `agent_domains`, `conversations`, `conversation_messages`,
`conversation_summaries`, `user_facts`, `secure_records`, `scheduled_tasks`, `scheduled_task_runs`,
`notification_outbox`, `tool_calls`, `memory_jobs`.

---

## [DATA-8] Proactivity Tables

The initialization schema defines the proactivity tables. Their purpose and behavior are described in
[09-proactivity.md](09-proactivity.md).

```sql
-- Topic tracking (criterion 13): one row per user + domain + topic combination.
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

-- Proactive triggers (criteria 15 and 16): a set of triggers per user.
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

-- Contact state: global anti-spam and reaction to user silence.
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

-- Log of delivered external events (criterion 17): protection against duplicate delivery.
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

The `enabled` flag on an individual trigger selects active reasons for outreach, while the master switch
`mem.users.proactivity_enabled` sits above it and controls the entire proactive loop for the user. The set of
triggers is created in a disabled state when the user enables proactivity. The `proactive_contact_state` table stores
the overall contact mode; see [09-proactivity.md](09-proactivity.md).

With proactivity, the total is sixteen tables.

---

## [DATA-9] Two Global Memory Tables

The initialization schema adds the `is_admin` column to `mem.users`, defines two global memory tables shared by all
users, and seeds a base set of global facts. Purpose and behavior are described in
[14-global-memory.md](14-global-memory.md).

```sql
-- Global facts (criterion 19): always-on records visible to all users, injected into every request.
CREATE TABLE IF NOT EXISTS mem.global_facts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id   uuid REFERENCES mem.agent_domains(id),    -- NULL = fact applies across all domains
    fact_text   text NOT NULL,
    priority    integer NOT NULL DEFAULT 100,             -- lower number = higher priority when trimming to limit
    enabled     boolean NOT NULL DEFAULT true,
    created_by  uuid REFERENCES mem.users(id) ON DELETE SET NULL,
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_global_facts_enabled ON mem.global_facts (enabled, priority) WHERE enabled = true;

-- Shared knowledge base (criterion 20): a corpus of texts visible to all users, searched by relevance (vector + full-text).
CREATE TABLE IF NOT EXISTS mem.global_knowledge (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id   uuid REFERENCES mem.agent_domains(id),    -- NULL = knowledge applies across all domains
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

The global tables contain no `user_id`: records are shared across all users. Writes are restricted to users with the
`is_admin` flag, and user secrets never enter global memory — they remain in the user's personal secure memory.

---

## [DATA-10] Domain Entity Schemas

The closed per-domain entity schemas are not stored in the database — each lives in a file alongside its skill
(`skills/<name>/domain-schema.json`) and is loaded by the skills registry at startup. These schemas describe the
subject entities of a domain for the skill-authoring toolset (generation, surgical edits, and meta-validation of
skills); they do not participate in the memory write or read paths — long-term memory stores flat facts in
`mem.user_facts` ([DATA-4]). The layer is described in detail in [11-per-domain-schema.md](11-per-domain-schema.md).

## [DATA-11] Message External References

The `mem.message_external_refs` table links an internal history row to a message in an external delivery channel.
It is needed for events that reference an already-delivered message: reactions, read receipts, clicks, or other
channel events. The table remains channel-neutral: each concrete adapter chooses its own `channel` value and the
format of external identifiers.

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

With global memory, message external references, and user notes ([DATA-13]), the total is twenty tables in the
`mem` schema.

---

## [DATA-12] LLM Call Log (the separate logs database)

Every call to a language model (LLM — large language model) and to related services (embedding generation,
speech-to-text transcription, and text-to-speech synthesis) is recorded in the `log` schema of a **separate
logs database** (a second PostgreSQL database alongside the working memory database; connection
`config.db.postgres.dbs.logs`, default name `mem_bot_logs`). Keeping the journals apart from user data gives them
independent backups and an age-based retention policy, and their fast growth does not bloat the memory database.
The journal tables reference users and conversations only by textual identifiers — there are no foreign keys
into the `mem` schema and no cascades, so the log survives user deletion. Because the two databases cannot be
joined in SQL, consumers merge their data in application code.

The log consists of three tables. The full `log.llm_request` stores the entire context of a call — the request
type `request_kind`, the endpoint, provider and model, the request body in `payload` and the model's reply in
`response` (for binary data such as audio — only file metadata in `binary_meta`, without the content; for
embeddings — only the vector shape, never the vectors themselves), the number of input and output tokens, the
calculated cost in US dollars, duration, and correlation identifiers. The narrow `log.llm_usage` contains only
what is needed for fast cost aggregation, and it is populated automatically by the `log.llm_request_to_usage`
trigger after each insert into the full table — but only when there is something to count (tokens or price are
known), so that failed calls do not pollute the aggregates. The third table, `log.agent_event`, journals agent
events of a conversation turn — pipeline stages, tool calls with their arguments and results, connections to
external tool servers, and failures — so that together with `log.llm_request` it reconstructs the exhaustive
timeline of one "user phrase → answer" cycle. For log behavior, batch export, retention, and cost calculation,
see [10-operations.md](10-operations.md), section [OPS-5].

The correlation identifier `request_id` groups all journal rows of one conversation turn and is also written
into the `metadata` of the turn's saved dialog messages (`mem.conversation_messages`), so a log viewer can open
the full journal of the cycle behind any message. Journal rows whose `request_id` is not referenced by any user
message represent background and post-processing calls (history compression, proactivity, detached embeddings).

```sql
CREATE SCHEMA IF NOT EXISTS log;

-- Full log: one row per call to a model or related service.
CREATE TABLE IF NOT EXISTS log.llm_request (
  llm_request_id    bigserial PRIMARY KEY,
  created_at        timestamptz NOT NULL DEFAULT now(),
  request_id        text,                              -- correlation identifier for a single conversation turn
  request_kind      text,                              -- purpose of the call (see below)
  endpoint          text,                              -- chat.completions, embeddings, audio.transcriptions, audio.speech
  provider          text,
  model             text,                              -- model name as returned by the call
  model_priced      text,                              -- model name used to look up the price in the rate card
  user_id           text,
  conversation_id   text,
  domain_key        text,
  channel           text,
  is_binary         boolean NOT NULL DEFAULT false,    -- call with a binary body (audio)
  payload           jsonb,                             -- request body; truncated to config.llmLog.maxPayloadChars
  response          jsonb,                             -- model reply; same truncation limit as payload
  binary_meta       jsonb,                             -- for audio: file metadata only, no content
  payload_truncated boolean NOT NULL DEFAULT false,    -- payload was truncated at the length limit
  response_truncated boolean NOT NULL DEFAULT false,   -- response was truncated at the length limit
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,
  price_usd         numeric(12,6),                     -- call cost; NULL if the model is not in the rate card
  duration_ms       integer,
  status            text NOT NULL DEFAULT 'ok',
  error             text,
  is_test           boolean NOT NULL DEFAULT false     -- record from a test run (NODE_ENV=test)
);

-- Narrow log: only tokens and cost for fast cost aggregates.
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

-- Trigger mirrors the billing portion into the narrow log, but only when there is something to count.
CREATE OR REPLACE FUNCTION log.llm_request_to_usage() RETURNS trigger AS $$
BEGIN
  IF NEW.total_tokens IS NOT NULL OR NEW.price_usd IS NOT NULL THEN
    INSERT INTO log.llm_usage (created_at, llm_request_id, request_kind, model, user_id,
                               prompt_tokens, completion_tokens, total_tokens, price_usd, duration_ms, is_test)
    VALUES (NEW.created_at, NEW.llm_request_id, NEW.request_kind, NEW.model_priced, NEW.user_id,
            NEW.prompt_tokens, NEW.completion_tokens, NEW.total_tokens, NEW.price_usd, NEW.duration_ms, NEW.is_test);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER llm_request_to_usage_trg AFTER INSERT ON log.llm_request
  FOR EACH ROW EXECUTE FUNCTION log.llm_request_to_usage();

-- Agent event journal: pipeline stages, tool calls with arguments and results, external-server connections.
CREATE TABLE IF NOT EXISTS log.agent_event (
  agent_event_id  bigserial PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  request_id      text,                                -- same correlation identifier as in log.llm_request
  user_id         text,
  conversation_id text,
  event_type      text NOT NULL,                       -- taxonomy below
  title           text,                                -- ready-made human-readable row title
  data            jsonb,                               -- arguments/result/details; same truncation limit as payload
  duration_ms     integer,                             -- for *.completed events — duration since the paired start
  status          text NOT NULL DEFAULT 'ok',          -- ok | error
  error           text,
  is_test         boolean NOT NULL DEFAULT false
);
```

The `request_kind` field distinguishes the purposes of calls: `main_agent_answer` (the agent's main response),
`delivery_intent` (choosing the delivery format — text or reaction), `intent_classify`, `fact_extract`,
`topic_extract`, `event_relevance`, `proactive_message`, `history_compress`, `skill_authoring`, `voice_summary`,
`embedding`, `stt`, `tts`, `log_analysis` (an operator-initiated analysis of a logged request). For endpoints with
a strictly single purpose (embeddings, speech recognition, and synthesis), the kind is derived from the endpoint
itself. The `chat.completions` endpoint has many purposes, so the calling code must pass the kind explicitly; an
omission is marked with the special kind `untyped` and serves as a signal of a call-site error.

The `event_type` taxonomy of `log.agent_event` mirrors the turn's event contract: `agent.started`,
`stage.started`, `tool.started`, `tool.completed`, `mcp.connected`, `mcp.failed`, `assistant.completed`,
`agent.completed`, `agent.failed`. Unlike the display-channel events delivered through `onEvent`, which
deliberately omit tool arguments, the journal does store the full arguments and results of tool calls — it is
read only by the operator tooling. Streaming text deltas are not journaled; the final text arrives with
`assistant.completed`.

In both journal tables `created_at` is set by the writing code at the moment the record is built, not by the
database default at insert time: records are flushed in batches, and a whole batch would otherwise share one
insertion timestamp, destroying the ordering of a cycle's timeline.

The logs database has its own initialization (a dedicated migrations directory applied by the same migration
runner as the memory database). Its tables are never dropped on re-initialization (`CREATE TABLE IF NOT EXISTS`);
otherwise the log would be wiped on every startup.

---

---

## [DATA-13] User Notes

The `mem.notes` table stores personal user notes served by the notes subsystem ([15-notes.md](15-notes.md)):
LLM tools, the interactive widget, and the widget REST API all work through this one table. The primary key is a
numeric identity (not a uuid like the rest of the schema) because the note number is user-facing: it is shown in
the widget and pronounced by the agent («заметка #15»). Deletion is soft (`deleted_at`), which powers the undo
button of the widget. Title and body carry separate embeddings — search takes the best of the two cosine
distances; the generated `search_tsv` uses the `russian` dictionary with the title weighted above the body.

```sql
CREATE TABLE IF NOT EXISTS mem.notes (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,
    title           text NOT NULL DEFAULT '',
    body            text NOT NULL,
    tags            text[] NOT NULL DEFAULT '{}',
    pinned          boolean NOT NULL DEFAULT false,
    title_embedding vector(1536),
    body_embedding  vector(1536),
    search_tsv      tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('russian', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('russian', coalesce(body, '')), 'B')
    ) STORED,
    deleted_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notes_user_feed
    ON mem.notes (user_id, pinned DESC, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notes_search_tsv      ON mem.notes USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_notes_tags            ON mem.notes USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_notes_title_emb_hnsw  ON mem.notes
    USING hnsw (title_embedding vector_cosine_ops) WHERE title_embedding IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_body_emb_hnsw   ON mem.notes
    USING hnsw (body_embedding vector_cosine_ops) WHERE body_embedding IS NOT NULL;
```
