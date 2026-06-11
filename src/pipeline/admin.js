// User-facing memory management над таблицей фактов mem.user_facts: просмотр, удаление одной записи,
// полное забывание. Удаление мягкое (status='deleted') — запись исчезает из выборок, но след остаётся.
import { query, vectorToSql } from '../db.js';
import { embed } from '../llm.js';

const SEMANTIC_DELETE_TOP_RELEVANCE = 0.5;
const SEMANTIC_DELETE_GROUP_RELEVANCE = 0.72;
const SEMANTIC_DELETE_AMBIGUOUS_RELEVANCE = 0.42;
const SEMANTIC_DELETE_AMBIGUOUS_DELTA = 0.06;
const SEMANTIC_DELETE_LIMIT = 8;

export async function listMemory(userId, { includeArchived = false } = {}) {
  const { rows } = await query(
    `SELECT id, domain_key, fact_type, fact_text, confidence, evidence_count, status, last_confirmed_at
       FROM mem.user_facts
      WHERE user_id = $1 AND ($2 OR status = 'active')
      ORDER BY updated_at DESC`,
    [userId, includeArchived],
  );
  return rows;
}

// Delete a single fact (soft).
export async function deleteMemory(userId, factId) {
  const { rowCount } = await query(
    `UPDATE mem.user_facts SET status='deleted', updated_at=now() WHERE id=$1 AND user_id=$2`,
    [factId, userId],
  );
  return rowCount > 0;
}

// Forget everything in the user's active memory.
export async function forgetAll(userId) {
  const { rowCount } = await query(
    `UPDATE mem.user_facts SET status='deleted', updated_at=now() WHERE user_id=$1 AND status='active'`,
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
  await query(`UPDATE mem.user_facts SET status='deleted', updated_at=now() WHERE id = ANY($1) AND user_id = $2`, [
    ids,
    userId,
  ]);
  return {
    deleted: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      fact_type: r.fact_type,
      fact_text: r.fact_text,
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

function formatFactCandidate(row) {
  return {
    id: row.id,
    fact_type: row.fact_type,
    fact_text: row.fact_text,
    relevance: Number(row.relevance),
  };
}

async function findSemanticDeleteCandidates(userId, text) {
  const vec = await embed(text);
  if (!vec) {
    return { semanticUnavailable: true, candidates: [] };
  }

  const { rows } = await query(
    `SELECT id, fact_type, fact_text, 1 - (embedding <=> $2::vector) AS relevance
       FROM mem.user_facts
      WHERE user_id = $1 AND status = 'active' AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
      LIMIT $3`,
    [userId, vectorToSql(vec), SEMANTIC_DELETE_LIMIT],
  );
  return { semanticUnavailable: false, candidates: rows.map(formatFactCandidate) };
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

// Soft-delete facts by name, identifier, or fact text.
// Сначала проверяются UUID и точное совпадение fact_text: это покрывает сценарий, когда пользователь
// копирует строку из memory_list. Затем — нестрогое вхождение текста и фильтр по типу. Если точные
// методы ничего не нашли, последним шагом работает семантический поиск по embedding с осторожными
// порогами: явный лучший кандидат удаляется, близкие варианты возвращаются как ambiguous.
// factType сужает тип, когда по имени совпадают записи разных типов. Возвращает { deleted, items }.
// Если тип не указан и по имени совпали записи РАЗНЫХ типов — удаление не выполняется: возвращается
// { deleted: 0, ambiguous: true, candidates }, чтобы агент уточнил у пользователя, что именно забыть.
export async function deleteByEntity(userId, entityName, factType = null) {
  const rawName = String(entityName || '').trim();
  const name = normalizeLookupText(rawName);
  if (!name) {
    return { deleted: 0, items: [] };
  }

  if (isUuid(rawName)) {
    const { rows } = await query(
      `SELECT id, fact_type, fact_text
         FROM mem.user_facts
        WHERE user_id = $1 AND status = 'active' AND id = $2`,
      [userId, rawName],
    );
    return rows.length ? softDeleteRows(userId, rows) : { deleted: 0, items: [] };
  }

  const { rows: exactTextRows } = await query(
    `SELECT id, fact_type, fact_text
       FROM mem.user_facts
      WHERE user_id = $1 AND status = 'active' AND lower(fact_text) = $2
      ORDER BY updated_at DESC`,
    [userId, name],
  );
  if (exactTextRows.length > 0) {
    return softDeleteRows(userId, exactTextRows);
  }

  const params = [userId, name];
  let typeClause = '';
  if (factType) {
    params.push(String(factType).trim().toLowerCase());
    typeClause = 'AND fact_type = $3';
  }
  const { rows } = await query(
    `SELECT id, fact_type, fact_text
       FROM mem.user_facts
      WHERE user_id = $1 AND status = 'active'
        AND (fact_type = $2 OR lower(fact_text) LIKE '%' || $2 || '%')
        ${typeClause}
      ORDER BY updated_at DESC`,
    params,
  );
  if (rows.length === 0) {
    return deleteBySemanticMatch(userId, rawName);
  }

  const types = [...new Set(rows.map((r) => r.fact_type))];
  if (!factType && types.length > 1) {
    return {
      deleted: 0,
      ambiguous: true,
      candidates: rows.map((r) => ({
        id: r.id,
        fact_type: r.fact_type,
        fact_text: r.fact_text,
      })),
    };
  }

  return softDeleteRows(userId, rows);
}

// Whether the user is an administrator (a manual is_admin flag in the DB).
// Only an administrator can populate and clean global memory (see global-memory.js).
export async function isAdmin(userId) {
  const { rows } = await query('SELECT is_admin FROM mem.users WHERE id = $1', [userId]);
  return rows[0]?.is_admin === true;
}
