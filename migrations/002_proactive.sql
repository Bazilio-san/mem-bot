-- migrations/002_proactive.sql
-- Расширение схемы памяти: тематический трекинг, триггеры проактивности, журнал доставленных событий.
-- Идемпотентно: повторный запуск безопасен. Базовые тринадцать таблиц не затрагиваются.

-- 1. Тематический трекинг (критерий 13). Одна строка на пару «пользователь + домен + тема».
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

-- 2. Триггеры проактивности (критерии 15 и 16). Набор триггеров на пользователя.
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

-- 3. Журнал доставленных внешних событий (критерий 17). Защита от повторной доставки одного события.
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
