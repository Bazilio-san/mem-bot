-- migrations/005_global_memory.sql
-- Слой глобальной памяти: всегда-включённые глобальные факты и общая база знаний (RAG).
-- Идемпотентно: повторный запуск безопасен. Прежние таблицы не затрагиваются.
-- Подробности — в docs/ai-bot-with-memory/14-global-memory.md.

-- Ручная пометка администратора. Только администратор может наполнять и чистить глобальную память.
ALTER TABLE mem.users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

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
--    (сверка по тексту), поэтому повторный прогон миграции дублей не создаёт. Часть фактов — о самом
--    боте (создатель, имя), часть — общие утверждения, заданные создателем.
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
