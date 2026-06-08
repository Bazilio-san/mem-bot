-- Виды памяти для режима собеседника: ритм, стиль, незакрытые линии и поводы для новых тем.
ALTER TYPE mem.memory_kind ADD VALUE IF NOT EXISTS 'emotional_pattern';
ALTER TYPE mem.memory_kind ADD VALUE IF NOT EXISTS 'activity_rhythm';
ALTER TYPE mem.memory_kind ADD VALUE IF NOT EXISTS 'communication_style';
ALTER TYPE mem.memory_kind ADD VALUE IF NOT EXISTS 'open_loop';
ALTER TYPE mem.memory_kind ADD VALUE IF NOT EXISTS 'topic_energy';
ALTER TYPE mem.memory_kind ADD VALUE IF NOT EXISTS 'discovery_seed';
