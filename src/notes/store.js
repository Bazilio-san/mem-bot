// Notes core: CRUD, soft delete with undo, embeddings and hybrid (vector + full-text) search over mem.notes.
// This is the single data-access layer for every consumer — the LLM tools of the notes MCP server, the
// widget REST API and tests all call these functions; none of them writes SQL of its own.
//
// Embeddings are best effort: embed() returns null on a provider error, the note is saved anyway and such
// a note is still reachable through the full-text branch of the hybrid search. Every function takes userId
// and filters by it, so one user can never see or touch another user's notes.
import { config } from '../config.js';
import { query, vectorToSql } from '../db.js';
import { embed } from '../llm.js';

// Hard limit of the note body length (accepted decision: ~20 000 characters).
export const NOTE_BODY_MAX = 20_000;
// Only the first characters of the body go into the embedding: enough for meaning, keeps token cost flat.
export const EMBED_BODY_CHARS = 8_000;
// Title length limit — protects the feed layout and the embedding input.
export const NOTE_TITLE_MAX = 400;
// How many candidates each search branch (vector / full-text) contributes before RRF fusion.
const SEARCH_BRANCH_LIMIT = 30;

// Test seam: replaces the real embed() with a deterministic fake so the store tests do not call the
// LLM provider. Pass null to restore the real implementation.
let embedImpl = embed;
export function __setEmbedForTests(fn) {
  embedImpl = fn || embed;
}

const SELECT_FIELDS = 'id, user_id, title, body, tags, pinned, deleted_at, created_at, updated_at';

// ---- Validation -------------------------------------------------------------

// Validation failures carry code='VALIDATION' so the REST layer can answer 400 instead of 500.
function validationError(message) {
  const err = new Error(message);
  err.code = 'VALIDATION';
  return err;
}

function normalizeTitle(title) {
  const t = String(title ?? '').trim();
  if (t.length > NOTE_TITLE_MAX) {
    throw validationError(`Заголовок заметки длиннее ${NOTE_TITLE_MAX} символов.`);
  }
  return t;
}

function normalizeBody(body) {
  const b = String(body ?? '').trim();
  if (!b) {
    throw validationError('Текст заметки не может быть пустым.');
  }
  if (b.length > NOTE_BODY_MAX) {
    throw validationError(`Текст заметки длиннее ${NOTE_BODY_MAX} символов.`);
  }
  return b;
}

function normalizeTags(tags) {
  if (tags == null) {
    return [];
  }
  if (!Array.isArray(tags)) {
    throw validationError('Теги заметки должны быть массивом строк.');
  }
  const clean = tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  return [...new Set(clean)];
}

// ---- Embeddings -------------------------------------------------------------

// Compute embeddings for the changed fields. Returns pgvector literals (or null when the text is empty
// or the provider failed). Title and body are embedded separately so search can take the best of the two.
async function computeEmbeddings({ title, body }) {
  const [titleVec, bodyVec] = await Promise.all([
    title === undefined || title === '' ? null : embedImpl(title, { kind: 'notes' }),
    body === undefined ? null : embedImpl(body.slice(0, EMBED_BODY_CHARS), { kind: 'notes' }),
  ]);
  return {
    titleEmbedding: titleVec ? vectorToSql(titleVec) : null,
    bodyEmbedding: bodyVec ? vectorToSql(bodyVec) : null,
  };
}

// ---- CRUD -------------------------------------------------------------------

export async function createNote({ userId, title = '', body, tags = [] }) {
  const t = normalizeTitle(title);
  const b = normalizeBody(body);
  const tg = normalizeTags(tags);
  const { titleEmbedding, bodyEmbedding } = await computeEmbeddings({ title: t, body: b });
  const { rows } = await query(
    `INSERT INTO mem.notes (user_id, title, body, tags, title_embedding, body_embedding)
     VALUES ($1, $2, $3, $4, $5::vector, $6::vector)
     RETURNING ${SELECT_FIELDS}`,
    [userId, t, b, tg, titleEmbedding, bodyEmbedding],
  );
  return rows[0];
}

