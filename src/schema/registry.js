// Реестр схем доменов: чтение активной схемы, сохранение новой версии, список доменов.
// Источник истины во время выполнения — таблица mem.domain_schemas; файлы schemas/*.draft.json
// служат только черновиком для ревью и в git, рантайм их не читает.
//
// Активная схема хранится в кэше процесса (по аналогии с domainCache в src/repo.js) и
// сбрасывается при каждом сохранении. Таблица реестра обязана существовать (миграция 006).
// Возврат null означает только одно: у домена ещё нет сохранённой активной схемы.
import { query } from '../db.js';
import { validateDefinition } from './meta.js';

// Кэш активной схемы по ключу домена. Значение: { version, definition } либо null.
const schemaCache = new Map();

// Сбросить кэш реестра. Вызывается после сохранения новой версии схемы.
export function invalidateSchemaCache(domainKey = null) {
  if (domainKey) schemaCache.delete(domainKey);
  else schemaCache.clear();
}

// Загрузить активное определение домена. Возвращает объект definition или null,
// если у домена нет активной схемы. Результат кэшируется.
export async function loadDomainDefinition(domainKey) {
  if (schemaCache.has(domainKey)) return schemaCache.get(domainKey)?.definition ?? null;
  const { rows } = await query(
    `SELECT version, definition FROM mem.domain_schemas
     WHERE domain_key = $1 AND status = 'active'
     ORDER BY version DESC LIMIT 1`,
    [domainKey],
  );
  const entry = rows[0] ? { version: rows[0].version, definition: rows[0].definition } : null;
  schemaCache.set(domainKey, entry);
  return entry?.definition ?? null;
}

// Номер активной версии схемы домена (для записи в metadata факта). null, если схемы нет.
export async function getActiveVersion(domainKey) {
  await loadDomainDefinition(domainKey); // наполнит кэш
  return schemaCache.get(domainKey)?.version ?? null;
}

// Спецификация конкретной сущности домена: правило ключа и закрытая схема data.
// Возвращает { entity_type, entity_key, data_schema } или null, если сущности нет в схеме.
export async function getEntitySpec(domainKey, entityType) {
  const definition = await loadDomainDefinition(domainKey);
  if (!definition || !entityType) return null;
  const entity = definition.entities.find((e) => e.entity_type === entityType);
  if (!entity) return null;
  return { entity_type: entity.entity_type, entity_key: entity.entity_key, data_schema: entity.data_schema };
}

// Сохранить определение домена новой активной версией.
// Валидирует определение по мета-схеме, вычисляет version = max + 1, в одной транзакции
// архивирует прежнюю активную версию, вставляет новую и при необходимости заводит строку
// домена в mem.agent_domains. Возвращает { version }.
export async function saveDomainDefinition(definition, { createdBy = null } = {}) {
  const { ok, issues } = validateDefinition(definition);
  if (!ok) {
    const err = new Error('Определение домена не прошло валидацию:\n- ' + issues.join('\n- '));
    err.issues = issues;
    throw err;
  }

  const domainKey = definition.domain_key;
  const { getPool } = await import('../db.js');
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    // Завести домен в реестре доменов, если его там ещё нет (как делает 001_init.sql для базовых).
    await client.query(
      `INSERT INTO mem.agent_domains (domain_key, title, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (domain_key) DO NOTHING`,
      [domainKey, definition.title, definition.description ?? null],
    );

    const { rows: maxRows } = await client.query(
      `SELECT COALESCE(max(version), 0) AS v FROM mem.domain_schemas WHERE domain_key = $1`,
      [domainKey],
    );
    const nextVersion = Number(maxRows[0].v) + 1;

    // Прежняя активная версия уходит в архив (частичный уникальный индекс допускает одну активную).
    await client.query(
      `UPDATE mem.domain_schemas SET status = 'archived'
       WHERE domain_key = $1 AND status = 'active'`,
      [domainKey],
    );

    await client.query(
      `INSERT INTO mem.domain_schemas (domain_key, version, status, title, description, definition, created_by)
       VALUES ($1, $2, 'active', $3, $4, $5, $6)`,
      [domainKey, nextVersion, definition.title, definition.description ?? null,
        JSON.stringify(definition), createdBy],
    );

    await client.query('COMMIT');
    invalidateSchemaCache(domainKey);
    return { version: nextVersion };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Список доменов с активными схемами: ключ, название, версия, перечень типов сущностей.
export async function listDomains() {
  const { rows } = await query(
    `SELECT domain_key, title, version, definition FROM mem.domain_schemas
     WHERE status = 'active' ORDER BY domain_key`,
  );
  return rows.map((r) => ({
    domain_key: r.domain_key,
    title: r.title,
    version: r.version,
    entity_types: (r.definition.entities || []).map((e) => e.entity_type),
  }));
}
