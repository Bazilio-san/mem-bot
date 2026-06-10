// User-facing memory management: viewing, deleting a single record, full forgetting.
// Deletion is soft (status='deleted'), so the record disappears from retrievals but a trace remains.
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

// Delete a single memory record (soft).
export async function deleteMemory(userId, memoryId) {
  const { rowCount } = await query(
    `UPDATE mem.memory_items SET status='deleted', updated_at=now() WHERE id=$1 AND user_id=$2`,
    [memoryId, userId],
  );
  return rowCount > 0;
}

// Forget everything in the user's active memory.
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

// Soft-delete memory records by entity name, identifier, or fact text.
// First a UUID and an exact memory_text match are checked: this covers the scenario where the user copies
// a string from memory_list. Then the previous search by entity_key/entity_type and a safe text fallback kick in.
// If the exact methods found nothing, the last step uses semantic search by embedding with cautious
// thresholds: an obvious best candidate is deleted, close variants are returned as ambiguous.
// Matching is fuzzy and case-insensitive: a match by entity key (entity_key), by its type,
// the name occurring in the key or fact text. The entityType parameter narrows the type when there are several names.
// Returns { deleted, items } — the number of records marked as deleted and a brief list of them.
// If the type is not specified and records of DIFFERENT types match the name, deletion is not performed: it returns
// { deleted: 0, ambiguous: true, candidates } so the agent can clarify with the user what exactly to forget.
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

// Whether the user is an administrator (a manual is_admin flag in the DB).
// Only an administrator can populate and clean global memory (see global-memory.js).
export async function isAdmin(userId) {
  const { rows } = await query('SELECT is_admin FROM mem.users WHERE id = $1', [userId]);
  return rows[0]?.is_admin === true;
}
