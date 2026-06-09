// Слой доступа к данным: пользователи, домены, диалоги, сообщения.
import { query } from './db.js';
import { config } from './config.js';
import { estimateTokens } from './pipeline/token-counter.js';
import { normalizeVoiceId } from './voice/voices.js';

// Найти или создать пользователя по внешнему идентификатору (например, Telegram ID).
// Флаг is_test помечает технических пользователей автотестов так же, как log.llm_request.is_test
// помечает журнальные записи тестового прогона: по умолчанию он берётся из NODE_ENV === 'test',
// поэтому каждый пользователь, созданный во время прогона тестов (в том числе неявно через
// handleMessage), помечается тестовым без правок в каждом тесте. На существующего пользователя
// флаг не переустанавливается: ветка ON CONFLICT обновляет только updated_at.
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

const domainCache = new Map();

// Получить идентификатор домена по его ключу (с кэшированием).
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

// Найти или создать активный диалог пользователя в указанном домене.
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

// Сохранить одно сообщение диалога. Дополнительно проставляет token_count (оценка размера сообщения),
// который нужен для подсчёта размера холодной зоны при поджатии истории. Поля tool_name и tool_call_id
// (журнал вызовов инструментов) и обновление updated_at диалога сохраняются без изменений.
export async function saveMessage(conversationId, userId, role, content, extra = {}) {
  const tokenCount = estimateTokens(content);
  const { rows } = await query(
    `INSERT INTO mem.conversation_messages
       (conversation_id, user_id, role, content, tool_name, tool_call_id, token_count, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
    ],
  );
  await query('UPDATE mem.conversations SET updated_at = now() WHERE id = $1', [conversationId]);
  return rows[0];
}

// Связать внутреннее сообщение истории с идентификатором сообщения во внешнем канале доставки.
// Это позволяет обработчику реакций найти, на какое сообщение ассистента отреагировал пользователь.
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

// Найти внутреннее сообщение по внешнему идентификатору канала.
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

// Получить активную сводку холодной зоны диалога (последнюю помеченную is_active).
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

// Деактивировать все активные сводки диалога (перед вставкой новой активной).
export async function markOldSummariesInactive(conversationId) {
  await query(
    `UPDATE mem.conversation_summaries
     SET is_active = false
     WHERE conversation_id = $1 AND is_active = true`,
    [conversationId],
  );
}

// Сообщения холодной зоны, ещё не покрытые активной сводкой: старше границы горячего окна
// (beforeCreatedAt) и новее последнего покрытого сообщения (afterMessageId). По возрастанию времени.
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

// Сохранить новую активную сводку холодной зоны. Предыдущие активные сводки деактивируются.
// Размеры в токенах (source_token_count, summary_token_count) приходят посчитанными нашим кодом.
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

// Получить последние сообщения диалога в хронологическом порядке.
export async function getRecentMessages(conversationId, limit = 10) {
  const { rows } = await query(
    `SELECT role, content, tool_name, created_at
     FROM mem.conversation_messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversationId, limit],
  );
  return rows.reverse();
}

// Записать вызов инструмента в журнал (для отладки и аудита).
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

// Время последнего сообщения пользователя (для темпорального контекста и триггера возврата).
export async function getLastUserMessageTime(userId) {
  const { rows } = await query(
    `SELECT max(cm.created_at) AS last_at
       FROM mem.conversation_messages cm
      WHERE cm.user_id = $1 AND cm.role = 'user'`,
    [userId],
  );
  return rows[0]?.last_at ? new Date(rows[0].last_at) : null;
}

// Все пользователи, у которых проактивность включена мастер-флагом И есть хотя бы один включённый триггер.
// Мастер-флаг пользователя (proactivity_enabled) стоит над потриггерным enabled: если контур у пользователя
// выключен целиком, ни один из его триггеров в проход проактивности не попадает.
export async function listUsersWithTriggers() {
  const { rows } = await query(
    `SELECT DISTINCT u.id, u.external_id, u.timezone
       FROM mem.users u
       JOIN mem.proactive_triggers pt ON pt.user_id = u.id AND pt.enabled = true
      WHERE u.proactivity_enabled = true`,
  );
  return rows;
}

