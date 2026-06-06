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
