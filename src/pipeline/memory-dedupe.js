import { query, vectorToSql } from '../db.js';
import { embed } from '../llm.js';
import { getDomainId } from '../repo.js';

const FEATURE_KEYS = [
  ['streaming_responses', [/стрим/i, /ответ.*част/i, /част.*ответ/i, /по мере генерац/i]],
  ['global_memory', [/глобальн.*памят/i]],
  ['reminder_view', [/просмотр.*напомин/i, /напоминан.*врем/i, /активн.*напомин/i]],
  ['bot_menu', [/бот-?меню/i, /меню бота/i]],
  ['status_command', [/команд.*status/i, /\bstatus\b/i]],
  ['audio_recognition', [/распознаван.*(звук|аудио|голос)/i, /(звук|аудио).*распознаван/i]],
  ['emoji_reactions', [/emoji/i, /эмодзи/i, /реакци/i]],
  ['log_analysis', [/анализ.*лог/i, /лог.*анализ/i]],
  ['self_development', [/саморазвит/i]],
  ['assistant_birth_global_memory', [/врем.*рожд.*ассистент/i, /дат.*рожд.*ассистент/i]],
];

const STYLE_KEYS = [
  ['streamed_answers', [/стрим/i, /ответ.*част/i, /част.*ответ/i, /по мере генерац/i]],
  ['first_person_notifications', [/перв.*лиц/i, /напоминаю/i, /уведомлен/i]],
  ['emoji_chat_names', [/like/i, /okay/i, /heart/i, /назван.*emoji/i, /назван.*эмодзи/i]],
  ['informal_tone', [/неформаль/i, /непринужден/i, /жив/i, /без формаль/i]],
];

const ASSISTANT_NAME_PATTERNS = [
  [/бобик/i, 'bobik'],
  [/шарик/i, 'sharik'],
  [/chatgpt/i, 'chatgpt'],
];

