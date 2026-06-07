import assert from 'node:assert/strict';
import {
  decideDeliveryIntent,
  formatReactionToken,
  normalizeReactionKey,
  normalizeTelegramReaction,
  shouldConsiderReaction,
} from '../src/pipeline/reactions.js';

assert.equal(normalizeReactionKey(':okay:'), 'okay');
assert.equal(normalizeReactionKey('100'), '100');
assert.equal(normalizeReactionKey('unknown'), null);
assert.equal(formatReactionToken('heart'), ':heart:');
assert.equal(formatReactionToken('missing'), ':unknown:');

assert.equal(normalizeTelegramReaction({ type: 'emoji', emoji: '❤' }), 'heart');
assert.equal(normalizeTelegramReaction({ type: 'emoji', emoji: '🔥' }), 'fire');
assert.equal(normalizeTelegramReaction({ type: 'custom_emoji', custom_emoji_id: '1' }), null);

assert.equal(shouldConsiderReaction('ок, сделай'), true);
assert.equal(shouldConsiderReaction('/start'), false);
assert.equal(shouldConsiderReaction('когда вылет?'), false);
assert.equal(shouldConsiderReaction('я люблю торты'), false);
assert.equal(shouldConsiderReaction('объясни, почему это работает'), false);

const delivery = await decideDeliveryIntent({
  userMessage: 'ок, сделай',
  deliveryCapabilities: { supportsReactions: true },
  classify: async () => ({
    kind: 'reaction',
    reaction_key: 'okay',
    fallback_text: 'Окей.',
    reason: 'simple agreement',
  }),
});
assert.deepEqual(delivery, {
  kind: 'reaction',
  reactionKey: 'okay',
  fallbackText: 'Окей.',
  reason: 'simple agreement',
});

const noReaction = await decideDeliveryIntent({
  userMessage: 'ок',
  deliveryCapabilities: { supportsReactions: false },
  classify: async () => {
    throw new Error('classifier must not be called');
  },
});
assert.equal(noReaction.kind, 'text_needed');

console.log('reactions.test.mjs: ok');
