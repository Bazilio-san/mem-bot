// Контур записи памяти: фильтр приватности → поиск похожих → решение о слиянии →
// сохранение/обновление/архивирование. Не плодит дубли: обновляет существующий факт
// или помечает старый как заменённый.
import { query, vectorToSql } from '../db.js';
import { getDomainId } from '../repo.js';
import { validateAndCanonicalize } from '../schema/validate.js';
import {
  buildDedupeIdentity, decideDedupe, embedForDedupe, findDedupeCandidates,
} from './memory-dedupe.js';

// Порог автосохранения (раздел 19): важность ≥0.6, уверенность ≥0.7, не чувствительное.
function passesAutoSave(c) {
  if (c.requires_confirmation) return false;
  if (c.sensitivity === 'high' || c.sensitivity === 'secret') return false;
  return Number(c.importance) >= 0.6 && Number(c.confidence) >= 0.7;
}

async function insertMemory(userId, domainId, c, sourceConversationId, extraMeta = null, opts = {}) {
  const vec = opts.vector ?? await embedForDedupe(c);
  const expiresAt = c.ttl_days ? new Date(Date.now() + c.ttl_days * 86400000) : null;
  const { rows } = await query(
    `INSERT INTO mem.memory_items
       (user_id, domain_id, scope, memory_kind, entity_type, entity_key, memory_text, data,
        importance, confidence, sensitivity, status, source_conversation_id, expires_at, embedding, metadata,
        dedupe_key, canonical_group_id, dedupe_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             CASE WHEN $12 THEN 'pending_confirmation'::mem.memory_status ELSE 'active'::mem.memory_status END,
             $13,$14,$15,$16,$17,COALESCE($18::uuid, gen_random_uuid()),$19)
     RETURNING id, canonical_group_id`,
    [userId, domainId, c.scope, c.memory_kind, c.entity_type, c.entity_key, c.memory_text, c.data || {},
      c.importance, c.confidence, c.sensitivity, !!c.requires_confirmation, sourceConversationId, expiresAt,
      vec ? vectorToSql(vec) : null, extraMeta ? JSON.stringify(extraMeta) : {},
      opts.dedupeKey || null, opts.canonicalGroupId || null, opts.dedupeStatus || 'canonical'],
  );
  return rows[0];
}

// Обновить существующий факт новым значением, сохранив историю предыдущего значения.
async function updateMemory(targetId, c, extraMeta = null, opts = {}) {
  const vec = opts.vector ?? await embedForDedupe(c);
  const { rows: prev } = await query('SELECT memory_text, data FROM mem.memory_items WHERE id = $1', [targetId]);
  const history = prev[0]
    ? { previous_text: prev[0].memory_text, previous_data: prev[0].data, replaced_at: new Date().toISOString() }
    : {};
  await query(
    `UPDATE mem.memory_items
     SET memory_text = $2, data = $3, importance = $4, confidence = $5,
         embedding = $6, updated_at = now(),
         metadata = metadata || $7::jsonb,
         dedupe_key = COALESCE($8, dedupe_key),
         canonical_group_id = COALESCE(canonical_group_id, $9::uuid, id),
         dedupe_status = 'canonical'
     WHERE id = $1`,
    [targetId, c.memory_text, c.data || {}, c.importance, c.confidence,
      vec ? vectorToSql(vec) : null, JSON.stringify({ last_update: history, ...(extraMeta || {}) }),
      opts.dedupeKey || null, opts.canonicalGroupId || null],
  );
  return targetId;
}

// Архивировать старый факт, пометив, чем он заменён.
async function archiveMemory(oldId, replacedById, extraMeta = {}) {
  await query(
    `UPDATE mem.memory_items
     SET status = 'archived', dedupe_status = 'superseded', updated_at = now(), metadata = metadata || $2::jsonb
     WHERE id = $1`,
    [oldId, JSON.stringify({ replaced_by: replacedById, ...extraMeta })],
  );
}

