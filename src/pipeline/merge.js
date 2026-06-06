// Контур записи памяти: фильтр приватности → поиск похожих → решение о слиянии →
// сохранение/обновление/архивирование. Не плодит дубли: обновляет существующий факт
// или помечает старый как заменённый.
import { query, vectorToSql } from '../db.js';
import { embed } from '../llm.js';
import { getDomainId } from '../repo.js';

// Порог автосохранения (раздел 19): важность ≥0.6, уверенность ≥0.7, не чувствительное.
function passesAutoSave(c) {
  if (c.requires_confirmation) return false;
  if (c.sensitivity === 'high' || c.sensitivity === 'secret') return false;
  return Number(c.importance) >= 0.6 && Number(c.confidence) >= 0.7;
}

// Найти похожие активные факты: по сущности или по полнотекстовому совпадению.
async function findSimilar(userId, c) {
  const { rows } = await query(
    `SELECT id, scope, entity_type, entity_key, memory_text, data, importance, confidence, metadata
     FROM mem.memory_items
     WHERE user_id = $1 AND status = 'active' AND scope = $2
       AND (
         (entity_type IS NOT DISTINCT FROM $3 AND entity_key IS NOT DISTINCT FROM $4 AND $4 IS NOT NULL)
         OR search_tsv @@ plainto_tsquery('simple', $5)
       )
     ORDER BY updated_at DESC LIMIT 5`,
    [userId, c.scope, c.entity_type, c.entity_key, c.memory_text],
  );
  return rows;
}

async function insertMemory(userId, domainId, c, sourceConversationId) {
  const vec = await embed(c.memory_text);
  const expiresAt = c.ttl_days ? new Date(Date.now() + c.ttl_days * 86400000) : null;
  const { rows } = await query(
    `INSERT INTO mem.memory_items
       (user_id, domain_id, scope, memory_kind, entity_type, entity_key, memory_text, data,
        importance, confidence, sensitivity, status, source_conversation_id, expires_at, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             CASE WHEN $12 THEN 'pending_confirmation'::mem.memory_status ELSE 'active'::mem.memory_status END,
             $13,$14,$15)
     RETURNING id`,
    [userId, domainId, c.scope, c.memory_kind, c.entity_type, c.entity_key, c.memory_text, c.data || {},
      c.importance, c.confidence, c.sensitivity, !!c.requires_confirmation, sourceConversationId, expiresAt,
      vec ? vectorToSql(vec) : null],
  );
  return rows[0].id;
}

// Обновить существующий факт новым значением, сохранив историю предыдущего значения.
async function updateMemory(targetId, c) {
  const vec = await embed(c.memory_text);
  const { rows: prev } = await query('SELECT memory_text, data FROM mem.memory_items WHERE id = $1', [targetId]);
  const history = prev[0] ? { previous_text: prev[0].memory_text, previous_data: prev[0].data, replaced_at: new Date().toISOString() } : {};
  await query(
    `UPDATE mem.memory_items
     SET memory_text = $2, data = $3, importance = $4, confidence = $5,
         embedding = $6, updated_at = now(),
         metadata = metadata || $7::jsonb
     WHERE id = $1`,
    [targetId, c.memory_text, c.data || {}, c.importance, c.confidence,
      vec ? vectorToSql(vec) : null, JSON.stringify({ last_update: history })],
  );
  return targetId;
}

// Архивировать старый факт, пометив, чем он заменён.
async function archiveMemory(oldId, replacedById) {
  await query(
    `UPDATE mem.memory_items
     SET status = 'archived', updated_at = now(), metadata = metadata || $2::jsonb
     WHERE id = $1`,
    [oldId, JSON.stringify({ replaced_by: replacedById })],
  );
}

// Решение о слиянии простыми правилами (без отдельного вызова LLM ради скорости).
// Если есть похожий факт той же сущности — обновляем его (это и есть «обновление, а не дубль»).
function decideMerge(c, similar) {
  const sameEntity = similar.find(
    (s) => s.entity_key && c.entity_key && s.entity_key === c.entity_key && s.entity_type === c.entity_type,
  );
  if (sameEntity) {
    const conflict = sameEntity.memory_text.trim() !== c.memory_text.trim();
    return { decision: conflict ? 'replace_existing' : 'update_existing', targetId: sameEntity.id };
  }
  // Очень близкий текст без сущности — тоже обновляем, чтобы не плодить дубли.
  const near = similar.find((s) => normalize(s.memory_text) === normalize(c.memory_text));
  if (near) return { decision: 'update_existing', targetId: near.id };
  return { decision: 'create_new', targetId: null };
}

function normalize(s) {
  return s.toLowerCase().replace(/[^a-zа-я0-9 ]/gi, '').replace(/\s+/g, ' ').trim();
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

  const similar = await findSimilar(userId, candidate);
  const { decision, targetId } = decideMerge(candidate, similar);

  if (decision === 'create_new') {
    const id = await insertMemory(userId, domainId, candidate, sourceConversationId);
    return { action: 'created', id };
  }
  if (decision === 'update_existing') {
    const id = await updateMemory(targetId, candidate);
    return { action: 'updated', id };
  }
  if (decision === 'replace_existing') {
    const newId = await insertMemory(userId, domainId, candidate, sourceConversationId);
    await archiveMemory(targetId, newId);
    return { action: 'replaced', id: newId, archived: targetId };
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
