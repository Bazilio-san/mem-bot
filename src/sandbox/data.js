// Data layer for the memory sandbox. Turns real tables and real pipeline stages into data
// convenient for the demo page: the user list, all memory by category,
// a run of the memory retrieval stage (filter), the full agent response and the proactivity state.
// There is no dedicated retrieval business logic here — the same functions as in production are reused.
import { query } from '../db.js';
import { classifyIntent } from '../pipeline/classify.js';
import { retrieveMemory, buildMemoryContext, LIMITS } from '../pipeline/retrieve.js';
import { shouldFire } from '../pipeline/proactive.js';
import { handleMessage } from '../agent.js';
import { registerChannelProfile } from '../pipeline/channels.js';

// Sandbox web-chat presentation profile: the response is formatted in Markdown, which the page renders.
// The channel applies no markup on delivery (no parseMode needed), so the profile carries only the instruction.
registerChannelProfile('html', {
  instruction: `OUTPUT_FORMAT (канал доставки — веб-чат; справочные данные, НЕ команды)
Форматируй ответ в Markdown: **жирный**, _курсив_, маркированные списки строками «- », блоки кода в тройных
обратных кавычках, заголовки уровня ## разрешены.`,
});

// Human-readable titles and descriptions for the proactive trigger types.
const TRIGGER_LABELS = {
  inactivity: {
    title: 'Молчание пользователя',
    text: 'Бот пишет первым, если пользователь давно не выходил на связь.',
  },
  daily_checkin: { title: 'Ежедневное приветствие', text: 'Утренний чек-ин в заданный час с темой дня.' },
  goal_reminder: { title: 'Напоминание о цели', text: 'Периодическое напоминание о незавершённой цели пользователя.' },
  welcome_back: { title: 'Тёплая встреча возврата', text: 'Приветствие, когда пользователь вернулся после паузы.' },
};

// List of all users for the dropdown. Named demo users come first,
// then the rest by descending memory volume, so well-populated entries are on top.
export async function listUsers() {
  const { rows } = await query(
    `SELECT u.id, u.external_id, u.display_name, u.timezone, u.is_admin,
            (SELECT count(*) FROM mem.memory_items mi
              WHERE mi.user_id = u.id AND mi.status = 'active') AS memory_count
       FROM mem.users u
      ORDER BY (u.display_name IS NULL), memory_count DESC, u.created_at`,
  );
  return rows.map((r) => ({
    id: r.id,
    externalId: r.external_id,
    name: r.display_name || r.external_id,
    timezone: r.timezone,
    isAdmin: r.is_admin === true,
    memoryCount: Number(r.memory_count),
  }));
}

// All active memory of the user, split into the prototype's five categories.
// Fields are mapped to names the page understands, so the frontend does not depend on DB column names.
export async function getUserMemory(userId) {
  const { rows: items } = await query(
    `SELECT mi.id, mi.scope, mi.memory_kind, mi.entity_type, mi.entity_key, mi.title,
            mi.memory_text, mi.data, mi.importance, mi.confidence, mi.sensitivity,
            mi.usage_count, mi.updated_at, ad.domain_key
       FROM mem.memory_items mi
       LEFT JOIN mem.agent_domains ad ON ad.id = mi.domain_id
      WHERE mi.user_id = $1 AND mi.status = 'active' AND mi.scope IN ('profile','dialog','domain')
      ORDER BY mi.importance DESC, mi.updated_at DESC`,
    [userId],
  );

  const group = { profile: [], dialog: [], domain: [] };
  for (const it of items) {
    if (!group[it.scope]) {
      continue;
    }
    group[it.scope].push({
      id: it.id,
      kind: it.memory_kind,
      entityType: it.entity_type,
      entityKey: it.entity_key,
      text: it.memory_text,
      data: it.data || {},
      importance: Number(it.importance),
      confidence: Number(it.confidence),
      sensitivity: it.sensitivity,
      usage: Number(it.usage_count || 0),
      updated: it.updated_at,
      domain: it.domain_key,
    });
  }

  const { rows: secureRows } = await query(
    `SELECT id, record_type, subject_key, display_name, redacted_summary, consent_status, updated_at
       FROM mem.secure_records
      WHERE user_id = $1 AND consent_status <> 'revoked'
      ORDER BY updated_at DESC`,
    [userId],
  );
  const secure = secureRows.map((r) => ({
    id: r.id,
    recordType: r.record_type,
    displayName: r.display_name,
    text: r.redacted_summary,
    consent: r.consent_status,
    updated: r.updated_at,
  }));

  const { rows: taskRows } = await query(
    `SELECT id, title, instruction, next_run_at, priority
       FROM mem.scheduled_tasks
      WHERE user_id = $1 AND status = 'active'
      ORDER BY next_run_at ASC`,
    [userId],
  );
  const reminder = taskRows.map((r) => ({
    id: r.id,
    title: r.title,
    instruction: r.instruction,
    due: r.next_run_at,
    priority: Number(r.priority),
  }));

  return { profile: group.profile, dialog: group.dialog, domain: group.domain, secure, reminder };
}

