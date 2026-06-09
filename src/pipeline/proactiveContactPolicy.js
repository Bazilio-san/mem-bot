// Каналонезависимая политика контакта для проактивных сообщений.
// Решает, можно ли писать пользователю, только по состоянию, времени и типу кандидата.
import { config } from '../config.js';
import { query } from '../db.js';

const SOFT_KINDS = new Set(['soft_proactive']);
const DEFAULT_STATE = {
  mode: 'active',
  last_proactive_sent_at: null,
  last_soft_proactive_sent_at: null,
  last_user_reply_after_proactive_at: null,
  unanswered_proactive_count: 0,
  ignored_soft_count_7d: 0,
  daily_soft_count: 0,
  daily_requested_reminder_count: 0,
  weekly_soft_count: 0,
  quiet_until: null,
  last_trigger_type: null,
  last_topic_key: null,
};

function asDate(value) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

function minutesSince(value, now) {
  const d = asDate(value);
  if (!d) {
    return Infinity;
  }
  return (now.getTime() - d.getTime()) / 60000;
}

function result(allowed, reason, nextCheckAt = null) {
  return { allowed, reason, nextCheckAt };
}

function modeFor({ unanswered, quietUntil, now }) {
  if (quietUntil && now < quietUntil) {
    return 'quiet';
  }
  if (unanswered >= config.proactive.contactPolicy.quietAfterUnanswered) {
    return 'quiet';
  }
  if (unanswered > 0) {
    return 'cautious';
  }
  return 'active';
}

export function normalizeCandidate(candidate = {}) {
  return {
    triggerType: candidate.triggerType || candidate.trigger_type || 'inactivity',
    messageKind: candidate.messageKind || candidate.message_kind || 'soft_proactive',
    importance: candidate.importance || 'normal',
    topicKey: candidate.topicKey || candidate.topic_key || null,
  };
}

export function classifyTriggerCandidate(trigger) {
  if (trigger.trigger_type === 'daily_checkin') {
    return normalizeCandidate({
      triggerType: trigger.trigger_type,
      messageKind: 'social_proactive',
      importance: 'low',
      topicKey: 'daily_checkin',
    });
  }
  if (trigger.trigger_type === 'goal_reminder') {
    return normalizeCandidate({
      triggerType: trigger.trigger_type,
      messageKind: 'soft_proactive',
      importance: trigger.config?.importance || 'normal',
      topicKey: trigger.config?.topic_key || 'goal',
    });
  }
  if (trigger.trigger_type === 'welcome_back') {
    return normalizeCandidate({
      triggerType: trigger.trigger_type,
      messageKind: 'social_proactive',
      importance: 'low',
      topicKey: 'welcome_back',
    });
  }
  return normalizeCandidate({
    triggerType: trigger.trigger_type,
    messageKind: 'soft_proactive',
    importance: trigger.config?.importance || 'normal',
    topicKey: trigger.config?.topic_key || trigger.trigger_type,
  });
}

export function classifyEventCandidate(event = {}) {
  return normalizeCandidate({
    triggerType: 'event',
    messageKind: event.critical ? 'critical' : 'soft_proactive',
    importance: event.critical ? 'critical' : 'normal',
    topicKey: event.category || event.type || 'event',
  });
}

export function classifyReminderCandidate(task = {}) {
  return normalizeCandidate({
    triggerType: 'scheduled_reminder',
    messageKind: task.payload?.critical ? 'critical' : 'requested_reminder',
    importance: task.payload?.critical ? 'critical' : 'normal',
    topicKey: task.payload?.topic_key || task.title || 'scheduled_reminder',
  });
}

export function evaluateContactPolicy({ state = DEFAULT_STATE, candidate: rawCandidate, now = new Date() }) {
  const candidate = normalizeCandidate(rawCandidate);
  const policy = config.proactive.contactPolicy;
  const quietUntil = asDate(state.quiet_until);
  const unanswered = Number(state.unanswered_proactive_count || 0);

  if (candidate.messageKind === 'critical' || candidate.importance === 'critical') {
    return result(true, 'critical');
  }

  if (quietUntil && now < quietUntil) {
    return result(false, 'quiet_until_active', quietUntil);
  }

  if (candidate.messageKind === 'social_proactive') {
    return result(false, 'social_requires_incoming_user_message');
  }

  if (candidate.messageKind === 'requested_reminder') {
    if (Number(state.daily_requested_reminder_count || 0) >= policy.requestedReminderDailyLimit) {
      return result(false, 'requested_reminder_daily_limit');
    }
    return result(true, 'requested_reminder_budget_ok');
  }

  if (unanswered >= policy.quietAfterUnanswered) {
    return result(false, 'silent_until_user_reply');
  }

  if (unanswered >= 1 && candidate.importance !== 'high') {
    return result(false, 'unanswered_soft_proactive');
  }

  const highFollowUp = unanswered >= 1 && candidate.importance === 'high';

  if (!highFollowUp && Number(state.daily_soft_count || 0) >= policy.softDailyLimit) {
    return result(false, 'soft_daily_limit');
  }

  if (!highFollowUp && Number(state.weekly_soft_count || 0) >= policy.softWeeklyLimit) {
    return result(false, 'soft_weekly_limit');
  }

  if (minutesSince(state.last_soft_proactive_sent_at, now) < policy.minSoftPauseMinutes) {
    return result(false, 'soft_min_pause');
  }

  if (!highFollowUp && state.last_topic_key && state.last_topic_key === candidate.topicKey && unanswered > 0) {
    return result(false, 'ignored_topic');
  }

  return result(true, 'active_budget_ok');
}

