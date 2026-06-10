// Topic tracking (criterion 13). Categorization of the user's topics, updating with exponential
// smoothing of engagement, and formatting for the prompt reference block. Closes the anti-pattern
// "the bot got stuck on one topic": recent topics are not repeated, burned-out ones are avoided, lively ones develop.
import { query } from '../db.js';

const RECENT_DAYS = 3,
  FRESH_DAYS = 14;
const BURNED_MENTIONS = 5,
  BURNED_ENGAGEMENT = 0.4,
  HIGH_ENERGY = 0.7;

// Categorization of the user's topics within a domain.
export async function getTopicContext(userId, domainId) {
  const { rows } = await query(
    `SELECT topic_key, mention_count, user_engagement_score, last_mentioned_at, first_mentioned_at
       FROM mem.topic_mentions
      WHERE user_id = $1 AND domain_id IS NOT DISTINCT FROM $2
      ORDER BY last_mentioned_at DESC`,
    [userId, domainId],
  );
  const now = Date.now();
  const recentT = now - RECENT_DAYS * 86400000,
    freshT = now - FRESH_DAYS * 86400000;
  const recent = [],
    fresh = [],
    highEnergy = [],
    burned = [];
  for (const r of rows) {
    const last = new Date(r.last_mentioned_at).getTime();
    const eng = Number(r.user_engagement_score);
    if (last > recentT) {
      recent.push(r.topic_key);
    }
    if (last < freshT && eng > 0.5) {
      fresh.push(r.topic_key);
    }
    if (eng >= HIGH_ENERGY) {
      highEnergy.push(r.topic_key);
    }
    if (r.mention_count >= BURNED_MENTIONS && eng < BURNED_ENGAGEMENT) {
      burned.push(r.topic_key);
    }
  }
  return {
    recentTopics: recent.slice(0, 10),
    freshTopics: fresh.slice(0, 5),
    highEnergyTopics: highEnergy.slice(0, 5),
    burnedTopics: burned.slice(0, 5),
  };
}

// Updating topic statistics. The engagement score is smoothed: 70% of the previous + 30% of the new.
export async function upsertTopicMentions(userId, domainId, topics) {
  for (const t of topics) {
    if (!t.topic_key) {
      continue;
    }
    await query(
      `INSERT INTO mem.topic_mentions (user_id, domain_id, topic_key, mention_count, user_engagement_score)
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (user_id, domain_id, topic_key) DO UPDATE SET
         mention_count = mem.topic_mentions.mention_count + 1,
         user_engagement_score =
           mem.topic_mentions.user_engagement_score * 0.7 + EXCLUDED.user_engagement_score * 0.3,
         last_mentioned_at = now(), updated_at = now()`,
      [userId, domainId, t.topic_key, Math.max(0, Math.min(1, Number(t.user_engagement ?? 0.5)))],
    );
  }
}

// Formatting topics for the prompt reference block.
export function formatTopicContext(ctx) {
  const s = [];
  if (ctx.recentTopics.length) {
    s.push(`Недавно обсуждали (не повторяй без повода): ${ctx.recentTopics.join(', ')}`);
  }
  if (ctx.burnedTopics.length) {
    s.push(`Выгоревшие темы (интерес угас, обходи): ${ctx.burnedTopics.join(', ')}`);
  }
  if (ctx.freshTopics.length) {
    s.push(`Темы для возврата (давно не обсуждали, но заходили): ${ctx.freshTopics.join(', ')}`);
  }
  if (ctx.highEnergyTopics.length) {
    s.push(`Высокововлечённые темы (развивай): ${ctx.highEnergyTopics.join(', ')}`);
  }
  return s.length ? s.join('\n') : 'Нет данных о темах.';
}
