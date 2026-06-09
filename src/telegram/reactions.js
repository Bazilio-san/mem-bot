// Раскладка эмодзи Telegram для системы реакций. Здесь и только здесь живёт соответствие между конкретными
// эмодзи Telegram и абстрактными ключами реакций ядра (like, okay, heart, …). Ядро (src/pipeline/reactions.js)
// оперирует только абстрактными ключами и про эмодзи Telegram ничего не знает: вход с эмодзи приводится к ключу
// здесь, а исходящий ключ разворачивается обратно в эмодзи для отправки.
import { REACTION_KEYS } from '../pipeline/reactions.js';

// Вход: эмодзи реакции Telegram приводится к абстрактному ключу реакции. Несколько похожих эмодзи могут
// соответствовать одному ключу (например, 😁/🤣/😄 — это laugh).
const emojiToKey = new Map([
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

// Выход: абстрактный ключ реакции разворачивается в эмодзи Telegram для метода setMessageReaction.
const keyToEmoji = {
  like: '👍',
  okay: '👌',
  heart: '❤',
  laugh: '😁',
  fire: '🔥',
  smile: '😊',
  100: '💯',
  sad: '😢',
};

// Ключи реакций, которые Telegram-канал умеет ставить исходящими (для профиля возможностей доставки).
export const TELEGRAM_REACTION_KEYS = REACTION_KEYS.filter((key) => key in keyToEmoji);

// Привести входящую реакцию Telegram (объект из обновления message_reaction) к абстрактному ключу.
// Возвращает null, если это не эмодзи-реакция или эмодзи не отображается ни на один известный ключ.
export function normalizeTelegramReaction(reaction) {
  if (!reaction || reaction.type !== 'emoji') {
    return null;
  }
  return emojiToKey.get(reaction.emoji) || null;
}

// Развернуть абстрактный ключ реакции в эмодзи Telegram. Возвращает null для неизвестного ключа.
export function reactionKeyToEmoji(key) {
  return REACTION_KEYS.includes(key) ? keyToEmoji[key] || null : null;
}
