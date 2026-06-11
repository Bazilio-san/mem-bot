-- 002_user_facts.sql
-- Новая плоская таблица фактов о пользователе. Заменяет mem.memory_items в качестве основного
-- хранилища долговременной памяти: координаты хранения — пользователь, домен, тип факта.
-- Дедупликация — семантическая (embedding) внутри (user_id, fact_type); устаревание — expires_at
-- (для open_loop задаётся всегда); ранжирование — confidence + свежесть + число подтверждений.
-- Старая таблица mem.memory_items не удаляется (аудит/история), но код её больше не пишет.

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

-- Разовый перенос активных нечувствительных фактов из mem.memory_items с маппингом типов и текстовой
-- дедупликацией (одинаковые формулировки одного пользователя и типа схлопываются в одну строку).
-- Повторный запуск миграции ничего не делает: переносим только если перенесённых строк ещё нет.
INSERT INTO mem.user_facts
    (user_id, domain_key, fact_type, fact_text, confidence, evidence_count, status,
     source_conversation_id, embedding, metadata, expires_at, last_confirmed_at, created_at, updated_at)
SELECT DISTINCT ON (mi.user_id, mapped.fact_type, lower(mi.memory_text))
    mi.user_id,
    CASE WHEN mi.scope = 'domain' THEN coalesce(ad.domain_key, 'general') ELSE 'general' END,
    mapped.fact_type,
    mi.memory_text,
    LEAST(mi.confidence, 0.99),
    GREATEST(1, LEAST(mi.usage_count, 10)),
    'active',
    mi.source_conversation_id,
    mi.embedding,
    jsonb_build_object('migrated_from', mi.id),
    CASE WHEN mapped.fact_type = 'open_loop' THEN coalesce(mi.expires_at, mi.updated_at + interval '30 days')
         ELSE mi.expires_at END,
    mi.updated_at,
    mi.created_at,
    mi.updated_at
FROM mem.memory_items mi
LEFT JOIN mem.agent_domains ad ON ad.id = mi.domain_id
CROSS JOIN LATERAL (
    SELECT CASE mi.memory_kind::text
        WHEN 'fact'                THEN 'profile'
        WHEN 'preference'          THEN 'preference'
        WHEN 'constraint'          THEN 'preference'
        WHEN 'goal'                THEN 'goal'
        WHEN 'history'             THEN 'profile'
        WHEN 'state'               THEN 'open_loop'
        WHEN 'progress'            THEN 'goal'
        WHEN 'instruction'         THEN 'communication_style'
        WHEN 'relationship'        THEN 'profile'
        WHEN 'emotional_pattern'   THEN 'emotional_pattern'
        WHEN 'activity_rhythm'     THEN 'activity_rhythm'
        WHEN 'communication_style' THEN 'communication_style'
        WHEN 'open_loop'           THEN 'open_loop'
        WHEN 'topic_energy'        THEN 'topic_energy'
        WHEN 'discovery_seed'      THEN 'discovery_seed'
        ELSE NULL
    END AS fact_type
) mapped
WHERE mi.status = 'active'
  AND mi.sensitivity IN ('public','low','normal')
  AND (mi.expires_at IS NULL OR mi.expires_at > now())
  AND mapped.fact_type IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM mem.user_facts WHERE metadata ? 'migrated_from')
ORDER BY mi.user_id, mapped.fact_type, lower(mi.memory_text), mi.updated_at DESC;
