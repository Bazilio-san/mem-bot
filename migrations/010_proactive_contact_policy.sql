-- migrations/010_proactive_contact_policy.sql
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
