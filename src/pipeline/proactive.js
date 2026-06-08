// Проактивный контур (критерии 15 и 16): бот сам пишет первым по уместному поводу.
// Проверяет триггеры пользователя, применяет анти-спам (last_fired_at), генерирует и доставляет сообщение.
// Доставка переиспользует существующую очередь mem.notification_outbox и сохранение реплики в историю диалога.
import { config } from '../config.js';
import { query } from '../db.js';
import { ensureConversation, saveMessage, getLastUserMessageTime, listUsersWithTriggers } from '../repo.js';
import { buildProactiveMessage } from './proactiveMessage.js';
import {
  chooseBestAllowed, classifyTriggerCandidate, contactMode, evaluateContactPolicy,
  getContactState, recordProactiveSent,
} from './proactiveContactPolicy.js';

// Анти-спам: срабатывал ли триггер за последние N минут.
function firedRecently(lastFiredAt, minutes) {
  if (!lastFiredAt) return false;
  return (Date.now() - new Date(lastFiredAt).getTime()) / 60000 < minutes;
}

// Анти-спам: срабатывал ли триггер уже сегодня (для ежедневного приветствия).
function firedToday(lastFiredAt) {
  if (!lastFiredAt) return false;
  const d = new Date(lastFiredAt), n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

async function lastInactivityMinutes(userId) {
  const last = await getLastUserMessageTime(userId);
  if (!last) return null;
  return (Date.now() - last.getTime()) / 60000;
}

// Проверка одного триггера. Возвращает true, если нужно сработать.
export async function shouldFire(trigger, userId) {
  const cfg = trigger.config || {};
  if (trigger.trigger_type === 'inactivity') {
    const idle = await lastInactivityMinutes(userId);
    const threshold = cfg.minutes_inactive ?? config.proactive.inactivityMinutes;
    if (idle === null || idle < threshold) return false;
    return !firedRecently(trigger.last_fired_at, threshold);
  }
  if (trigger.trigger_type === 'daily_checkin') {
    const hour = cfg.hour ?? config.proactive.checkinHour;
    if (new Date().getHours() !== hour) return false;
    return !firedToday(trigger.last_fired_at);
  }
  if (trigger.trigger_type === 'goal_reminder') {
    const interval = cfg.interval_minutes ?? config.proactive.goalIntervalMinutes;
    if (firedRecently(trigger.last_fired_at, interval)) return false;
    const { rows } = await query(
      `SELECT 1 FROM mem.memory_items
        WHERE user_id = $1 AND status = 'active' AND memory_kind = 'goal' LIMIT 1`, [userId]);
    return rows.length > 0;
  }
  if (trigger.trigger_type === 'welcome_back') {
    return false;
  }
  return false;
}

// Сгенерировать и доставить проактивное сообщение, затем обновить last_fired_at.
export async function fire(trigger, user, { candidate = null, state = null } = {}) {
  const effectiveCandidate = candidate || classifyTriggerCandidate(trigger);
  const effectiveState = state || await getContactState(user.id);
  const conversation = await ensureConversation(user.id, 'general');
  const text = await buildProactiveMessage({
    userId: user.id, domainKey: 'general',
    triggerType: trigger.trigger_type, timezone: user.timezone || config.timezone,
    candidate: effectiveCandidate, contactMode: contactMode(effectiveState),
  });
  if (!text || !text.trim()) return false;

  // Доставка 1: сообщение появляется в истории диалога как реплика ассистента.
  const message = await saveMessage(conversation.id, user.id, 'assistant', text);
  // Доставка 2: очередь внешней доставки (Telegram, push, e-mail — как доделка базового требования).
  await query(
    `INSERT INTO mem.notification_outbox (user_id, channel, message_text, payload)
     VALUES ($1, 'default', $2, $3::jsonb)`,
    [user.id, text, JSON.stringify({
      kind: 'proactive',
      trigger: trigger.trigger_type,
      conversation_message_id: message.id,
    })],
  );

  await query(
    `UPDATE mem.proactive_triggers SET last_fired_at = now(), updated_at = now() WHERE id = $1`,
    [trigger.id],
  );
  await recordProactiveSent({ userId: user.id, candidate: effectiveCandidate });
  return true;
}

// Один проход проактивности по всем пользователям с включёнными триггерами.
export async function checkProactiveTriggers() {
  if (!config.proactive.enabled) return { fired: 0 };
  const users = await listUsersWithTriggers();
  let fired = 0;
  for (const user of users) {
    const { rows: triggers } = await query(
      `SELECT * FROM mem.proactive_triggers WHERE user_id = $1 AND enabled = true`, [user.id]);
    const state = await getContactState(user.id);
    const allowed = [];
    for (const t of triggers) {
      try {
        if (!await shouldFire(t, user.id)) continue;
        const candidate = classifyTriggerCandidate(t);
        const decision = evaluateContactPolicy({ state, candidate });
        if (decision.allowed) allowed.push({ trigger: t, candidate, decision });
      } catch (err) {
        console.error('Проактивный триггер не сработал:', t.trigger_type, err.message);
      }
    }
    const chosen = chooseBestAllowed(allowed);
    if (chosen) {
      try {
        if (await fire(chosen.trigger, user, { candidate: chosen.candidate, state })) fired++;
      } catch (err) {
        console.error('Проактивный триггер не сработал:', chosen.trigger.trigger_type, err.message);
      }
    }
  }
  return { fired };
}