// Обработать один кандидат. Возвращает применённое действие.
export async function processCandidate(userId, domainKey, candidate, sourceConversationId = null) {
  const domainId = await getDomainId(domainKey);

  // Фильтр приватности: чувствительное и неподтверждённое не сохраняем как обычный факт.
  if (candidate.requires_confirmation || candidate.sensitivity === 'high' || candidate.sensitivity === 'secret') {
    return { action: 'needs_confirmation', candidate };
  }
  if (!passesAutoSave(candidate)) {
    return { action: 'ignored', reason: 'низкая важность/уверенность', candidate };
  }

  // Применить схему домена: проверить data и привести entity_key к словарю.
  // Схема обязательна для предметных фактов: если у домена нет схемы, сущность не объявлена
  // или data не проходит валидацию — факт отклоняется и НЕ сохраняется.
  const v = await validateAndCanonicalize(domainKey, candidate);
  if (!v.ok) {
    return { action: 'rejected', reason: v.reason, issues: v.issues, candidate: v.candidate };
  }
  candidate = v.candidate;
  // Метаданные схемы (версия и замечания канонизации) кладём в строку факта.
  const schemaMeta = v.schema_version == null ? null : {
    schema_version: v.schema_version,
    ...(v.issues.length ? { schema_issues: v.issues } : {}),
  };

  const identity = buildDedupeIdentity(domainKey, candidate);
  candidate = { ...candidate, domainKey, dedupeIdentity: identity };
  const vec = await embedForDedupe(candidate);
  const similar = await findDedupeCandidates({ userId, domainKey, candidate, candidateVector: vec });
  const merge = decideDedupe(candidate, similar);
  const dedupeMeta = {
    ...(schemaMeta || {}),
    dedupe: {
      key: merge.dedupeKey,
      scope_group: merge.scopeGroup,
      decision: merge.decision,
      score: merge.score,
      source: merge.source || 'rule',
      reason: merge.reason || null,
      at: new Date().toISOString(),
    },
  };

  if (merge.decision === 'create_new') {
    const inserted = await insertMemory(userId, domainId, candidate, sourceConversationId, dedupeMeta, {
      vector: vec,
      dedupeKey: merge.dedupeKey,
      dedupeStatus: 'canonical',
    });
    return {
      action: 'created',
      id: inserted.id,
      dedupe_key: merge.dedupeKey,
      canonical_group_id: inserted.canonical_group_id,
      dedupe_source: merge.source || 'rule',
    };
  }
  if (merge.decision === 'update_existing') {
    const canonicalGroupId = merge.target?.canonical_group_id || merge.targetId;
    const id = await updateMemory(merge.targetId, candidate, dedupeMeta, {
      vector: vec,
      dedupeKey: merge.dedupeKey,
      canonicalGroupId,
    });
    return {
      action: 'updated',
      id,
      dedupe_key: merge.dedupeKey,
      canonical_group_id: canonicalGroupId,
      dedupe_score: merge.score,
      dedupe_source: merge.source || 'rule',
    };
  }
  if (merge.decision === 'replace_existing') {
    const canonicalGroupId = merge.target?.canonical_group_id || merge.targetId;
    const inserted = await insertMemory(userId, domainId, candidate, sourceConversationId, dedupeMeta, {
      vector: vec,
      dedupeKey: merge.dedupeKey,
      canonicalGroupId,
      dedupeStatus: 'canonical',
    });
    await archiveMemory(merge.targetId, inserted.id, { dedupe: { ...dedupeMeta.dedupe, role: 'superseded' } });
    return {
      action: 'replaced',
      id: inserted.id,
      archived: merge.targetId,
      dedupe_key: merge.dedupeKey,
      canonical_group_id: canonicalGroupId,
      dedupe_score: merge.score,
      dedupe_source: merge.source || 'rule',
    };
  }
  return { action: 'ignored', candidate };
}

// Обработать все кандидаты после ответа.
export async function persistCandidates(userId, domainKey, candidates, sourceConversationId = null) {
  const results = [];
  for (const c of candidates) {
    results.push(await processCandidate(userId, domainKey, c, sourceConversationId));
  }
  return results;
}

export { passesAutoSave };
