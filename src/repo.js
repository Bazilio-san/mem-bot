// Слой доступа к данным: пользователи, домены, диалоги, сообщения.
import { query } from './db.js';
import { estimateTokens } from './pipeline/token-counter.js';

// Найти или создать пользователя по внешнему идентификатору (например, Telegram ID).
export async function ensureUser(externalId, { displayName = null, locale = 'ru', timezone = 'Europe/Moscow' } = {}) {
  const { rows } = await query(
    `INSERT INTO mem.users (external_id, display_name, locale, timezone)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (external_id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [externalId, displayName, locale, timezone],
  );
  return rows[0];
}

const domainCache = new Map();

// Получить идентификатор домена по его ключу (с кэшированием).
export async function getDomainId(domainKey) {
  if (domainCache.has(domainKey)) return domainCache.get(domainKey);
  const { rows } = await query('SELECT id FROM mem.agent_domains WHERE domain_key = $1', [domainKey]);
  const id = rows[0]?.id ?? null;
  if (id) domainCache.set(domainKey, id);
  return id;
}

// Найти или создать активный диалог пользователя в указанном домене.
export async function ensureConversation(userId, domainKey = 'general') {
  const domainId = await getDomainId(domainKey);
  const existing = await query(
    `SELECT * FROM mem.conversations WHERE user_id = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT 1`,
    [userId],
  );
  if (existing.rows[0]) return existing.rows[0];
  const { rows } = await query(
    `INSERT INTO mem.conversations (user_id, domain_id) VALUES ($1, $2) RETURNING *`,
    [userId, domainId],
  );
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
    [conversationId, userId, role, content,
      extra.toolName ?? null, extra.toolCallId ?? null, tokenCount, extra.metadata ?? {}],
  );
  await query('UPDATE mem.conversations SET updated_at = now() WHERE id = $1', [conversationId]);
  return rows[0];
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
  conversationId, userId, summaryText, stateJson = {}, importance = 0.5,
  layer = 'full', coveredFromMessageId = null, coveredToMessageId = null, coveredUntil = null,
  sourceMessageCount = 0, sourceTokenCount = 0, summaryTokenCount = 0, memoryDedupe = {},
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
    [conversationId, userId, summaryText, stateJson, importance,
      layer, coveredFromMessageId, coveredToMessageId, coveredUntil,
      sourceMessageCount, sourceTokenCount, summaryTokenCount, memoryDedupe],
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
export async function logToolCall({ conversationId, userId, toolName, toolCallId, input, output, status, latencyMs, error }) {
  await query(
    `INSERT INTO mem.tool_calls (conversation_id, user_id, tool_name, tool_call_id, input_json, output_json, status, latency_ms, error_text, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`,
    [conversationId, userId, toolName, toolCallId ?? null, input ?? {}, output ?? null, status, latencyMs ?? null, error ?? null],
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

// Все пользователи, у которых есть хотя бы один включённый триггер (для прохода проактивности).
export async function listUsersWithTriggers() {
  const { rows } = await query(
    `SELECT DISTINCT u.id, u.external_id, u.timezone
       FROM mem.users u
       JOIN mem.proactive_triggers pt ON pt.user_id = u.id AND pt.enabled = true`,
  );
  return rows;
}

// Идемпотентное создание набора триггеров по умолчанию для пользователя.
export async function ensureDefaultTriggers(userId, domainId, defaults) {
  for (const t of defaults) {
    await query(
      `INSERT INTO mem.proactive_triggers (user_id, domain_id, trigger_type, config)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (user_id, trigger_type) DO NOTHING`,
      [userId, domainId, t.trigger_type, JSON.stringify(t.config || {})],
    );
  }
}
