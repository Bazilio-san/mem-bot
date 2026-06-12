// Data layer for the admin panel. Turns real tables and real pipeline stages into data
// convenient for the admin UI: the user list, all memory by category and the proactivity state.
// There is no dedicated retrieval business logic here — the same functions as in production are reused.
import { query } from '../db.js';
import { shouldFire } from '../pipeline/proactive.js';

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

// List of all users for the dropdown. Named users come first,
// then the rest by descending memory volume, so well-populated entries are on top.
export async function listUsers() {
  const { rows } = await query(
    `SELECT u.id, u.external_id, u.display_name, u.timezone, u.is_admin,
            (SELECT count(*) FROM mem.user_facts uf
              WHERE uf.user_id = u.id AND uf.status = 'active') AS memory_count
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
// Grouping of flat facts: open_loop → dialog (unclosed threads), facts with a non-empty domain → domain,
// everything else (the general domain) → profile.
export async function getUserMemory(userId) {
  const { rows: items } = await query(
    `SELECT id, domain_key, fact_type, fact_text, confidence, evidence_count, last_confirmed_at, updated_at
       FROM mem.user_facts
      WHERE user_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
      ORDER BY confidence DESC, updated_at DESC`,
    [userId],
  );

  const group = { profile: [], dialog: [], domain: [] };
  for (const it of items) {
    const groupKey = it.fact_type === 'open_loop' ? 'dialog' : it.domain_key !== 'general' ? 'domain' : 'profile';
    group[groupKey].push({
      id: it.id,
      kind: it.fact_type,
      text: it.fact_text,
      confidence: Number(it.confidence),
      usage: Number(it.evidence_count || 1),
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

// Full deletion of a user with all their data. A single DELETE on mem.users: related tables (dialogs,
// messages, facts, scheduler tasks, notifications, etc.) are declared with ON DELETE CASCADE and are
// removed atomically at the DB level. Logs are preserved: in mem.tool_calls the user reference is nulled
// by an ON DELETE SET NULL rule, and the LLM request journal lives in a separate log DB with no foreign
// keys to mem.users. Returns true if the user existed and was deleted.
export async function deleteUser(userId) {
  const { rowCount } = await query('DELETE FROM mem.users WHERE id = $1', [userId]);
  return rowCount > 0;
}

// Delete a single memory record. The deletion is soft: the record stops appearing in
// retrievals but physically remains in the database (for an audit trail and possible recovery). The method
// depends on the category:
//   profile/dialog/domain — status 'deleted' in mem.user_facts;
//   reminder              — status 'cancelled' in mem.scheduled_tasks;
//   secure                — consent 'revoked' in mem.secure_records (the protected data is not disclosed and
//                           stops being shown, but the ciphertext remains until a separate erasure operation).
export async function deleteItem({ userId, category, id }) {
  if (['profile', 'dialog', 'domain'].includes(category)) {
    const { rowCount } = await query(
      `UPDATE mem.user_facts SET status = 'deleted', updated_at = now()
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
