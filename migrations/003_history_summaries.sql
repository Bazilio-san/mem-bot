-- migrations/003_history_summaries.sql
-- Поджатие старой части истории диалога: дополнительные поля таблицы сводок mem.conversation_summaries.
-- Сама таблица создана в 001_init.sql. Эта миграция только добавляет недостающие колонки и индексы.
-- Идемпотентно: повторный запуск безопасен (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).

ALTER TABLE mem.conversation_summaries
  -- Слой дайджеста. При зонировании активна одна строка 'full'; при послойном досжатии — near/middle/far.
  ADD COLUMN IF NOT EXISTS layer text NOT NULL DEFAULT 'full'
    CHECK (layer IN ('near','middle','far','full')),
  -- Границы покрытой холодной зоны: от какого до какого сообщения и до какого момента времени.
  ADD COLUMN IF NOT EXISTS covered_from_message_id uuid,
  ADD COLUMN IF NOT EXISTS covered_to_message_id   uuid,
  ADD COLUMN IF NOT EXISTS covered_until           timestamptz,
  -- Сколько сообщений и токенов исходной холодной зоны вошло в дайджест (считается нашим кодом).
  ADD COLUMN IF NOT EXISTS source_message_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source_token_count   integer NOT NULL DEFAULT 0,
  -- Итоговый размер дайджеста в токенах (для контроля порога HISTORY_SHRINK_TOKENS).
  ADD COLUMN IF NOT EXISTS summary_token_count  integer NOT NULL DEFAULT 0,
  -- Какие факты не вошли в историю, потому что уже есть в долговременной памяти.
  ADD COLUMN IF NOT EXISTS memory_dedupe jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Версия записи дайджеста и признак активности (активна только последняя сводка диалога).
  ADD COLUMN IF NOT EXISTS summary_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Быстрый доступ к активной сводке диалога.
CREATE INDEX IF NOT EXISTS idx_summaries_active_conversation
  ON mem.conversation_summaries (conversation_id, created_at DESC)
  WHERE is_active = true;

-- Поиск по покрытому моменту времени (для определения непокрытой холодной зоны).
CREATE INDEX IF NOT EXISTS idx_summaries_covered_until
  ON mem.conversation_summaries (conversation_id, covered_until DESC);
