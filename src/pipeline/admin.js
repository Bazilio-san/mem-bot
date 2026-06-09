// Управление памятью пользователем: просмотр, удаление одной записи, полное забывание.
// Удаление — мягкое (status='deleted'), чтобы запись исчезала из выборок, но оставался след.
import { query } from '../db.js';

export async function listMemory(userId, { includeArchived = false } = {}) {
  const { rows } = await query(
    `SELECT id, scope, memory_kind, entity_type, entity_key, memory_text, importance, sensitivity, status
     FROM mem.memory_items
     WHERE user_id = $1 AND ($2 OR status = 'active')
     ORDER BY updated_at DESC`,
    [userId, includeArchived],
  );
  return rows;
}

// Удалить одну запись памяти (мягко).
export async function deleteMemory(userId, memoryId) {
  const { rowCount } = await query(
    `UPDATE mem.memory_items SET status='deleted', updated_at=now() WHERE id=$1 AND user_id=$2`,
    [memoryId, userId],
  );
  return rowCount > 0;
}

// Забыть всё об активной памяти пользователя.
export async function forgetAll(userId) {
  const { rowCount } = await query(
    `UPDATE mem.memory_items SET status='deleted', updated_at=now() WHERE user_id=$1 AND status='active'`,
    [userId],
  );
  return rowCount;
}

function normalizeLookupText(value) {
  return String(value || '')
    .trim()
    .replace(/^[\s"'«»“”„`]+|[\s"'«»“”„`]+$/g, '')
    .toLowerCase();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function softDeleteRows(userId, rows) {
  const ids = rows.map((r) => r.id);
  await query(
    `UPDATE mem.memory_items SET status='deleted', updated_at=now() WHERE id = ANY($1) AND user_id = $2`,
    [ids, userId],
  );
  return {
    deleted: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      entity_type: r.entity_type,
      entity_key: r.entity_key,
      memory_text: r.memory_text,
    })),
  };
}

// Мягко удалить записи памяти по названию сущности, идентификатору или тексту факта.
// Сначала проверяется UUID и точное совпадение memory_text: это покрывает сценарий, когда пользователь копирует
// строку из memory_list. Затем включается прежний поиск по entity_key/entity_type и безопасный fallback по тексту.
// Сопоставление нечёткое и регистронезависимое: совпадение по ключу сущности (entity_key), по её типу,
// вхождение названия в ключ или текст факта. Параметр entityType уточняет тип, если названий несколько.
// Возвращает { deleted, items } — число помеченных удалёнными записей и их краткий перечень.
// Если тип не уточнён, а под название подходят записи РАЗНЫХ типов, удаление не выполняется: возвращается
// { deleted: 0, ambiguous: true, candidates }, чтобы агент уточнил у пользователя, что именно забыть.
export async function deleteByEntity(userId, entityName, entityType = null) {
  const rawName = String(entityName || '').trim();
  const name = normalizeLookupText(rawName);
  if (!name) return { deleted: 0, items: [] };

  if (isUuid(rawName)) {
    const { rows } = await query(
      `SELECT id, entity_type, entity_key, memory_text
         FROM mem.memory_items
        WHERE user_id = $1 AND status = 'active' AND id = $2`,
      [userId, rawName],
    );
    return rows.length ? softDeleteRows(userId, rows) : { deleted: 0, items: [] };
  }

  const { rows: exactTextRows } = await query(
    `SELECT id, entity_type, entity_key, memory_text
       FROM mem.memory_items
      WHERE user_id = $1 AND status = 'active' AND lower(memory_text) = $2
      ORDER BY updated_at DESC`,
    [userId, name],
  );
  if (exactTextRows.length > 0) return softDeleteRows(userId, exactTextRows);

  const params = [userId, name];
  let typeClause = '';
  if (entityType) {
    params.push(String(entityType).trim().toLowerCase());
    typeClause = 'AND lower(coalesce(entity_type, \'\')) = $3';
  }
  const { rows } = await query(
    `SELECT id, entity_type, entity_key, memory_text
       FROM mem.memory_items
      WHERE user_id = $1 AND status = 'active'
        AND (
          lower(coalesce(entity_key, '')) = $2
          OR lower(coalesce(entity_type, '')) = $2
          OR lower(coalesce(entity_key, '')) LIKE '%' || $2 || '%'
          OR lower(memory_text) LIKE '%' || $2 || '%'
        )
        ${typeClause}
      ORDER BY updated_at DESC`,
    params,
  );
  if (rows.length === 0) return { deleted: 0, items: [] };

  const types = [...new Set(rows.map((r) => r.entity_type))];
  if (!entityType && types.length > 1) {
    return {
      deleted: 0,
      ambiguous: true,
      candidates: rows.map((r) => ({
        id: r.id,
        entity_type: r.entity_type,
        entity_key: r.entity_key,
        memory_text: r.memory_text,
      })),
    };
  }

  return softDeleteRows(userId, rows);
}

// Является ли пользователь администратором (ручная пометка is_admin в БД).
// Только администратор может наполнять и чистить глобальную память (см. global-memory.js).
export async function isAdmin(userId) {
  const { rows } = await query('SELECT is_admin FROM mem.users WHERE id = $1', [userId]);
  return rows[0]?.is_admin === true;
}
