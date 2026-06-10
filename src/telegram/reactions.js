// Telegram emoji layout for the reaction system. Here and only here lives the mapping between concrete Telegram
// emoji and the core's abstract reaction keys (like, okay, heart, …). The core (src/pipeline/reactions.js)
// operates only on abstract keys and knows nothing about Telegram emoji: an incoming emoji is reduced to a key
// here, and an outgoing key is expanded back into an emoji for sending.
import { REACTION_KEYS } from '../pipeline/reactions.js';

// Input: a Telegram reaction emoji is reduced to an abstract reaction key. Several similar emoji may map to one
// key (for example, 😁/🤣/😄 are all laugh).
const emojiToKey = new Map([
  ['❤', 'heart'],
  ['👍', 'like'],
  ['👎', 'dislike'],
  ['🔥', 'fire'],
  ['🥰', 'love'],
  ['👏', 'clap'],
  ['😁', 'laugh'],
  ['🤔', 'think'],
  ['🤯', 'mindblown'],
  ['😱', 'shock'],
  ['🤬', 'angry'],
  ['😢', 'sad'],
  ['🎉', 'party'],
  ['🤩', 'starstruck'],
  ['🤮', 'disgust'],
  ['💩', 'poop'],
  ['🙏', 'thanks'],
  ['👌', 'okay'],
  ['🕊', 'peace'],
  ['🤡', 'clown'],
  ['🥱', 'bored'],
  ['🥴', 'dizzy'],
  ['😍', 'heart_eyes'],
  ['🐳', 'whale'],
  ['❤‍🔥', 'heart_on_fire'],
  ['🌚', 'moon'],
  ['🌭', 'hotdog'],
  ['💯', '100'],
  ['🤣', 'rofl'],
  ['⚡', 'lightning'],
  ['🍌', 'banana'],
  ['🏆', 'trophy'],
  ['💔', 'broken_heart'],
  ['🤨', 'skeptical'],
  ['😐', 'neutral'],
  ['🍓', 'strawberry'],
  ['🍾', 'champagne'],
  ['💋', 'kiss'],
  ['🖕', 'middle_finger'],
  ['😈', 'devil'],
  ['😴', 'sleep'],
  ['😭', 'cry'],
  ['🤓', 'nerd'],
  ['👻', 'ghost'],
  ['👨‍💻', 'developer'],
  ['👀', 'eyes'],
  ['🎃', 'pumpkin'],
  ['🙈', 'see_no_evil'],
  ['😇', 'angel'],
  ['😨', 'fear'],
  ['🤝', 'handshake'],
  ['✍', 'writing'],
  ['🤗', 'hug'],
  ['🫡', 'salute'],
  ['🎅', 'santa'],
  ['🎄', 'christmas_tree'],
  ['☃', 'snowman'],
  ['💅', 'nails'],
  ['🤪', 'crazy'],
  ['🗿', 'moai'],
  ['🆒', 'cool'],
  ['💘', 'cupid'],
  ['🙉', 'hear_no_evil'],
  ['🦄', 'unicorn'],
  ['😘', 'kiss_face'],
  ['💊', 'pill'],
  ['🙊', 'speak_no_evil'],
  ['😎', 'cool'],
  ['👾', 'alien'],
  ['🤷‍♂', 'shrug'],
  ['🤷', 'shrug'],
  ['🤷‍♀', 'shrug'],
  ['😡', 'rage'],
   // ------------
  ['😊', 'smile'],
  ['💯', '100%'],
  ['😄', 'laugh'],
]);
// Output: an abstract reaction key is expanded into a Telegram emoji for the setMessageReaction method.
const keyToEmoji = {
  like: '👍',
  dislike: '👎',
  okay: '👌',
  heart: '❤',
  laugh: '😁',
  fire: '🔥',
  smile: '😊',
  100: '💯',
  sad: '😢',
};

// Reaction keys the Telegram channel can set as outgoing (for the delivery capability profile).
export const TELEGRAM_REACTION_KEYS = REACTION_KEYS.filter((key) => key in keyToEmoji);

// Reduce an incoming Telegram reaction (the object from a message_reaction update) to an abstract key.
// Returns null if it is not an emoji reaction or the emoji does not map to any known key.
export function normalizeTelegramReaction(reaction) {
  if (!reaction || reaction.type !== 'emoji') {
    return null;
  }
  return emojiToKey.get(reaction.emoji) || null;
}

// Expand an abstract reaction key into a Telegram emoji. Returns null for an unknown key.
export function reactionKeyToEmoji(key) {
  return REACTION_KEYS.includes(key) ? keyToEmoji[key] || null : null;
}
