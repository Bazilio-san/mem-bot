// Слой доступа к данным: пользователи, домены, диалоги, сообщения.
import { query } from './db.js';

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

// Сохранить одно сообщение диалога.
export async function saveMessage(conversationId, userId, role, content, extra = {}) {
  const { rows } = await query(
    `INSERT INTO mem.conversation_messages (conversation_id, user_id, role, content, tool_name, tool_call_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [conversationId, userId, role, content, extra.toolName ?? null, extra.toolCallId ?? null, extra.metadata ?? {}],
  );
  await query('UPDATE mem.conversations SET updated_at = now() WHERE id = $1', [conversationId]);
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
