export const REACTION_KEYS = ['like', 'okay', 'heart', 'laugh', 'fire', 'smile', '100', 'sad'];

export const REACTION_FALLBACK_TEXT = {
  like: 'Понял.',
  okay: 'Окей.',
  heart: '❤️',
  laugh: 'Ха-ха.',
  fire: 'Огонь.',
  smile: '🙂',
  100: 'На все сто.',
  sad: 'Сочувствую.',
};

const TELEGRAM_EMOJI_TO_KEY = new Map([
  ['👍', 'like'],
  ['👌', 'okay'],
  ['❤', 'heart'],
  ['❤️', 'heart'],
  ['🥰', 'heart'],
  ['😁', 'laugh'],
  ['🤣', 'laugh'],
  ['😄', 'laugh'],
  ['🔥', 'fire'],
  ['🙂', 'smile'],
  ['😊', 'smile'],
  ['💯', '100'],
  ['😢', 'sad'],
  ['😭', 'sad'],
]);

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'reaction_key', 'fallback_text', 'reason'],
  properties: {
    kind: { type: 'string', enum: ['reaction', 'text_needed'] },
    reaction_key: { type: ['string', 'null'], enum: [...REACTION_KEYS, null] },
    fallback_text: { type: 'string' },
    reason: { type: 'string' },
  },
};

const SYSTEM = `Ты выбираешь способ доставки короткого ответа чат-бота.
Нужно решить, уместно ли ответить реакцией вместо полноценного текста.
Реакция допустима только точечно: когда ответ не требует фактов, инструментов, уточнений или содержательного текста.
Доступные ключи реакций: like, okay, heart, laugh, fire, smile, 100, sad.

Выбирай reaction только для очевидных случаев:
- okay: пользователь просит простое действие или явно ждёт согласия;
- heart/smile: пользователь сказал что-то тёплое, приятное или благодарное;
- laugh: короткая шутка или смешная реплика;
- fire/100: сильный результат, достижение, «сделал!»;
- sad: короткое грустное сообщение, где достаточно сочувствия;
- like: нейтральное принятие или одобрение.

Выбирай text_needed, если есть вопрос, задача с деталями, запрос инструмента, важный факт для памяти,
риск неверного тона или пользователь явно ждёт содержательный ответ.`;

export function normalizeReactionKey(key) {
  const normalized = String(key || '').replace(/^:/, '').replace(/:$/, '').trim();
  return REACTION_KEYS.includes(normalized) ? normalized : null;
}

export function makeReactionDelivery(reactionKey, reason = '') {
  const key = normalizeReactionKey(reactionKey);
  if (!key) return { kind: 'text', text: '', reason: reason || 'unknown reaction' };
  return {
    kind: 'reaction',
    reactionKey: key,
    fallbackText: REACTION_FALLBACK_TEXT[key],
    reason,
  };
}

export function normalizeTelegramReaction(reaction) {
  if (!reaction || reaction.type !== 'emoji') return null;
  return TELEGRAM_EMOJI_TO_KEY.get(reaction.emoji) || null;
}

export function formatReactionToken(reactionKey) {
  const key = normalizeReactionKey(reactionKey);
  return key ? `:${key}:` : ':unknown:';
}

export function shouldConsiderReaction(userMessage) {
  const text = String(userMessage || '').trim();
  if (!text || text.length > 120) return false;
  if (text.startsWith('/')) return false;
  if (text.includes('\n')) return false;
  if (/[?？]/.test(text)) return false;
  if (/(напомни|найди|объясни|расскажи|почему|когда|сколько|сделай список)/i.test(text)) return false;
  if (/(я люблю|я не люблю|мне нравится|предпочитаю|запомни)/i.test(text)) return false;
  return true;
}

export async function decideDeliveryIntent({
  userMessage,
  deliveryCapabilities = {},
  classify = null,
} = {}) {
  if (!deliveryCapabilities.supportsReactions) return { kind: 'text_needed', reason: 'channel has no reactions' };
  if (!shouldConsiderReaction(userMessage)) return { kind: 'text_needed', reason: 'message needs text path' };

  let classifier = classify;
  let model;
  if (!classifier) {
    const [{ chatJSON }, { config }] = await Promise.all([import('../llm.js'), import('../config.js')]);
    classifier = chatJSON;
    model = config.llm.auxModel;
  }

  const result = await classifier({
    model,
    schema: SCHEMA,
    schemaName: 'delivery_intent',
    system: SYSTEM,
    user: `Сообщение пользователя:\n${String(userMessage || '').trim()}`,
  });

  if (result?.kind !== 'reaction') {
    return { kind: 'text_needed', reason: result?.reason || 'model chose text' };
  }
  const delivery = makeReactionDelivery(result.reaction_key, result.reason || '');
  if (delivery.kind !== 'reaction') return { kind: 'text_needed', reason: 'invalid reaction key' };
  return delivery;
}
