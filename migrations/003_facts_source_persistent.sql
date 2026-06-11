-- 003_facts_source_persistent.sql
-- Доработка модели факта: тип источника и закрепление («запомни навсегда»).
-- Идемпотентно: повторный запуск ничего не меняет.

-- Тип источника факта: кто/что его породило. Влияет на ранжирование и на разрешение конфликтов
-- (замещение разрешено, только если ранг нового источника не ниже ранга старого):
--   manual          — явная просьба пользователя запомнить (инструмент memory_pin);
--   user_statement  — прямое высказывание пользователя (основной путь извлечения);
--   user_reaction   — реакция пользователя на сообщение ассистента;
--   history_summary — факт, восстановленный суммаризатором при сжатии истории;
--   migration       — перенос из старого хранилища mem.memory_items.
ALTER TABLE mem.user_facts
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'user_statement'
        CHECK (source IN ('user_statement','user_reaction','history_summary','migration','manual'));

-- Закрепление: пользователь явно попросил помнить. Закреплённый факт не получает expires_at,
-- его не трогает фоновый sweep, автозамещение требует источника ранга user_statement и выше.
ALTER TABLE mem.user_facts
    ADD COLUMN IF NOT EXISTS persistent boolean NOT NULL DEFAULT false;

-- Бэкфилл: строки, перенесённые миграцией 002 из mem.memory_items, помечаются источником 'migration'.
UPDATE mem.user_facts
   SET source = 'migration'
 WHERE metadata ? 'migrated_from' AND source = 'user_statement';

-- Семантика expires_at: это момент ЗАБЫВАНИЯ (retention), а не момент, когда факт перестаёт быть
-- истинным. Срок вычисляется при записи из facts.retention конфига по типу факта; подтверждение
-- факта продлевает срок от текущего момента.
COMMENT ON COLUMN mem.user_facts.expires_at IS
    'Момент забывания (retention), а не окончания истинности факта. NULL — бессрочно. '
    'Вычисляется из facts.retention по типу факта; подтверждение продлевает срок.';
