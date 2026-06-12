// Global memory layer: always-on global facts and a shared knowledge base (RAG).
// Unlike personal memory (bound to a user), these records are visible to everyone. Only an administrator can
// populate and clean them — the permission check is done in the calling layer (agent tools, CLI commands).
// Global facts are mixed into every request; knowledge base fragments — only those relevant to the current query.
// Details are in docs/ai-bot-with-memory/14-global-memory.md.
import { query, vectorToSql } from '../db.js';
import { embed } from '../llm.js';
import { getDomainId } from '../repo.js';
import { config } from '../config.js';

// ===================== Global facts (always-on) ==========================

// Currently effective facts: enabled and belonging either to the current domain or shared (domain_id IS NULL).
// Sorted by priority (a smaller number is more important), truncated to the hard minimization limit.
export async function getActiveGlobalFacts({ domainKey, limit = config.globalMemory.factsLimit }) {
  const domainId = domainKey ? await getDomainId(domainKey) : null;
  const { rows } = await query(
    `SELECT id, fact_text, priority, domain_id
     FROM mem.global_facts
     WHERE enabled = true AND (domain_id = $1 OR domain_id IS NULL)
     ORDER BY priority ASC, created_at ASC
     LIMIT $2`,
    [domainId, limit],
  );
  return rows;
}

// List all facts (for admin commands: show identifiers so there is something to delete).
export async function listGlobalFacts({ includeDisabled = true } = {}) {
  const { rows } = await query(
    `SELECT id, fact_text, priority, enabled, domain_id
     FROM mem.global_facts
     WHERE ($1 OR enabled = true)
     ORDER BY enabled DESC, priority ASC, created_at ASC`,
    [includeDisabled],
  );
  return rows;
}

// Add a global fact. By default the fact is shared across all domains (domain_id = NULL);
// if domainKey is passed, the fact is bound to that domain.
export async function addGlobalFact({ factText, domainKey = null, priority = 100, createdBy = null }) {
  const domainId = domainKey ? await getDomainId(domainKey) : null;
  const { rows } = await query(
    `INSERT INTO mem.global_facts (domain_id, fact_text, priority, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, fact_text, priority`,
    [domainId, factText, priority, createdBy],
  );
  return rows[0];
}

// Delete a global fact by identifier (physically). Returns true if the record existed.
export async function deleteGlobalFact(id) {
  const { rowCount } = await query('DELETE FROM mem.global_facts WHERE id = $1', [id]);
  return rowCount > 0;
}

// Enable or disable a fact without deleting it.
export async function setGlobalFactEnabled(id, enabled) {
  const { rowCount } = await query('UPDATE mem.global_facts SET enabled = $2, updated_at = now() WHERE id = $1', [
    id,
    enabled,
  ]);
  return rowCount > 0;
}

// GLOBAL_FACTS reference block for the prompt. Returns an empty string if the layer is disabled by a flag
// or there are no matching facts. The source is trusted (administrator only), so the facts are presented as
// authoritative general information and policy — without the "this is untrusted reference" wrapper.
export async function buildGlobalFactsBlock(domainKey) {
  if (!config.globalMemory.factsEnabled) {
    return '';
  }
  const facts = await getActiveGlobalFacts({ domainKey });
  if (!facts.length) {
    return '';
  }
  const lines = facts.map((f) => `- ${f.fact_text}`).join('\n');
  return `GLOBAL_FACTS (общие сведения и политика для всех пользователей)\n\n${lines}`;
}

// ===================== Shared knowledge base (RAG) ===============================

