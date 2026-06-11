-- 002_user_facts.sql
-- Плоская таблица фактов о пользователе — основное хранилище долговременной памяти:
-- координаты хранения — пользователь, домен, тип факта.
-- Дедупликация — семантическая (embedding) внутри (user_id, fact_type); устаревание — expires_at;
-- ранжирование — confidence + свежесть + число подтверждений + надёжность источника.

CREATE TABLE IF NOT EXISTS mem.user_facts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES mem.users(id) ON DELETE CASCADE,

    -- Домен общения: 'general' для общечеловеческих фактов (профиль, стиль, привычки),
    -- ключ домена для предметных (цели и незакрытые линии конкретной специализации).
    domain_key  text NOT NULL DEFAULT 'general',

    -- Закрытый набор типов. Типы выбраны под задачу «бот — лучший собеседник»:
    --   profile             — базовые сведения (имя, семья, город, работа);
    --   preference          — вкусы и предпочтения;
    --   habit               — привычки и рутины;
    --   goal                — цели и долгосрочные задачи;
    --   emotional_pattern   — повторяющиеся эмоциональные паттерны;
    --   activity_rhythm     — ритм активности (когда пишет, когда занят);
    --   communication_style — стиль общения (короткие ответы, без официоза);
    --   open_loop           — незакрытые линии (события без финала) — всегда с TTL;
    --   topic_energy        — темы, где пользователь оживляется или гаснет;
    --   discovery_seed      — темы, которые хочет попробовать или изучить.
    fact_type   text NOT NULL CHECK (fact_type IN (
        'profile','preference','habit','goal','emotional_pattern','activity_rhythm',
        'communication_style','open_loop','topic_energy','discovery_seed')),

    fact_text   text NOT NULL,
    confidence  numeric(3,2) NOT NULL DEFAULT 0.80 CHECK (confidence >= 0 AND confidence <= 1),
    -- Сколько раз факт подтверждался повторными извлечениями: растёт при дедупликации-подтверждении.
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

