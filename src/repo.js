// Data access layer: users, domains, conversations, messages.
import { query } from './db.js';
import { config } from './config.js';
import { estimateTokens } from './pipeline/token-counter.js';
import { normalizeVoiceId } from './voice/voices.js';

// Find or create a user by external id (e.g. a Telegram ID).
// The is_test flag marks technical autotest users the same way log.llm_request.is_test
// marks journal records of a test run: by default it is taken from NODE_ENV === 'test',
// so every user created during a test run (including implicitly via
// handleMessage) is marked as test without edits in each test. For an existing user the
// flag is not re-set: the ON CONFLICT branch updates only updated_at.
export async function ensureUser(
  externalId,
  { displayName = null, locale = 'ru', timezone = 'Europe/Moscow', isTest = process.env.NODE_ENV === 'test' } = {},
) {
  const { rows } = await query(
    `INSERT INTO mem.users (external_id, display_name, locale, timezone, is_test)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (external_id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [externalId, displayName, locale, timezone, isTest],
  );
  return rows[0];
}

// Save the sender's Telegram profile into mem.users: display_name is assembled from the first and last name
// (falling back to the username), and the raw profile fields (id, username, names, language code, premium flag)
// land in metadata.telegram. The upsert is cheap to call on every incoming message: the DO UPDATE branch fires
// only when something actually changed, so an unchanged profile produces no row update. A missing sender object
// or a bot sender is ignored. This is how the bot learns the user's name already at the first /start.
export async function syncTelegramProfile(externalId, from, { isTest = process.env.NODE_ENV === 'test' } = {}) {
  if (!from || from.is_bot) {
    return;
  }
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ').trim() || from.username || null;
  const profile = {
    user_id: from.id ?? null,
    username: from.username ?? null,
    first_name: from.first_name ?? null,
    last_name: from.last_name ?? null,
    language_code: from.language_code ?? null,
    is_premium: from.is_premium === true,
  };
  await query(
    `INSERT INTO mem.users AS u (external_id, display_name, is_test, metadata)
     VALUES ($1, $2, $3, jsonb_build_object('telegram', $4::jsonb))
     ON CONFLICT (external_id) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, u.display_name),
           metadata = u.metadata || EXCLUDED.metadata,
           updated_at = now()
     WHERE u.display_name IS DISTINCT FROM COALESCE(EXCLUDED.display_name, u.display_name)
        OR u.metadata -> 'telegram' IS DISTINCT FROM EXCLUDED.metadata -> 'telegram'`,
    [externalId, displayName, isTest, JSON.stringify(profile)],
  );
}

const domainCache = new Map();

// Get a domain id by its key (with caching).
export async function getDomainId(domainKey) {
  if (domainCache.has(domainKey)) {
    return domainCache.get(domainKey);
  }
  const { rows } = await query('SELECT id FROM mem.agent_domains WHERE domain_key = $1', [domainKey]);
  const id = rows[0]?.id ?? null;
  if (id) {
    domainCache.set(domainKey, id);
  }
  return id;
}

// List all agent domains (key and title) — options for domain selects in the admin panel.
export async function listDomains() {
  const { rows } = await query('SELECT domain_key, title FROM mem.agent_domains ORDER BY domain_key');
  return rows.map((r) => ({ domainKey: r.domain_key, title: r.title }));
}

// Find or create the user's active conversation in the given domain.
export async function ensureConversation(userId, domainKey = 'general') {
  const domainId = await getDomainId(domainKey);
  const existing = await query(
    `SELECT * FROM mem.conversations WHERE user_id = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT 1`,
    [userId],
  );
  if (existing.rows[0]) {
    return existing.rows[0];
  }
  const { rows } = await query(`INSERT INTO mem.conversations (user_id, domain_id) VALUES ($1, $2) RETURNING *`, [
    userId,
    domainId,
  ]);
  return rows[0];
}

// Save a single conversation message. Additionally sets token_count (an estimate of the message size),
// which is needed to compute the cold-zone size when compressing history. The tool_name and tool_call_id
// fields (the tool-call log) and updating the conversation's updated_at are preserved unchanged.
// extra.createdAt lets the caller pass the real event time (e.g. when the user's message was received):
// the row is inserted at the END of the pipeline, so now() would put it after all the cycle's events
// and break the chronology of the timeline and the log viewer.
export async function saveMessage(conversationId, userId, role, content, extra = {}) {
  const tokenCount = estimateTokens(content);
  const { rows } = await query(
    `INSERT INTO mem.conversation_messages
       (conversation_id, user_id, role, content, tool_name, tool_call_id, token_count, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now()))
     RETURNING *`,
    [
      conversationId,
      userId,
      role,
      content,
      extra.toolName ?? null,
      extra.toolCallId ?? null,
      tokenCount,
      extra.metadata ?? {},
      extra.createdAt ?? null,
    ],
  );
  await query('UPDATE mem.conversations SET updated_at = now() WHERE id = $1', [conversationId]);
  return rows[0];
}

// Link an internal history message to the message id in the external delivery channel.
// This lets the reactions handler find which assistant message the user reacted to.
export async function saveMessageExternalRef({
  conversationMessageId,
  channel,
  chatExternalId,
  messageExternalId,
  metadata = {},
}) {
  const { rows } = await query(
    `INSERT INTO mem.message_external_refs
       (conversation_message_id, channel, chat_external_id, message_external_id, metadata)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (channel, chat_external_id, message_external_id)
     DO UPDATE SET conversation_message_id = EXCLUDED.conversation_message_id,
                   metadata = mem.message_external_refs.metadata || EXCLUDED.metadata
     RETURNING *`,
    [conversationMessageId, channel, String(chatExternalId), String(messageExternalId), metadata],
  );
  return rows[0];
}

// Find an internal message by the external channel id.
export async function findMessageByExternalRef({ channel, chatExternalId, messageExternalId }) {
  const { rows } = await query(
    `SELECT cm.*, d.domain_key, mer.channel, mer.chat_external_id, mer.message_external_id
       FROM mem.message_external_refs mer
       JOIN mem.conversation_messages cm ON cm.id = mer.conversation_message_id
       JOIN mem.conversations c ON c.id = cm.conversation_id
       LEFT JOIN mem.agent_domains d ON d.id = c.domain_id
      WHERE mer.channel = $1 AND mer.chat_external_id = $2 AND mer.message_external_id = $3
      LIMIT 1`,
    [channel, String(chatExternalId), String(messageExternalId)],
  );
  return rows[0] || null;
}

// Get the active cold-zone summary of the conversation (the latest one marked is_active).
export async function getActiveConversationSummary(conversationId) {
  const { rows } = await query(
    `SELECT * FROM mem.conversation_summaries
     WHERE conversation_id = $1 AND is_active = true
     ORDER BY created_at DESC
     LIMIT 1`,
    [conversationId],
  );
  return rows[0] || null;
}

// Deactivate all active summaries of the conversation (before inserting a new active one).
export async function markOldSummariesInactive(conversationId) {
  await query(
    `UPDATE mem.conversation_summaries
     SET is_active = false
     WHERE conversation_id = $1 AND is_active = true`,
    [conversationId],
  );
}

// Cold-zone messages not yet covered by the active summary: older than the hot-window boundary
// (beforeCreatedAt) and newer than the last covered message (afterMessageId). In ascending time order.
export async function getColdPendingMessages({ conversationId, beforeCreatedAt, afterMessageId = null }) {
  const { rows } = await query(
    `SELECT id, role, content, tool_name, token_count, created_at
     FROM mem.conversation_messages
     WHERE conversation_id = $1
       AND created_at < $2
       AND ($3::uuid IS NULL OR created_at > (
             SELECT created_at FROM mem.conversation_messages WHERE id = $3))
     ORDER BY created_at ASC`,
    [conversationId, beforeCreatedAt, afterMessageId],
  );
  return rows;
}

// Save a new active cold-zone summary. The previous active summaries are deactivated.
// The token sizes (source_token_count, summary_token_count) arrive already computed by our code.
export async function saveConversationSummary({
  conversationId,
  userId,
  summaryText,
  stateJson = {},
  importance = 0.5,
  layer = 'full',
  coveredFromMessageId = null,
  coveredToMessageId = null,
  coveredUntil = null,
  sourceMessageCount = 0,
  sourceTokenCount = 0,
  summaryTokenCount = 0,
  memoryDedupe = {},
}) {
  await markOldSummariesInactive(conversationId);
  const { rows } = await query(
    `INSERT INTO mem.conversation_summaries (
       conversation_id, user_id, summary_text, state_json, importance,
       layer, covered_from_message_id, covered_to_message_id, covered_until,
       source_message_count, source_token_count, summary_token_count, memory_dedupe,
       summary_version, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,true)
     RETURNING *`,
    [
      conversationId,
      userId,
      summaryText,
      stateJson,
      importance,
      layer,
      coveredFromMessageId,
      coveredToMessageId,
      coveredUntil,
      sourceMessageCount,
      sourceTokenCount,
      summaryTokenCount,
      memoryDedupe,
    ],
  );
  return rows[0];
}

// Get the latest conversation messages in chronological order.
export async function getRecentMessages(conversationId, limit = 10) {
  const { rows } = await query(
    `SELECT role, content, tool_name, metadata, created_at
     FROM mem.conversation_messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, limit],
  );
  return rows.reverse();
}

