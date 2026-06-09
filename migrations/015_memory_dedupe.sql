-- Смысловая дедупликация памяти: устойчивый ключ, каноническая группа и статус в группе.
-- Колонки идемпотентны, чтобы повторный прогон миграций был безопасен.

ALTER TABLE mem.memory_items
  ADD COLUMN IF NOT EXISTS dedupe_key text,
  ADD COLUMN IF NOT EXISTS canonical_group_id uuid,
  ADD COLUMN IF NOT EXISTS dedupe_status text NOT NULL DEFAULT 'candidate';

UPDATE mem.memory_items
   SET canonical_group_id = id,
       dedupe_status = CASE WHEN status = 'active' THEN 'canonical' ELSE dedupe_status END
 WHERE canonical_group_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_dedupe_key
  ON mem.memory_items (user_id, dedupe_key)
  WHERE status = 'active' AND dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_canonical_group
  ON mem.memory_items (user_id, canonical_group_id)
  WHERE canonical_group_id IS NOT NULL;