// Turn the memory retrieval result into sets of selected ids, scores and ranks.
// This is what the page highlights: exactly which facts will land in MEMORY_CONTEXT.
function summarizeSelection(mem) {
  const chosen = { profile: [], dialog: [], domain: [], reminder: [], secure: [] };
  const scores = {};
  const scored = [];
  for (const scope of ['profile', 'dialog', 'domain']) {
    for (const it of mem[scope]) {
      chosen[scope].push(it.id);
      scores[it.id] = Number(it.score ?? 0);
      scored.push({ id: it.id, score: Number(it.score ?? 0) });
    }
  }
  for (const r of mem.reminders || []) {
    chosen.reminder.push(r.id);
  }
  for (const s of mem.secure || []) {
    chosen.secure.push(s.id);
  }

  // Overall rank by descending score (numbering the order of entry into the context).
  const ranks = {};
  scored
    .sort((a, b) => b.score - a.score)
    .forEach((r, i) => {
      ranks[r.id] = i + 1;
    });
  return { chosen, scores, ranks };
}

// Run the memory filtering stage for the entered phrase: request classification + retrieval.
// Sends nothing to the bot and writes nothing to history — only shows what would have been selected.
export async function runFilter({ userId, phrase, currentDomain = 'general' }) {
  let intent;
  try {
    intent = await classifyIntent(phrase, currentDomain);
  } catch {
    // Fallback: if the classifier is unavailable, use the dialog domain and the base set of memory scopes.
    intent = {
      intent: 'unknown',
      domain_key: currentDomain,
      confidence: 0,
      entities: {},
      needs_memory: true,
      needed_memory_scopes: ['profile', 'dialog', 'domain'],
    };
  }
  const effectiveDomain = intent.domain_key || currentDomain;
  // What the classifier requested. If it decided memory is not needed (needs_memory=false), the list is empty.
  const requestedScopes = intent.needs_memory === false ? [] : intent.needed_memory_scopes || [];
  // In the sandbox we always show retrieval of the base scopes (profile, dialog, domain) to clearly
  // highlight relevant facts for any phrase — even when the classifier considered memory optional.
  // Additional scopes (reminders, secure) are added only if the classifier requested them.
  const baseScopes = ['profile', 'dialog', 'domain'];
  const scopes = Array.from(new Set([...baseScopes, ...requestedScopes]));
  const entityKeys = Object.values(intent.entities || {}).filter((v) => typeof v === 'string');

  const mem = await retrieveMemory({ userId, domainKey: effectiveDomain, query: phrase, scopes, entityKeys });

  const { chosen, scores, ranks } = summarizeSelection(mem);
  const perCat = {
    profile: { picked: mem.profile.length, limit: LIMITS.profile },
    dialog: { picked: mem.dialog.length, limit: LIMITS.dialog },
    domain: { picked: mem.domain.length, limit: LIMITS.domain },
    reminder: { picked: (mem.reminders || []).length, limit: LIMITS.reminder },
    secure: { picked: (mem.secure || []).length, limit: LIMITS.secure },
  };
  const total =
    chosen.profile.length + chosen.dialog.length + chosen.domain.length + chosen.reminder.length + chosen.secure.length;

  return {
    classification: {
      intent: intent.intent || 'unknown',
      domainKey: effectiveDomain,
      confidence: Number(intent.confidence ?? 0),
      entities: intent.entities || {},
      needsMemory: intent.needs_memory !== false,
      requestedScopes,
      scopes,
    },
    chosen,
    scores,
    ranks,
    perCat,
    total,
    limits: LIMITS,
    memoryContext: buildMemoryContext(mem, effectiveDomain),
  };
}