// Набор триггеров проактивности по умолчанию с порогами срабатывания из конфигурации.
// Используется как сидом песочницы, так и моментом включения проактивности пользователем.
export function defaultProactiveTriggers() {
  return [
    { trigger_type: 'inactivity', config: { minutes_inactive: config.proactive.inactivityMinutes } },
    { trigger_type: 'daily_checkin', config: { hour: config.proactive.checkinHour } },
    { trigger_type: 'goal_reminder', config: { interval_minutes: config.proactive.goalIntervalMinutes } },
    { trigger_type: 'welcome_back', config: { gap_minutes: config.proactive.welcomeBackGapMinutes } },
  ];
}

// Идемпотентное создание набора триггеров по умолчанию для пользователя. По умолчанию триггеры создаются
// выключенными (enabled = false): включение конкретных поводов — отдельное явное действие пользователя.
// Сид песочницы передаёт { enabled: true }, чтобы демо-пользователи сразу были наглядными.
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

// Переключить мастер-флаг проактивности пользователя. При включении заодно создаёт набор триггеров
// по умолчанию (все выключены), чтобы пользователю было что включать через подменю. Гарантирует
// существование пользователя по внешнему идентификатору (создаёт запись, если её ещё нет).
export async function setUserProactivity(externalId, enabled) {
  const user = await ensureUser(externalId);
  await query('UPDATE mem.users SET proactivity_enabled = $2, updated_at = now() WHERE id = $1', [user.id, enabled]);
  if (enabled) {
    const generalDomainId = await getDomainId('general');
    await ensureDefaultTriggers(user.id, generalDomainId, defaultProactiveTriggers(), { enabled: false });
  }
  return { ...user, proactivity_enabled: enabled };
}

// Сохранить предпочтение формы ответа пользователя по идентификатору (внутреннему userId): 'text' или 'voice'.
// Это управляющая настройка ядра; каналы без поддержки голоса значение 'voice' молча игнорируют. Возвращает
// сохранённый режим. Недопустимое значение приводится к 'text', чтобы в базе всегда было корректное состояние.
export async function setReplyMode(userId, mode) {
  const replyMode = mode === 'voice' ? 'voice' : 'text';
  await query('UPDATE mem.users SET reply_mode = $2, updated_at = now() WHERE id = $1', [userId, replyMode]);
  return replyMode;
}

// Лёгкое чтение предпочтения формы ответа по внешнему идентификатору (например, Telegram ID), без upsert.
// Нужно каналу, чтобы решить способ доставки (потоковый черновик или голос) ещё ДО вызова ядра: ядро узнаёт
// режим только внутри handleMessage через ensureUser, а решение о стриминге принимается раньше. Для нового
// пользователя (записи ещё нет) и при любом некорректном значении возвращает 'text' — безопасный режим по умолчанию.
export async function getUserReplyMode(externalId) {
  const { rows } = await query('SELECT reply_mode FROM mem.users WHERE external_id = $1', [externalId]);
  return rows[0]?.reply_mode === 'voice' ? 'voice' : 'text';
}

// Сохранить пользовательский тембр голосового ответа. NULL очищает пользовательскую настройку и возвращает
// глобальный fallback из конфигурации. Недопустимые значения не записываются.
export async function setVoicePreference(userId, voice) {
  const normalized = voice == null ? null : normalizeVoiceId(voice);
  if (voice != null && !normalized) {
    throw new Error(`Недопустимый голос TTS: ${voice}`);
  }
  await query('UPDATE mem.users SET voice_output_voice = $2, updated_at = now() WHERE id = $1', [userId, normalized]);
  return normalized;
}

export function effectiveVoicePreference(user) {
  return normalizeVoiceId(user?.voice_output_voice) || config.voiceOutput.voice;
}

// Лёгкое чтение эффективного тембра по внешнему идентификатору без создания пользователя. Нужно каналам,
// которым требуется принять решение до входа в основной агентский контур.
export async function getUserVoicePreference(externalId) {
  const { rows } = await query('SELECT voice_output_voice FROM mem.users WHERE external_id = $1', [externalId]);
  return normalizeVoiceId(rows[0]?.voice_output_voice) || config.voiceOutput.voice;
}

// Текущее состояние проактивности пользователя: мастер-флаг и список его триггеров с признаком enabled.
// Возвращает null, если пользователя с таким внешним идентификатором ещё нет. Нужно для отрисовки подменю.
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

// Переключить один триггер проактивности конкретного пользователя. Возвращает true, если строка нашлась
// и обновлена (триггер существует), иначе false.
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
