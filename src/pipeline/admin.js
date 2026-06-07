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

// Мягко удалить записи памяти по названию сущности (а не по идентификатору).
// Сопоставление нечёткое и регистронезависимое: совпадение по ключу сущности (entity_key), по её типу
// (entity_type) или вхождение названия в ключ. Параметр entityType уточняет тип, если названий несколько.
// Возвращает { deleted, items } — число помеченных удалёнными записей и их краткий перечень.
// Если тип не уточнён, а под название подходят записи РАЗНЫХ типов, удаление не выполняется: возвращается
// { deleted: 0, ambiguous: true, candidates }, чтобы агент уточнил у пользователя, что именно забыть.
export async function deleteByEntity(userId, entityName, entityType = null) {
  const name = String(entityName || '').trim().toLowerCase();
  if (!name) return { deleted: 0, items: [] };

  const params = [userId, name];
  let typeClause = '';
  if (entityType) {
    params.push(String(entityType).trim().toLowerCase());
    typeClause = 'AND lower(entity_type) = $3';
  }
  const { rows } = await query(
    `SELECT id, entity_type, entity_key, memory_text
       FROM mem.memory_items
      WHERE user_id = $1 AND status = 'active'
        AND (lower(entity_key) = $2 OR lower(entity_type) = $2 OR lower(entity_key) LIKE '%' || $2 || '%')
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
      candidates: rows.map((r) => ({ id: r.id, entity_type: r.entity_type, entity_key: r.entity_key })),
    };
  }

  const ids = rows.map((r) => r.id);
  await query(
    `UPDATE mem.memory_items SET status='deleted', updated_at=now() WHERE id = ANY($1) AND user_id = $2`,
    [ids, userId],
  );
  return {
    deleted: rows.length,
    items: rows.map((r) => ({ id: r.id, entity_type: r.entity_type, entity_key: r.entity_key })),
  };
}

// Является ли пользователь администратором (ручная пометка is_admin в БД).
// Только администратор может наполнять и чистить глобальную память (см. global-memory.js).
export async function isAdmin(userId) {
  const { rows } = await query('SELECT is_admin FROM mem.users WHERE id = $1', [userId]);
  return rows[0]?.is_admin === true;
}
