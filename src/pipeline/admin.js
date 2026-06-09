// Управление памятью пользователем: просмотр, удаление одной записи, полное забывание.
// Удаление — мягкое (status='deleted'), чтобы запись исчезала из выборок, но оставался след.
import { query, vectorToSql } from '../db.js';
import { embed } from '../llm.js';

const SEMANTIC_DELETE_TOP_RELEVANCE = 0.5;
const SEMANTIC_DELETE_GROUP_RELEVANCE = 0.72;
const SEMANTIC_DELETE_AMBIGUOUS_RELEVANCE = 0.42;
const SEMANTIC_DELETE_AMBIGUOUS_DELTA = 0.06;
const SEMANTIC_DELETE_LIMIT = 8;

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
  await query(`UPDATE mem.memory_items SET status='deleted', updated_at=now() WHERE id = ANY($1) AND user_id = $2`, [
    ids,
    userId,
  ]);
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

function wantsTopicDelete(value) {
  const text = normalizeLookupText(value);
  return (
    /\b(all|everything|topic|related)\b/.test(text) ||
    /(^|\s)(все|всё|всю|вся|весь|связан|связанные|относящ)/i.test(text)
  );
}

function uniqueRowsById(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function formatMemoryCandidate(row) {
  return {
    id: row.id,
    entity_type: row.entity_type,
    entity_key: row.entity_key,
    memory_text: row.memory_text,
    relevance: Number(row.relevance),
  };
}

async function findSemanticDeleteCandidates(userId, text) {
  const vec = await embed(text);
  if (!vec) {
    return { semanticUnavailable: true, candidates: [] };
  }

  const { rows } = await query(
    `SELECT id, entity_type, entity_key, memory_text, 1 - (embedding <=> $2::vector) AS relevance
       FROM mem.memory_items
      WHERE user_id = $1 AND status = 'active' AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
      LIMIT $3`,
    [userId, vectorToSql(vec), SEMANTIC_DELETE_LIMIT],
  );
  return { semanticUnavailable: false, candidates: rows.map(formatMemoryCandidate) };
}

async function deleteBySemanticMatch(userId, rawName) {
  const { semanticUnavailable, candidates } = await findSemanticDeleteCandidates(userId, rawName);
  if (semanticUnavailable) {
    return { deleted: 0, items: [], semantic_unavailable: true };
  }
  if (!candidates.length) {
    return { deleted: 0, items: [] };
  }

  const topicDelete = wantsTopicDelete(rawName);
  if (topicDelete) {
    const strong = candidates.filter((r) => Number(r.relevance) >= SEMANTIC_DELETE_GROUP_RELEVANCE);
    if (!strong.length) {
      return { deleted: 0, items: [], candidates: candidates.slice(0, 3) };
    }
    return {
      ...(await softDeleteRows(userId, uniqueRowsById(strong))),
      strategy: 'semantic_group',
    };
  }

  const [top, second] = candidates;
  const topRelevance = Number(top.relevance);
  const secondRelevance = Number(second?.relevance || 0);

  if (
    second &&
    topRelevance >= SEMANTIC_DELETE_AMBIGUOUS_RELEVANCE &&
    secondRelevance >= topRelevance - SEMANTIC_DELETE_AMBIGUOUS_DELTA
  ) {
    return {
      deleted: 0,
      ambiguous: true,
      strategy: 'semantic',
      candidates: candidates.filter((r) => Number(r.relevance) >= topRelevance - SEMANTIC_DELETE_AMBIGUOUS_DELTA),
    };
  }

  if (topRelevance < SEMANTIC_DELETE_TOP_RELEVANCE) {
    return { deleted: 0, items: [], candidates: candidates.slice(0, 3) };
  }

  return {
    ...(await softDeleteRows(userId, [top])),
    strategy: 'semantic',
  };
}

// Мягко удалить записи памяти по названию сущности, идентификатору или тексту факта.
// Сначала проверяется UUID и точное совпадение memory_text: это покрывает сценарий, когда пользователь копирует
// строку из memory_list. Затем включается прежний поиск по entity_key/entity_type и безопасный fallback по тексту.
// Если точные методы ничего не нашли, последним шагом используется смысловой поиск по embedding с осторожными
// порогами: очевидный лучший кандидат удаляется, близкие варианты возвращаются как ambiguous.
// Сопоставление нечёткое и регистронезависимое: совпадение по ключу сущности (entity_key), по её типу,
// вхождение названия в ключ или текст факта. Параметр entityType уточняет тип, если названий несколько.
// Возвращает { deleted, items } — число помеченных удалёнными записей и их краткий перечень.
// Если тип не уточнён, а под название подходят записи РАЗНЫХ типов, удаление не выполняется: возвращается
// { deleted: 0, ambiguous: true, candidates }, чтобы агент уточнил у пользователя, что именно забыть.
export async function deleteByEntity(userId, entityName, entityType = null) {
  const rawName = String(entityName || '').trim();
  const name = normalizeLookupText(rawName);
  if (!name) {
    return { deleted: 0, items: [] };
  }

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
  if (exactTextRows.length > 0) {
    return softDeleteRows(userId, exactTextRows);
  }

  const params = [userId, name];
  let typeClause = '';
  if (entityType) {
    params.push(String(entityType).trim().toLowerCase());
    typeClause = "AND lower(coalesce(entity_type, '')) = $3";
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
  if (rows.length === 0) {
    return deleteBySemanticMatch(userId, rawName);
  }

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