export async function ensureContactState(userId, now = new Date()) {
  const { rows } = await query(
    `INSERT INTO mem.proactive_contact_state (user_id, counters_day, counters_week)
     VALUES ($1, $2::date, date_trunc('week', $2::timestamptz)::date)
     ON CONFLICT (user_id) DO UPDATE SET
       daily_soft_count = CASE
         WHEN mem.proactive_contact_state.counters_day < $2::date THEN 0
         ELSE mem.proactive_contact_state.daily_soft_count
       END,
       daily_requested_reminder_count = CASE
         WHEN mem.proactive_contact_state.counters_day < $2::date THEN 0
         ELSE mem.proactive_contact_state.daily_requested_reminder_count
       END,
       weekly_soft_count = CASE
         WHEN mem.proactive_contact_state.counters_week < date_trunc('week', $2::timestamptz)::date THEN 0
         ELSE mem.proactive_contact_state.weekly_soft_count
       END,
       counters_day = GREATEST(mem.proactive_contact_state.counters_day, $2::date),
       counters_week = GREATEST(mem.proactive_contact_state.counters_week, date_trunc('week', $2::timestamptz)::date),
       updated_at = now()
     RETURNING *`,
    [userId, now],
  );
  return rows[0];
}

export async function getContactState(userId, now = new Date()) {
  return ensureContactState(userId, now);
}

export async function recordProactiveSent({ userId, candidate: rawCandidate, sentAt = new Date() }) {
  const candidate = normalizeCandidate(rawCandidate);
  await ensureContactState(userId, sentAt);
  const isSoft = SOFT_KINDS.has(candidate.messageKind);
  const isRequested = candidate.messageKind === 'requested_reminder';
  const policy = config.proactive.contactPolicy;
  const { rows } = await query(
    `UPDATE mem.proactive_contact_state
        SET mode = CASE
              WHEN $3 THEN CASE
                WHEN unanswered_proactive_count + 1 >= $5::int THEN 'quiet'
                WHEN unanswered_proactive_count + 1 > 0 THEN 'cautious'
                ELSE 'active'
              END
              ELSE mode
            END,
            last_proactive_sent_at = $2,
            last_soft_proactive_sent_at = CASE WHEN $3 THEN $2 ELSE last_soft_proactive_sent_at END,
            unanswered_proactive_count = CASE
              WHEN $3 THEN unanswered_proactive_count + 1
              ELSE unanswered_proactive_count
            END,
            ignored_soft_count_7d = CASE WHEN $3 THEN ignored_soft_count_7d + 1 ELSE ignored_soft_count_7d END,
            daily_soft_count = CASE WHEN $3 THEN daily_soft_count + 1 ELSE daily_soft_count END,
            weekly_soft_count = CASE WHEN $3 THEN weekly_soft_count + 1 ELSE weekly_soft_count END,
            daily_requested_reminder_count = CASE
              WHEN $4 THEN daily_requested_reminder_count + 1
              ELSE daily_requested_reminder_count
            END,
            quiet_until = CASE
              WHEN $3 AND unanswered_proactive_count + 1 >= $5::int
              THEN $2::timestamptz + ($6::int * interval '1 hour')
              ELSE quiet_until
            END,
            last_trigger_type = $7,
            last_topic_key = $8,
            updated_at = now()
      WHERE user_id = $1
      RETURNING *`,
    [
      userId,
      sentAt,
      isSoft,
      isRequested,
      policy.quietAfterUnanswered,
      policy.quietHoursAfterIgnores,
      candidate.triggerType,
      candidate.topicKey,
    ],
  );
  return rows[0];
}

export async function recordUserInboundForContactPolicy({
  userId,
  messageAt = new Date(),
  previousUserMessageAt = null,
}) {
  const state = await ensureContactState(userId, messageAt);
  const previous = asDate(previousUserMessageAt);
  const gapMinutes = previous ? minutesSince(previous, messageAt) : null;
  const wasWaiting =
    Number(state.unanswered_proactive_count || 0) > 0 ||
    Boolean(state.quiet_until && messageAt < asDate(state.quiet_until));
  const welcomeBack =
    gapMinutes !== null &&
    gapMinutes >= config.proactive.welcomeBackGapMinutes &&
    (wasWaiting || gapMinutes >= config.proactive.inactivityMinutes);
  const { rows } = await query(
    `UPDATE mem.proactive_contact_state
        SET mode = 'active',
            last_user_reply_after_proactive_at = CASE
              WHEN last_proactive_sent_at IS NOT NULL AND last_proactive_sent_at < $2
              THEN $2 ELSE last_user_reply_after_proactive_at END,
            unanswered_proactive_count = 0,
            quiet_until = NULL,
            updated_at = now()
      WHERE user_id = $1
      RETURNING *`,
    [userId, messageAt],
  );
  return { stateBefore: state, stateAfter: rows[0], welcomeBack, gapMinutes };
}

export function contactMode(state, now = new Date()) {
  return modeFor({
    unanswered: Number(state?.unanswered_proactive_count || 0),
    quietUntil: asDate(state?.quiet_until),
    now,
  });
}

export function chooseBestAllowed(allowed = []) {
  const priority = {
    critical: 100,
    scheduled_reminder: 90,
    goal_reminder: 70,
    event: 60,
    inactivity: 40,
    daily_checkin: 10,
  };
  return (
    allowed.sort((a, b) => {
      const pa = priority[a.candidate.triggerType] || 0;
      const pb = priority[b.candidate.triggerType] || 0;
      if (pb !== pa) {
        return pb - pa;
      }
      if (a.candidate.importance === 'high' && b.candidate.importance !== 'high') {
        return -1;
      }
      if (b.candidate.importance === 'high' && a.candidate.importance !== 'high') {
        return 1;
      }
      return 0;
    })[0] || null
  );
}