const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function normalizeMemoryText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[«»“”„"']/g, '')
    .replace(/[^a-zа-яё0-9 ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function slug(value, fallback = 'item') {
  const lower = normalizeMemoryText(value);
  let out = '';
  for (const ch of lower) {
    if (Object.prototype.hasOwnProperty.call(CYR, ch)) out += CYR[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else out += '-';
  }
  out = out.replace(/-+/g, '-').replace(/^-|-$/g, '');
  return out || fallback;
}

function matchesAny(text, entries) {
  for (const [key, patterns] of entries) {
    if (patterns.some((p) => p.test(text))) return key;
  }
  return null;
}

function detectFeatureKey(text) {
  const hits = [];
  for (const [key, patterns] of FEATURE_KEYS) {
    if (patterns.some((p) => p.test(text))) hits.push(key);
  }
  if (hits.includes('assistant_birth_global_memory')) return 'assistant_birth_global_memory';
  return hits.length === 1 ? hits[0] : null;
}

function detectStyleKey(text) {
  const keyed = matchesAny(text, STYLE_KEYS);
  if (keyed) return keyed;
  const short = /(коротк|кратк)/i.test(text);
  const direct = /(^| )(прям|сух|без лиш|без церемон|без смягч)/i.test(text);
  if (short && (direct || /ответ/i.test(text))) return 'short_direct_answers';
  const textMode = /текстов.*формат|ответ.*текст|текст.*ответ|не голос|не устн/i.test(text);
  if (textMode && !/длинн|подробн|опус/i.test(text)) return 'text_not_voice';
  return null;
}

function includesFeatureIntent(c) {
  return ['goal', 'reminder', 'constraint', 'instruction', 'open_loop', 'progress'].includes(c.memory_kind)
    || /feature|task|capability|issue|goal|reminder|note/.test(String(c.entity_type || ''));
}

function tripKey(c, text) {
  const data = c.data || {};
  const raw = [
    data.origin, data.from, data.departure, data.destination, data.to, data.arrival,
    data.date, data.passengers, data.baggage,
  ].filter(Boolean).join(' ');
  const source = raw || `${c.entity_key || ''} ${text}`;
  if (!/(trip|flight|ticket|билет|перел[её]т|хошимин|москв|багаж|пассажир)/i.test(source)) return null;
  return `trip:${slug(source).slice(0, 80)}`;
}

export function buildDedupeIdentity(domainKey, candidate) {
  const c = candidate || {};
  const text = normalizeMemoryText(`${c.memory_text || ''} ${c.entity_type || ''} ${c.entity_key || ''}`);

  const trip = tripKey(c, text);
  if (trip && domainKey === 'flight_search') {
    return { dedupeKey: `flight_search:${trip}`, scopeGroup: 'trip_context' };
  }

  for (const [pattern, name] of ASSISTANT_NAME_PATTERNS) {
    if (pattern.test(text) && /(ассистент|бот|assistant|bot|зовут|имя|называ)/i.test(text)) {
      return { dedupeKey: `profile:assistant_name:${name}`, scopeGroup: 'profile' };
    }
  }

  const style = detectStyleKey(text);
  if (style && (c.scope === 'profile' || c.scope === 'system' || c.memory_kind === 'communication_style')) {
    return { dedupeKey: `profile:communication_style:${style}`, scopeGroup: 'profile' };
  }

  const feature = detectFeatureKey(text);
  if (feature && includesFeatureIntent(c)) {
    return { dedupeKey: `feature_request:${feature}`, scopeGroup: 'feature_request' };
  }

  if (c.entity_type && c.entity_key) {
    const scopeGroup = scopeGroupFor(c);
    return {
      dedupeKey: `${domainKey}:${scopeGroup}:${slug(c.entity_type)}:${slug(c.entity_key)}`,
      scopeGroup,
    };
  }

  const scopeGroup = scopeGroupFor(c);
  return {
    dedupeKey: `${domainKey}:${scopeGroup}:text:${slug(c.memory_text).slice(0, 72)}`,
    scopeGroup,
  };
}

export function scopeGroupFor(candidate) {
  const c = candidate || {};
  if (c.memory_kind === 'communication_style' || c.scope === 'profile') return 'profile';
  if (includesFeatureIntent(c)) return 'feature_request';
  if (['open_loop', 'progress', 'state'].includes(c.memory_kind)) return 'context';
  return c.scope || 'general';
}

export function compatibleScopeGroups(group) {
  if (group === 'profile') return ['profile', 'system', 'general'];
  if (group === 'feature_request') return ['feature_request', 'profile', 'context', 'domain', 'dialog'];
  if (group === 'trip_context') return ['trip_context', 'context', 'domain', 'dialog'];
  return [group];
}

function tokenSet(text) {
  return new Set(normalizeMemoryText(text).split(' ').filter((t) => t.length > 2));
}

function jaccard(a, b) {
  const aa = tokenSet(a);
  const bb = tokenSet(b);
  if (!aa.size || !bb.size) return 0;
  let hit = 0;
  for (const t of aa) if (bb.has(t)) hit++;
  return hit / (aa.size + bb.size - hit);
}

function dataOverlap(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  if (!keys.size) return 0;
  let same = 0;
  for (const key of keys) {
    const av = a?.[key];
    const bv = b?.[key];
    if (av !== undefined && bv !== undefined && JSON.stringify(av) === JSON.stringify(bv)) same++;
  }
  return same / keys.size;
}

export function scoreSimilarity(candidate, row) {
  const identity = candidate.dedupeIdentity || buildDedupeIdentity(candidate.domainKey || 'general', candidate);
  const rowIdentity = {
    dedupeKey: row.dedupe_key || buildDedupeIdentity(row.domain_key || candidate.domainKey || 'general', row).dedupeKey,
    scopeGroup: row.metadata?.dedupe?.scope_group || scopeGroupFor(row),
  };
  const sameKey = identity.dedupeKey && rowIdentity.dedupeKey && identity.dedupeKey === rowIdentity.dedupeKey;
  const sameEntity = candidate.entity_key && row.entity_key
    && candidate.entity_key === row.entity_key && candidate.entity_type === row.entity_type;
  const compatible = compatibleScopeGroups(identity.scopeGroup).includes(rowIdentity.scopeGroup);
  const textScore = jaccard(candidate.memory_text, row.memory_text);
  const dataScore = dataOverlap(candidate.data || {}, row.data || {});
  const kindScore = candidate.memory_kind === row.memory_kind ? 1 : 0;
  const vectorScore = Number(row.vector_relevance || 0);

  let score = 0;
  if (sameKey) score = Math.max(score, 1);
  if (sameEntity && compatible) score = Math.max(score, 0.95);
  if (sameEntity) score = Math.max(score, 0.88);
  score = Math.max(score, textScore * 0.72 + dataScore * 0.12 + kindScore * 0.06 + (compatible ? 0.10 : 0));
  if (vectorScore > 0) score = Math.max(score, vectorScore * 0.82 + (compatible ? 0.08 : 0) + dataScore * 0.10);

  return {
    score: Math.min(1, score),
    sameKey,
    sameEntity,
    compatible,
    textScore,
    dataScore,
    kindScore,
    vectorScore,
    dedupeKey: identity.dedupeKey,
    scopeGroup: identity.scopeGroup,
  };
}

function specificity(row) {
  const dataKeys = Object.keys(row.data || {}).filter((k) => row.data[k] !== null && row.data[k] !== '');
  const textLen = normalizeMemoryText(row.memory_text).split(' ').length;
  return Math.min(1, textLen / 16) * 0.6 + Math.min(1, dataKeys.length / 4) * 0.4;
}

export function canonicalScore(row) {
  const updated = row.updated_at ? new Date(row.updated_at).getTime() : 0;
  const ageDays = updated ? Math.max(0, (Date.now() - updated) / 86400000) : 30;
  const recency = Math.max(0, 1 - ageDays / 90);
  return Number(row.importance || 0.5) * 0.35
    + Number(row.confidence || 0.7) * 0.25
    + recency * 0.15
    + specificity(row) * 0.15
    + Math.min(Number(row.usage_count || 0) / 10, 1) * 0.10;
}

export function chooseCanonical(rows) {
  return [...rows].sort((a, b) => canonicalScore(b) - canonicalScore(a))[0] || null;
}

export async function findDedupeCandidates({ userId, domainKey, candidate, candidateVector = null, limit = 25 }) {
  const identity = buildDedupeIdentity(domainKey, candidate);
  const domainId = await getDomainId(domainKey);
  const params = [
    userId, identity.dedupeKey, candidate.entity_type, candidate.entity_key, candidate.memory_text, limit,
    candidateVector ? vectorToSql(candidateVector) : null, domainId,
  ];
  let vectorSelect = '0::float AS vector_relevance';
  let vectorClause = '';
  if (candidateVector) {
    vectorSelect = `CASE WHEN mi.embedding IS NULL THEN 0
                    ELSE 1 - (mi.embedding <=> $7::vector) END AS vector_relevance`;
    vectorClause = `OR (mi.embedding IS NOT NULL AND (mi.embedding <=> $7::vector) < 0.22)`;
  }
  const { rows } = await query(
    `SELECT mi.id, mi.scope, mi.memory_kind, mi.entity_type, mi.entity_key, mi.memory_text, mi.data,
            mi.importance, mi.confidence, mi.sensitivity, mi.metadata, mi.dedupe_key, mi.canonical_group_id,
            mi.dedupe_status, mi.updated_at, mi.usage_count, ad.domain_key, ${vectorSelect}
       FROM mem.memory_items mi
       LEFT JOIN mem.agent_domains ad ON ad.id = mi.domain_id
      WHERE mi.user_id = $1
        AND mi.status = 'active'
        AND mi.sensitivity IN ('public','low','normal')
        AND (
          mi.dedupe_key = $2
          OR (mi.entity_type IS NOT DISTINCT FROM $3 AND mi.entity_key IS NOT DISTINCT FROM $4 AND $4 IS NOT NULL)
          OR search_tsv @@ plainto_tsquery('simple', $5)
          ${vectorClause}
        )
        AND (
          mi.domain_id IS NULL
          OR mi.domain_id = $8
          OR mi.scope IN ('profile','system','dialog')
        )
      ORDER BY mi.updated_at DESC
      LIMIT $6`,
    params,
  );
  return rows
    .map((row) => ({ ...row, dedupe: scoreSimilarity({ ...candidate, domainKey, dedupeIdentity: identity }, row) }))
    .filter((row) => row.dedupe.score >= 0.55)
    .sort((a, b) => b.dedupe.score - a.dedupe.score);
}

export function decideDedupe(candidate, similar) {
  const best = similar[0];
  const identity = candidate.dedupeIdentity || buildDedupeIdentity(candidate.domainKey || 'general', candidate);
  if (!best) return { decision: 'create_new', score: 0, dedupeKey: identity.dedupeKey, scopeGroup: identity.scopeGroup };
  const score = best.dedupe.score;
  if (score >= 0.92) {
    const sameText = normalizeMemoryText(best.memory_text) === normalizeMemoryText(candidate.memory_text);
    return {
      decision: sameText ? 'update_existing' : 'replace_existing',
      target: best,
      targetId: best.id,
      score,
      source: 'rule',
      reason: best.dedupe.sameKey ? 'same_dedupe_key' : 'high_similarity',
      dedupeKey: identity.dedupeKey,
      scopeGroup: identity.scopeGroup,
    };
  }
  if (score >= 0.78 && (best.dedupe.sameEntity || best.dedupe.textScore >= 0.55 || best.dedupe.vectorScore >= 0.86)) {
    return {
      decision: 'update_existing',
      target: best,
      targetId: best.id,
      score,
      source: 'rule',
      reason: 'probable_duplicate',
      dedupeKey: identity.dedupeKey,
      scopeGroup: identity.scopeGroup,
    };
  }
  return { decision: 'create_new', score, dedupeKey: identity.dedupeKey, scopeGroup: identity.scopeGroup };
}

export async function buildDedupeGroups({ userId, limit = 500 }) {
  const { rows } = await query(
    `SELECT mi.id, mi.scope, mi.memory_kind, mi.entity_type, mi.entity_key, mi.memory_text, mi.data,
            mi.importance, mi.confidence, mi.sensitivity, mi.metadata, mi.dedupe_key, mi.canonical_group_id,
            mi.dedupe_status, mi.updated_at, mi.usage_count, ad.domain_key
       FROM mem.memory_items mi
       LEFT JOIN mem.agent_domains ad ON ad.id = mi.domain_id
      WHERE mi.user_id = $1 AND mi.status = 'active' AND mi.sensitivity IN ('public','low','normal')
      ORDER BY mi.updated_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  const buckets = new Map();
  for (const row of rows) {
    const identity = buildDedupeIdentity(row.domain_key || 'general', row);
    const key = row.dedupe_key || identity.dedupeKey;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ ...row, dedupe_key: key, scope_group: identity.scopeGroup });
  }
  const groups = [];
  for (const [dedupeKey, items] of buckets.entries()) {
    if (items.length < 2) continue;
    const canonical = chooseCanonical(items);
    const duplicates = items.filter((item) => item.id !== canonical.id);
    groups.push({ dedupeKey, canonical, duplicates, items });
  }
  return groups.sort((a, b) => b.items.length - a.items.length);
}

export async function applyDedupeGroup({ group, source = 'maintenance' }) {
  const at = new Date().toISOString();
  const canonicalGroupId = group.canonical.canonical_group_id || group.canonical.id;
  await query(
    `UPDATE mem.memory_items
        SET dedupe_key=$2, canonical_group_id=$3, dedupe_status='canonical',
            metadata = metadata || $4::jsonb, updated_at=now()
      WHERE id=$1`,
    [group.canonical.id, group.dedupeKey, canonicalGroupId, JSON.stringify({
      dedupe: { role: 'canonical', source, dedupe_key: group.dedupeKey, at },
    })],
  );
  for (const duplicate of group.duplicates) {
    await query(
      `UPDATE mem.memory_items
          SET status='archived', dedupe_key=$2, canonical_group_id=$3, dedupe_status='duplicate',
              metadata = metadata || $4::jsonb, updated_at=now()
        WHERE id=$1 AND status='active'`,
      [duplicate.id, group.dedupeKey, canonicalGroupId, JSON.stringify({
        replaced_by: group.canonical.id,
        dedupe: {
          role: 'duplicate',
          source,
          dedupe_key: group.dedupeKey,
          replaced_by: group.canonical.id,
          score: canonicalScore(duplicate),
          at,
        },
      })],
    );
  }
  return { canonicalId: group.canonical.id, archived: group.duplicates.map((d) => d.id) };
}

export async function runMemoryDedupe({ userId, dryRun = true, limit = 500 }) {
  const groups = await buildDedupeGroups({ userId, limit });
  const result = { userId, dryRun, groups, applied: [] };
  if (!dryRun) {
    for (const group of groups) {
      result.applied.push(await applyDedupeGroup({ group }));
    }
  }
  return result;
}

export async function embedForDedupe(candidate) {
  return embed(candidate.memory_text);
}