// Дописать саммари ответа ассистента в metadata сообщения. Саммари считается асинхронно после
// доставки ответа, поэтому это отдельный UPDATE, а не часть saveMessage.
export async function setMessageSummary(messageId, summary) {
  await query(
    `UPDATE mem.conversation_messages
        SET metadata = metadata || jsonb_build_object('summary', $2::text)
      WHERE id = $1`,
    [messageId, summary],
  );
}

// Record a tool call in the log (for debugging and auditing).
export async function logToolCall({
  conversationId,
  userId,
  toolName,
  toolCallId,
  input,
  output,
  status,
  latencyMs,
  error,
}) {
  await query(
    `INSERT INTO mem.tool_calls (conversation_id, user_id, tool_name, tool_call_id, input_json, output_json, status, latency_ms, error_text, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
    [
      conversationId,
      userId,
      toolName,
      toolCallId ?? null,
      input ?? {},
      output ?? null,
      status,
      latencyMs ?? null,
      error ?? null,
    ],
  );
}

// Time of the user's last message (for the temporal context and the welcome-back trigger).
export async function getLastUserMessageTime(userId) {
  const { rows } = await query(
    `SELECT max(cm.created_at) AS last_at
       FROM mem.conversation_messages cm
      WHERE cm.user_id = $1 AND cm.role = 'user'`,
    [userId],
  );
  return rows[0]?.last_at ? new Date(rows[0].last_at) : null;
}

// All users for whom proactivity is enabled by the master flag AND who have at least one enabled trigger.
// The user's master flag (proactivity_enabled) sits above the per-trigger enabled: if the user's circuit is
// turned off entirely, none of their triggers enter the proactivity pass.
export async function listUsersWithTriggers() {
  const { rows } = await query(
    `SELECT DISTINCT u.id, u.external_id, u.timezone
       FROM mem.users u
       JOIN mem.proactive_triggers pt ON pt.user_id = u.id AND pt.enabled = true
      WHERE u.proactivity_enabled = true`,
  );
  return rows;
}

// The default set of proactivity triggers with firing thresholds from the configuration.
// Used at the moment the user enables proactivity.
export function defaultProactiveTriggers() {
  return [
    { trigger_type: 'inactivity', config: { minutes_inactive: config.proactive.inactivityMinutes } },
    { trigger_type: 'daily_checkin', config: { hour: config.proactive.checkinHour } },
    { trigger_type: 'goal_reminder', config: { interval_minutes: config.proactive.goalIntervalMinutes } },
    { trigger_type: 'welcome_back', config: { gap_minutes: config.proactive.welcomeBackGapMinutes } },
  ];
}

// Idempotent creation of the default trigger set for a user. By default the triggers are created
// disabled (enabled = false): enabling specific occasions is a separate explicit user action.
export async function ensureDefaultTriggers(userId, domainId, defaults, { enabled = false } = {}) {
  for (const t of defaults) {
    await query(
      `INSERT INTO mem.proactive_triggers (user_id, domain_id, trigger_type, config, enabled)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (user_id, trigger_type) DO NOTHING`,
      [userId, domainId, t.trigger_type, JSON.stringify(t.config || {}), enabled],
    );
  }
}

// Toggle the user's proactivity master flag. When enabling, it also creates the default trigger set
// (all disabled) so the user has something to enable via the submenu. Ensures the user exists
// by external id (creates the record if it does not exist yet).
export async function setUserProactivity(externalId, enabled) {
  const user = await ensureUser(externalId);
  await query('UPDATE mem.users SET proactivity_enabled = $2, updated_at = now() WHERE id = $1', [user.id, enabled]);
  if (enabled) {
    const generalDomainId = await getDomainId('general');
    await ensureDefaultTriggers(user.id, generalDomainId, defaultProactiveTriggers(), { enabled: false });
  }
  return { ...user, proactivity_enabled: enabled };
}

// Save the user's reply-form preference by id (internal userId): 'text' or 'voice'.
// This is a core control setting; channels without voice support silently ignore the 'voice' value. Returns
// the saved mode. An invalid value is coerced to 'text' so the database always holds a valid state.
export async function setReplyMode(userId, mode) {
  const replyMode = mode === 'voice' ? 'voice' : 'text';
  await query('UPDATE mem.users SET reply_mode = $2, updated_at = now() WHERE id = $1', [userId, replyMode]);
  return replyMode;
}

// Lightweight read of the reply-form preference by external id (e.g. a Telegram ID), without an upsert.
// The channel needs it to decide the delivery method (streaming draft or voice) even BEFORE calling the core:
// the core learns the mode only inside handleMessage via ensureUser, while the streaming decision is made earlier.
// For a new user (no record yet) and any invalid value it returns 'text' — the safe default mode.
export async function getUserReplyMode(externalId) {
  const { rows } = await query('SELECT reply_mode FROM mem.users WHERE external_id = $1', [externalId]);
  return rows[0]?.reply_mode === 'voice' ? 'voice' : 'text';
}

// Save the user's voice timbre for spoken responses. NULL clears the user setting and returns
// the global fallback from the configuration. Invalid values are not written.
export async function setVoicePreference(userId, voice) {
  const normalized = voice == null ? null : normalizeVoiceId(voice);
  if (voice != null && !normalized) {
    throw new Error(`Invalid TTS voice: ${voice}`);
  }
  await query('UPDATE mem.users SET voice_output_voice = $2, updated_at = now() WHERE id = $1', [userId, normalized]);
  return normalized;
}

export function effectiveVoicePreference(user) {
  return normalizeVoiceId(user?.voice_output_voice) || config.voiceOutput.voice;
}

// Lightweight read of the effective timbre by external id without creating a user. Needed by channels
// that have to make a decision before entering the main agent circuit.
export async function getUserVoicePreference(externalId) {
  const { rows } = await query('SELECT voice_output_voice FROM mem.users WHERE external_id = $1', [externalId]);
  return normalizeVoiceId(rows[0]?.voice_output_voice) || config.voiceOutput.voice;
}

// The user's current proactivity state: the master flag and the list of their triggers with the enabled flag.
// Returns null if no user with that external id exists yet. Needed to render the submenu.
export async function getProactivityState(externalId) {
  const { rows } = await query(
    `SELECT u.proactivity_enabled, pt.trigger_type, pt.enabled AS trigger_enabled
       FROM mem.users u
       LEFT JOIN mem.proactive_triggers pt ON pt.user_id = u.id
      WHERE u.external_id = $1
      ORDER BY pt.trigger_type`,
    [externalId],
  );
  if (!rows.length) {
    return null;
  }
  const enabled = rows[0].proactivity_enabled === true;
  const triggers = rows
    .filter((r) => r.trigger_type)
    .map((r) => ({ trigger_type: r.trigger_type, enabled: r.trigger_enabled === true }));
  return { enabled, triggers };
}

// Toggle a single proactivity trigger of a specific user. Returns true if the row was found
// and updated (the trigger exists), otherwise false.
export async function setTrigger(externalId, triggerType, enabled) {
  const { rowCount } = await query(
    `UPDATE mem.proactive_triggers pt
        SET enabled = $3, updated_at = now()
       FROM mem.users u
      WHERE pt.user_id = u.id AND u.external_id = $1 AND pt.trigger_type = $2`,
    [externalId, triggerType, enabled],
  );
  return rowCount > 0;
}
