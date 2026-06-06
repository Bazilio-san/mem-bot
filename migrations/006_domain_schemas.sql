-- migrations/006_domain_schemas.sql
-- Реестр версионированных схем data и правил канонизации entity_key по доменам.
-- Идемпотентно: повторный запуск безопасен. Базовые таблицы из 001_init.sql не затрагиваются.
-- Слой включается только для доменов, у которых есть сохранённая активная схема;
-- для прочих доменов запись памяти работает как раньше (свободный data, свободный entity_key).

CREATE TABLE IF NOT EXISTS mem.domain_schemas (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_key    text NOT NULL,                 -- совпадает с mem.agent_domains.domain_key
    version       integer NOT NULL,              -- растёт при каждом сохранении (save)
    status        text NOT NULL DEFAULT 'active' -- 'active' | 'archived' | 'draft'
                  CHECK (status IN ('active', 'archived', 'draft')),
    title         text NOT NULL,
    description   text,
    definition    jsonb NOT NULL,                -- полное определение домена (сущности, схемы data, правила ключа)
    created_by    text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (domain_key, version)
);

-- Не более одной активной версии на домен.
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_schemas_active
ON mem.domain_schemas (domain_key) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_domain_schemas_domain
ON mem.domain_schemas (domain_key, version DESC);

COMMENT ON TABLE mem.domain_schemas IS
  'Версионированные схемы data и правила канонизации entity_key по доменам.';
COMMENT ON COLUMN mem.domain_schemas.definition IS
  'JSON: entities[].data_schema (закрытая JSON Schema), правила entity_key (fixed_vocab/slug/free), примеры.';
