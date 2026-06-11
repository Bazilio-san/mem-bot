-- 004_drop_migration_source.sql
-- Тип источника 'migration' упразднён: ранее перенесённые строки становятся обычными высказываниями
-- пользователя, ограничение пересоздаётся без этого значения. Идемпотентно.

UPDATE mem.user_facts SET source = 'user_statement' WHERE source = 'migration';

ALTER TABLE mem.user_facts DROP CONSTRAINT IF EXISTS user_facts_source_check;
ALTER TABLE mem.user_facts ADD CONSTRAINT user_facts_source_check
    CHECK (source IN ('user_statement','user_reaction','history_summary','manual'));
