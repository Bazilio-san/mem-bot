-- Внешние идентификаторы сообщений: связь внутренней истории с сообщениями в каналах доставки.
-- Используется обработчиками реакций и другими каналами, где событие ссылается на ранее доставленное сообщение.
-- Идемпотентно: таблица и индекс создаются только если их ещё нет.

CREATE TABLE IF NOT EXISTS mem.message_external_refs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_message_id uuid NOT NULL REFERENCES mem.conversation_messages(id) ON DELETE CASCADE,
    channel text NOT NULL,
    chat_external_id text NOT NULL,
    message_external_id text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (channel, chat_external_id, message_external_id)
);

CREATE INDEX IF NOT EXISTS idx_message_external_refs_message
ON mem.message_external_refs (conversation_message_id);
