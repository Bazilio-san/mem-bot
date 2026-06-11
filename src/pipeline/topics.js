// Topic tracking (criterion 13). Categorization of the user's topics, updating with exponential
// smoothing of engagement, and formatting for the prompt reference block. Closes the anti-pattern
// "the bot got stuck on one topic": recent topics are not repeated, burned-out ones are avoided, lively ones develop.
import { query } from '../db.js';
import { chatJSON } from '../llm.js';
import { config } from '../config.js';

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

// Извлечение тем диалога для топик-трекинга (критерий 13). Возвращает массив тем с оценкой
// вовлечённости пользователя. Используется только в режиме компаньона (COMPANION_MODE).
const TOPICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['topics'],
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['topic_key', 'user_engagement'],
        properties: {
          topic_key: { type: 'string' }, // короткий стабильный ключ: fitness, work_stress, travel
          user_engagement: { type: 'number' }, // 0..1 — насколько живо пользователь отвечал по теме
        },
      },
    },
  },
};

const TOPICS_SYSTEM = `Ты — модуль анализа тем в диалоге.

Твоя задача — определить, какие ТЕМЫ затрагивались в диалоге,
и оценить вовлечённость пользователя в каждую тему.

Правила извлечения тем:
- Тема — это конкретная область разговора (fitness, work_stress, sleep, family, hobbies)
- Используй короткие snake_case ключи на английском
- Не создавай слишком общих тем (life, things, stuff)
- Не создавай слишком узких тем (каждое предложение не является новой темой)
- Объединяй близкие темы в одну

Оценка вовлечённости (user_engagement от 0 до 1):
- 0.1-0.3: пользователь отвечал коротко, односложно, без интереса
- 0.4-0.6: нейтральные ответы, средняя вовлечённость
- 0.7-0.9: пользователь развивал тему, задавал вопросы, делился деталями
- 1.0: максимальная вовлечённость, явный энтузиазм

Если тем нет или диалог слишком короткий — верни {"topics": []}.`;

export async function extractTopics({ recentMessages }) {
  try {
    const res = await chatJSON({
      model: config.llm.auxModel,
      kind: 'topic_extract',
      schema: TOPICS_SCHEMA,
      schemaName: 'dialog_topics',
      system: TOPICS_SYSTEM,
      user: recentMessages,
    });
    return Array.isArray(res?.topics) ? res.topics : [];
  } catch {
    return [];
  }
}