// Knowledge base search: semantic proximity via embeddings (if available) or full-text as a fallback
// signal. Takes the domain into account (current or shared) and cuts off weak matches with a relevance
// threshold so that irrelevant fragments do not end up in the context.
export async function searchGlobalKnowledge({
  domainKey,
  query: userQuery,
  limit = config.globalMemory.ragLimit,
  minRelevance = config.globalMemory.ragMinRelevance,
}) {
  const domainId = domainKey ? await getDomainId(domainKey) : null;
  const vec = await embed(userQuery);

  if (vec) {
    const { rows } = await query(
      `SELECT id, title, content, 1 - (embedding <=> $2::vector) AS relevance
       FROM mem.global_knowledge
       WHERE status = 'active' AND embedding IS NOT NULL
         AND (domain_id = $1 OR domain_id IS NULL)
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [domainId, vectorToSql(vec), limit],
    );
    const strong = rows.filter((r) => Number(r.relevance) >= minRelevance);
    if (strong.length) {
      return strong;
    }
    // If nothing strong was found semantically, we try full-text below.
  }

  const { rows } = await query(
    `SELECT id, title, content, LEAST(ts_rank(search_tsv, plainto_tsquery('simple', $2)) * 4, 1) AS relevance
     FROM mem.global_knowledge
     WHERE status = 'active' AND (domain_id = $1 OR domain_id IS NULL)
       AND search_tsv @@ plainto_tsquery('simple', $2)
     ORDER BY relevance DESC
     LIMIT $3`,
    [domainId, userQuery, limit],
  );
  return rows.filter((r) => Number(r.relevance) >= minRelevance);
}

// Add text to the shared knowledge base. Computes an embedding (if the service is available); if unavailable,
// the record is still created and remains findable via full-text search.
export async function addGlobalKnowledge({
  title = null,
  content,
  domainKey = null,
  tags = [],
  importance = 0.5,
  source = null,
  createdBy = null,
}) {
  const domainId = domainKey ? await getDomainId(domainKey) : null;
  const vec = await embed([title, content].filter(Boolean).join('. '));
  const { rows } = await query(
    `INSERT INTO mem.global_knowledge (domain_id, title, content, tags, importance, source, created_by, embedding)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, title, content`,
    [domainId, title, content, tags, importance, source, createdBy, vec ? vectorToSql(vec) : null],
  );
  return rows[0];
}

// Delete knowledge base text by identifier (soft delete: status = 'deleted', so a trace remains).
export async function deleteGlobalKnowledge(id) {
  const { rowCount } = await query(
    `UPDATE mem.global_knowledge SET status = 'deleted', updated_at = now()
     WHERE id = $1 AND status <> 'deleted'`,
    [id],
  );
  return rowCount > 0;
}

// ------------------- Admin CRUD over the knowledge base ---------------------
// Functions for the admin panel (REST API /api/knowledge*). The embedding vector itself never leaves the
// database — clients only see the hasEmbedding flag, which the table uses to show the "no vector" badge.

// Shared SELECT: all client-visible fields plus the domain key resolved through agent_domains.
const KNOWLEDGE_SELECT = `
  SELECT k.id, k.title, k.content, d.domain_key, k.tags, k.importance, k.status, k.source,
         (k.embedding IS NOT NULL) AS has_embedding, k.created_at, k.updated_at
  FROM mem.global_knowledge k
  LEFT JOIN mem.agent_domains d ON d.id = k.domain_id`;

function mapKnowledgeRow(r) {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    domainKey: r.domain_key || null,
    tags: r.tags || [],
    importance: Number(r.importance),
    status: r.status,
    source: r.source,
    hasEmbedding: r.has_embedding,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// List knowledge base records for the admin table. The base is small (tens to hundreds of records), so the
// whole filtered set is returned at once and sorting/filtering/pagination happen on the client.
export async function listGlobalKnowledge({ statuses = ['active', 'archived'] } = {}) {
  const { rows } = await query(
    `${KNOWLEDGE_SELECT}
     WHERE k.status = ANY($1::mem.memory_status[])
     ORDER BY k.updated_at DESC`,
    [statuses],
  );
  return rows.map(mapKnowledgeRow);
}

// One record by id (admin shape with hasEmbedding), or null if it does not exist.
export async function getGlobalKnowledgeById(id) {
  const { rows } = await query(`${KNOWLEDGE_SELECT} WHERE k.id = $1`, [id]);
  return rows.length ? mapKnowledgeRow(rows[0]) : null;
}

// Fuzzy text search over the knowledge base for the admin table. Combines two signals over title+content:
// exact full-text matching by search_tsv (word hits, 'simple' configuration without stemming) and trigram
// word_similarity from pg_trgm, which also catches typos and other word forms that full-text misses.
// Relevance is the best of the two signals, normalised to 0..1. No embeddings are involved — this is a
// text search, intentionally independent of the vector layer and the embedding service. The base is small,
// so a sequential scan over the filtered statuses is fine without a trigram index.
export async function searchGlobalKnowledgeText({
  q,
  statuses = ['active', 'archived'],
  minSimilarity = 0.35,
  limit = 100,
}) {
  const { rows } = await query(
    `WITH scored AS (
       SELECT k.id,
              k.search_tsv @@ plainto_tsquery('simple', $1) AS fts_match,
              GREATEST(
                LEAST(ts_rank(k.search_tsv, plainto_tsquery('simple', $1)) * 4, 1),
                word_similarity($1, coalesce(k.title, '') || ' ' || k.content)
              ) AS relevance
       FROM mem.global_knowledge k
       WHERE k.status = ANY($2::mem.memory_status[])
     )
     SELECT t.*, s.relevance
     FROM (${KNOWLEDGE_SELECT}) t
     JOIN scored s ON s.id = t.id
     WHERE s.fts_match OR s.relevance >= $3
     ORDER BY s.relevance DESC, t.updated_at DESC
     LIMIT $4`,
    [q, statuses, minSimilarity, limit],
  );
  return rows.map((r) => ({ ...mapKnowledgeRow(r), relevance: Number(r.relevance) }));
}

// Update a record from the admin form. The UPDATE deliberately does not touch the embedding column: if the
// text changed, the database trigger resets the vector to NULL, after which we immediately try to compute a
// fresh one (second UPDATE writes only the vector, so the trigger leaves it alone). When the embedding
// service is unavailable the record simply stays with hasEmbedding = false and is picked up later by the
// manual "recompute" button or the background repair pass. Returns the updated record or null if not found.
export async function updateGlobalKnowledge(
  id,
  { title = null, content, domainKey = null, tags = [], importance = 0.5, source = null, status = 'active' },
) {
  const domainId = domainKey ? await getDomainId(domainKey) : null;
  if (domainKey && !domainId) {
    throw new Error(`Unknown domain: ${domainKey}`);
  }
  const { rowCount } = await query(
    `UPDATE mem.global_knowledge
     SET title = $2, content = $3, domain_id = $4, tags = $5, importance = $6, source = $7, status = $8
     WHERE id = $1`,
    [id, title, content, domainId, tags, importance, source, status],
  );
  if (!rowCount) {
    return null;
  }
  await reembedGlobalKnowledge(id);
  return getGlobalKnowledgeById(id);
}

// Recompute the embedding from the current title/content. By default only fills a missing vector (the
// normal save path); force = true recomputes even when a vector is present (manual admin button). The
// UPDATE writes only the embedding, so the reset trigger does not interfere. Returns false when the record
// does not exist or the embedding service returned nothing.
export async function reembedGlobalKnowledge(id, { force = false } = {}) {
  const { rows } = await query(
    `SELECT title, content, (embedding IS NOT NULL) AS has_embedding FROM mem.global_knowledge WHERE id = $1`,
    [id],
  );
  if (!rows.length) {
    return false;
  }
  if (rows[0].has_embedding && !force) {
    return true;
  }
  const vec = await embed([rows[0].title, rows[0].content].filter(Boolean).join('. '));
  if (!vec) {
    return false;
  }
  await query('UPDATE mem.global_knowledge SET embedding = $2 WHERE id = $1', [id, vectorToSql(vec)]);
  return true;
}

// GLOBAL_KNOWLEDGE reference block for the prompt. Returns an empty string if RAG is disabled by a flag or
// there are no relevant fragments (to avoid adding an empty block and making unnecessary embedding requests).
export async function buildGlobalKnowledgeBlock(domainKey, userQuery) {
  if (!config.globalMemory.ragEnabled) {
    return '';
  }
  const hits = await searchGlobalKnowledge({ domainKey, query: userQuery });
  if (!hits.length) {
    return '';
  }
  const lines = hits.map((h) => `- ${h.title ? h.title + ': ' : ''}${h.content}`).join('\n');
  return `GLOBAL_KNOWLEDGE (релевантные фрагменты общей базы знаний)\n\n${lines}`;
}