export async function getNote({ userId, id }) {
  const { rows } = await query(
    `SELECT ${SELECT_FIELDS} FROM mem.notes WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [id, userId],
  );
  return rows[0] || null;
}

// Partial update: only the provided fields change; embeddings are recomputed only for changed text fields.
export async function updateNote({ userId, id, title, body, tags, pinned }) {
  const existing = await getNote({ userId, id });
  if (!existing) {
    return null;
  }

  const sets = [];
  const params = [id, userId];
  const changed = [];
  const add = (sql, value) => {
    params.push(value);
    sets.push(sql.replace('?', `$${params.length}`));
  };

  if (title !== undefined && normalizeTitle(title) !== existing.title) {
    const t = normalizeTitle(title);
    add('title = ?', t);
    const { titleEmbedding } = await computeEmbeddings({ title: t });
    add('title_embedding = ?::vector', titleEmbedding);
    changed.push('title');
  }
  if (body !== undefined && normalizeBody(body) !== existing.body) {
    const b = normalizeBody(body);
    add('body = ?', b);
    const { bodyEmbedding } = await computeEmbeddings({ body: b });
    add('body_embedding = ?::vector', bodyEmbedding);
    changed.push('body');
  }
  if (tags !== undefined) {
    const tg = normalizeTags(tags);
    if (JSON.stringify(tg) !== JSON.stringify(existing.tags)) {
      add('tags = ?', tg);
      changed.push('tags');
    }
  }
  if (pinned !== undefined && Boolean(pinned) !== existing.pinned) {
    add('pinned = ?', Boolean(pinned));
    changed.push('pinned');
  }

  if (sets.length === 0) {
    return { note: existing, changed: [] };
  }
  sets.push('updated_at = now()');
  const { rows } = await query(
    `UPDATE mem.notes SET ${sets.join(', ')}
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING ${SELECT_FIELDS}`,
    params,
  );
  return rows[0] ? { note: rows[0], changed } : null;
}

// Soft delete: the row stays in place, undo is possible via restoreNote().
export async function deleteNote({ userId, id }) {
  const { rows } = await query(
    `UPDATE mem.notes SET deleted_at = now()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
     RETURNING ${SELECT_FIELDS}`,
    [id, userId],
  );
  return rows[0] || null;
}

export async function restoreNote({ userId, id }) {
  const { rows } = await query(
    `UPDATE mem.notes SET deleted_at = NULL, updated_at = now()
     WHERE id = $1 AND user_id = $2 AND deleted_at IS NOT NULL
     RETURNING ${SELECT_FIELDS}`,
    [id, userId],
  );
  return rows[0] || null;
}

export async function countNotes({ userId, tag = null }) {
  const params = [userId];
  let where = 'user_id = $1 AND deleted_at IS NULL';
  if (tag) {
    params.push(tag);
    where += ` AND $${params.length} = ANY(tags)`;
  }
  const { rows } = await query(`SELECT count(*)::int AS c FROM mem.notes WHERE ${where}`, params);
  return rows[0].c;
}

// ---- Listing and hybrid search ----------------------------------------------

// Cursor of the feed (no search query): keyset pagination over the feed ordering
// (pinned DESC, updated_at DESC, id DESC). For search results the cursor is a plain offset,
// because the fused result set is small (at most 2 × SEARCH_BRANCH_LIMIT items).
function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}
function decodeCursor(cursor) {
  if (!cursor) {
    return null;
  }
  try {
    return JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// List the user's notes. Without `q` — the feed with keyset pagination; with `q` — hybrid search
// (vector + full-text fused by Reciprocal Rank Fusion) with offset pagination inside the fused set.
// Returns { items, nextCursor, total }.
export async function listNotes({ userId, cursor = null, limit = 20, q = '', tag = null }) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const queryText = String(q || '').trim();
  const total = await countNotes({ userId, tag });

  if (!queryText) {
    return { ...(await listFeed({ userId, cursor, lim, tag })), total };
  }
  return { ...(await searchHybrid({ userId, cursor, lim, queryText, tag })), total };
}

async function listFeed({ userId, cursor, lim, tag }) {
  const params = [userId];
  const where = ['user_id = $1', 'deleted_at IS NULL'];
  if (tag) {
    params.push(tag);
    where.push(`$${params.length} = ANY(tags)`);
  }
  const cur = decodeCursor(cursor);
  if (cur && Array.isArray(cur.k) && cur.k.length === 3) {
    // Lexicographic row comparison matches ORDER BY with all three keys DESC.
    params.push(cur.k[0], cur.k[1], cur.k[2]);
    where.push(`(pinned, updated_at, id) < ($${params.length - 2}, $${params.length - 1}, $${params.length})`);
  }
  params.push(lim + 1);
  const { rows } = await query(
    `SELECT ${SELECT_FIELDS} FROM mem.notes
     WHERE ${where.join(' AND ')}
     ORDER BY pinned DESC, updated_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  const hasMore = rows.length > lim;
  const items = rows.slice(0, lim);
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor({ k: [last.pinned, last.updated_at, last.id] }) : null;
  return { items, nextCursor };
}

async function searchHybrid({ userId, cursor, lim, queryText, tag }) {
  const cfg = config.notes.search;
  const tagWhere = tag ? 'AND $3 = ANY(tags)' : '';
  const baseParams = tag ? [userId, null, tag] : [userId, null];

  // Vector branch: best (smallest) cosine distance between the query and the title/body embeddings.
  let vectorRows = [];
  const queryVec = await embedImpl(queryText, { kind: 'notes' });
  if (queryVec) {
    const params = [...baseParams];
    params[1] = vectorToSql(queryVec);
    const { rows } = await query(
      `SELECT id, LEAST(
                COALESCE(title_embedding <=> $2::vector, 1),
                COALESCE(body_embedding <=> $2::vector, 1)
              ) AS dist
       FROM mem.notes
       WHERE user_id = $1 AND deleted_at IS NULL
         AND (title_embedding IS NOT NULL OR body_embedding IS NOT NULL) ${tagWhere}
       ORDER BY dist
       LIMIT ${SEARCH_BRANCH_LIMIT}`,
      params,
    );
    vectorRows = rows.filter((r) => Number(r.dist) <= cfg.vectorThreshold);
  }

  // Full-text branch: russian dictionary, ranked by ts_rank.
  const ftParams = [...baseParams];
  ftParams[1] = queryText;
  const { rows: ftRows } = await query(
    `SELECT id, ts_rank(search_tsv, plainto_tsquery('russian', $2)) AS rank
     FROM mem.notes
     WHERE user_id = $1 AND deleted_at IS NULL
       AND search_tsv @@ plainto_tsquery('russian', $2) ${tagWhere}
     ORDER BY rank DESC
     LIMIT ${SEARCH_BRANCH_LIMIT}`,
    ftParams,
  );

  // Reciprocal Rank Fusion: score = wV/(K + rankV) + wF/(K + rankF). A note found by both branches
  // gets both terms and rises above single-branch hits.
  const scores = new Map();
  vectorRows.forEach((r, i) => {
    scores.set(r.id, (scores.get(r.id) || 0) + cfg.vectorWeight / (cfg.rrfK + i + 1));
  });
  ftRows.forEach((r, i) => {
    scores.set(r.id, (scores.get(r.id) || 0) + cfg.fulltextWeight / (cfg.rrfK + i + 1));
  });
  const orderedIds = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

  const cur = decodeCursor(cursor);
  const offset = cur && Number.isInteger(cur.o) && cur.o > 0 ? cur.o : 0;
  const pageIds = orderedIds.slice(offset, offset + lim);
  const nextCursor = offset + lim < orderedIds.length ? encodeCursor({ o: offset + lim }) : null;

  if (pageIds.length === 0) {
    return { items: [], nextCursor: null };
  }
  const { rows } = await query(
    `SELECT ${SELECT_FIELDS} FROM mem.notes WHERE user_id = $1 AND id = ANY($2::bigint[]) AND deleted_at IS NULL`,
    [userId, pageIds],
  );
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const items = pageIds
    .map((id) => byId.get(String(id)))
    .filter(Boolean)
    .map((r) => ({ ...r, relevance: scores.get(r.id) ?? scores.get(Number(r.id)) ?? null }));
  return { items, nextCursor };
}

// Compact search for the LLM (the notes_search tool): same hybrid ranking, snippet instead of full body.
export async function searchNotesForLlm({ userId, q = '', tag = null, limit = 10 }) {
  const { items, total } = await listNotes({ userId, q, tag, limit });
  return {
    total,
    items: items.map((n) => ({
      id: Number(n.id),
      title: n.title,
      snippet: n.body.length > 300 ? `${n.body.slice(0, 300)}…` : n.body,
      tags: n.tags,
      pinned: n.pinned,
      updatedAt: n.updated_at,
    })),
  };
}