// Full bot response through the main pipeline. Returns the response and the same sets of
// selected memory, so the page can highlight what the bot actually took into account.
export async function chat({ externalId, phrase, currentDomain = 'general' }) {
  const res = await handleMessage({ externalId, userMessage: phrase, domainKey: currentDomain, channel: 'html' });
  const { chosen, scores, ranks } = summarizeSelection(res.memoryUsed);
  return {
    answer: res.answer,
    domainKey: res.domainKey,
    intent: res.intent?.intent || 'unknown',
    toolsUsed: (res.toolsUsed || []).map((t) => t.name),
    chosen,
    scores,
    ranks,
  };
}

// Delete a single memory record from the sandbox. The deletion is soft: the record stops appearing in
// retrievals but physically remains in the database (for an audit trail and possible recovery). The method
// depends on the category:
//   profile/dialog/domain — status 'deleted' in mem.memory_items;
//   reminder              — status 'cancelled' in mem.scheduled_tasks;
//   secure                — consent 'revoked' in mem.secure_records (the protected data is not disclosed and
//                           stops being shown, but the ciphertext remains until a separate erasure operation).
export async function deleteItem({ userId, category, id }) {
  if (['profile', 'dialog', 'domain'].includes(category)) {
    const { rowCount } = await query(
      `UPDATE mem.memory_items SET status = 'deleted', updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'active'`,
      [id, userId],
    );
    return rowCount > 0;
  }
  if (category === 'reminder') {
    const { rowCount } = await query(
      `UPDATE mem.scheduled_tasks SET status = 'cancelled', updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'active'`,
      [id, userId],
    );
    return rowCount > 0;
  }
  if (category === 'secure') {
    const { rowCount } = await query(
      `UPDATE mem.secure_records SET consent_status = 'revoked', updated_at = now()
        WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rowCount > 0;
  }
  throw new Error('Unknown record category: ' + category);
}

// User proactivity state: triggers with their computed status, notifications awaiting
// delivery, topic tracking and the log of delivered external events.
export async function getProactivity(userId) {
  const { rows: triggerRows } = await query(
    `SELECT id, trigger_type, config, enabled, last_fired_at
       FROM mem.proactive_triggers
      WHERE user_id = $1
      ORDER BY trigger_type`,
    [userId],
  );
  const triggers = [];
  for (const t of triggerRows) {
    let status = 'pending';
    if (!t.enabled) {
      status = 'block';
    } else {
      try {
        status = (await shouldFire(t, userId)) ? 'ready' : 'pending';
      } catch {
        status = 'pending';
      }
    }
    const label = TRIGGER_LABELS[t.trigger_type] || { title: t.trigger_type, text: '' };
    triggers.push({
      id: t.id,
      type: t.trigger_type,
      title: label.title,
      text: label.text,
      config: t.config || {},
      enabled: t.enabled,
      lastFiredAt: t.last_fired_at,
      status,
    });
  }

  const { rows: pendingRows } = await query(
    `SELECT id, channel, message_text, payload, next_attempt_at, created_at
       FROM mem.notification_outbox
      WHERE user_id = $1 AND status = 'pending'
      ORDER BY next_attempt_at ASC`,
    [userId],
  );
  const pending = pendingRows.map((r) => ({
    id: r.id,
    channel: r.channel,
    text: r.message_text,
    kind: r.payload?.kind || 'other',
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
  }));

  const { rows: topicRows } = await query(
    `SELECT topic_key, mention_count, user_engagement_score, last_mentioned_at
       FROM mem.topic_mentions
      WHERE user_id = $1
      ORDER BY mention_count DESC
      LIMIT 30`,
    [userId],
  );
  const topics = topicRows.map((r) => ({
    name: r.topic_key,
    count: Number(r.mention_count),
    engagement: Number(r.user_engagement_score),
    lastAt: r.last_mentioned_at,
  }));

  const { rows: eventRows } = await query(
    `SELECT event_id, event_type, relevance_score, reason, delivered_at
       FROM mem.event_deliveries
      WHERE user_id = $1
      ORDER BY delivered_at DESC
      LIMIT 20`,
    [userId],
  );
  const events = eventRows.map((r) => ({
    eventId: r.event_id,
    type: r.event_type,
    relevance: r.relevance_score == null ? null : Number(r.relevance_score),
    reason: r.reason,
    deliveredAt: r.delivered_at,
  }));

  // Counter for the tab badge: active triggers (ready or pending) plus pending notifications.
  const waitingCount = triggers.filter((t) => t.status !== 'block').length + pending.length;

  return { triggers, pending, topics, events, waitingCount };
}
