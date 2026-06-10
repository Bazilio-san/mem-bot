-- Заметки пользователя с семантическим поиском (инструментарий notes + виджет).
-- Идемпотентна: src/migrate.js прогоняет все .sql каждый раз, поэтому только IF NOT EXISTS.
--
-- Решения схемы:
--   * id — bigint identity, а не uuid, как в остальной схеме mem: номер заметки показывается человеку
--     («заметка #15») и упоминается LLM в диалоге, короткое число здесь практичнее непроизносимого uuid;
--   * отдельные эмбеддинги заголовка и тела — поиск берёт лучшее (меньшее) из двух косинусных расстояний,
--     поэтому короткий точный заголовок не «разбавляется» длинным телом;
--   * мягкое удаление через deleted_at (вместо флага) — само время удаления нужно кнопке «Отменить»
--     в виджете и потенциальной фоновой чистке старых удалённых заметок;
--   * search_tsv на словаре russian (а не simple, как в mem.memory_items): заметки — живой русский текст,
--     морфология здесь повышает полноту полнотекстовой ветки гибридного поиска.

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

-- Лента активных заметок пользователя: закреплённые сверху, дальше по свежести (курсорная пагинация).
CREATE INDEX IF NOT EXISTS idx_notes_user_feed
    ON mem.notes (user_id, pinned DESC, updated_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notes_search_tsv      ON mem.notes USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_notes_tags            ON mem.notes USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_notes_title_emb_hnsw  ON mem.notes
    USING hnsw (title_embedding vector_cosine_ops) WHERE title_embedding IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_body_emb_hnsw   ON mem.notes
    USING hnsw (body_embedding vector_cosine_ops) WHERE body_embedding IS NOT NULL;
