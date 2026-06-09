-- Источник схемы доменной памяти — файл domain-schema.json рядом со SKILL.md, загружаемый реестром skills.
-- Таблица mem.domain_schemas как хранилище схем во время выполнения больше не используется и удаляется.
DROP TABLE IF EXISTS mem.domain_schemas CASCADE;
