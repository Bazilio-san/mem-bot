// Long-term facts about the user: extraction from the dialog, assistant answer summary,
// saving with semantic deduplication, and a background duplicate sweep.
//
// Principles (see docs/ai-bot-with-memory/06-memory.md):
// - The source of facts is ONLY the user's messages. The assistant's answer is fed into the extraction
//   context as a short HTML-free summary inside the <assistant> tag and is explicitly excluded from
//   extraction, otherwise the model treats facts the bot listed back as new information and memory
//   snowballs.
// - Flat storage: mem.user_facts (user × domain × type × text + embedding).
//   No entity schemas and no second refinement pass — a single LLM call per turn.
// - Write-time deduplication: a semantically close fact of the same type confirms the existing row
//   (evidence_count+1, freshness) or replaces it (a new value of the same topic) instead of spawning
//   duplicates.
import { query, vectorToSql } from '../db.js';
import { chatJSON, embed } from '../llm.js';
import { config } from '../config.js';
import { getFactExtractionPrompt, getSkill, getSkillByDomain } from './skills/registry.js';
import { logAgentEvent, AGENT_EVENTS } from './agent-event-log.js';

export const FACT_TYPES = [
  'profile',
  'preference',
  'habit',
  'goal',
  'emotional_pattern',
  'activity_rhythm',
  'communication_style',
  'open_loop',
  'topic_energy',
  'discovery_seed',
];

// Types describing the person outside any subject area: stored in the general domain and available from
// any domain. The rest (goal, open_loop) are bound to the domain of the current conversation.
const GENERAL_TYPES = new Set([
  'profile',
  'preference',
  'habit',
  'emotional_pattern',
  'activity_rhythm',
  'communication_style',
  'topic_energy',
  'discovery_seed',
]);

// Fact source ranks for resolving conflicts at write time: replacing an existing row is allowed only
// when the new source rank is not below the old one. Pinned (persistent) rows can be replaced only by
// a source of rank user_statement or higher — the person has explicitly changed their mind.
export const SOURCE_RANK = {
  manual: 3,
  user_statement: 2,
  user_reaction: 1,
  history_summary: 0,
};

export const FACT_SOURCES = Object.keys(SOURCE_RANK);

function normalizeSource(source) {
  return FACT_SOURCES.includes(source) ? source : 'user_statement';
}

// Rough cleanup of HTML markup: bot replies in the Telegram channel contain <b>/<i> and the like.
// Used for the summary fallback and for the reaction target text.
export function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Assistant answer summary
// ---------------------------------------------------------------------------

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: { summary: { type: 'string' } },
};

const SUMMARY_SYSTEM = `Ты сжимаешь ответ ассистента в краткое содержание для служебного журнала.
Верни 1–2 коротких предложения на русском: о чём был ответ и какой вопрос ассистент задал пользователю
(если задал). Без HTML и markdown, без списков, без цитирования перечней — перечни описывай обобщённо
(например: «показал список сохранённых заметок»). Не упоминай конкретные факты о пользователе.`;

// Short summary of the assistant's answer. Stored in the message metadata and replaces the full answer
// text in the fact extraction context. On any LLM error a truncated plain-text is returned — the pipeline
// does not depend on model availability.
export async function summarizeAnswer(answer, { model = config.llm.auxModel } = {}) {
  const plain = stripHtml(answer);
  const maxChars = config.facts.summaryMaxChars;
  if (!plain) {
    return '';
  }
  if (plain.length <= 120) {
    return plain; // a short answer is its own summary — don't spend a model call
  }
  try {
    const res = await chatJSON({
      model,
      kind: 'answer_summary',
      schema: SUMMARY_SCHEMA,
      schemaName: 'answer_summary',
      system: SUMMARY_SYSTEM,
      user: plain.slice(0, 4000),
    });
    const summary = stripHtml(res?.summary || '');
    return (summary || plain).slice(0, maxChars);
  } catch {
    return plain.slice(0, maxChars);
  }
}

// ---------------------------------------------------------------------------
// Fact extraction
// ---------------------------------------------------------------------------

// Strict shape of a single candidate fact — the single source of truth for every schema where the model
// returns facts for long-term memory (fact extraction here and the history summarizer's facts_to_memory).
export const FACT_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'fact_text', 'confidence', 'ttl_days'],
  properties: {
    type: { type: 'string', enum: FACT_TYPES },
    fact_text: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    ttl_days: { type: ['integer', 'null'] },
  },
};

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: FACT_ITEM_SCHEMA,
    },
  },
};

const EXTRACT_SYSTEM = `Ты извлекаешь устойчивые факты о пользователе из его реплик в диалоге с ассистентом.

ИСТОЧНИК ФАКТОВ — ТОЛЬКО реплики пользователя (теги <user>). Текст в теге <assistant> — краткое
содержание ответа ассистента, он дан исключительно для понимания контекста реплики пользователя.
Из <assistant> факты НЕ извлекаются НИКОГДА, даже если там перечислены сведения о пользователе:
это уже сохранённая память, её повторное извлечение создаёт дубликаты.

Сохраняй только то, что поможет ассистенту быть внимательным, участливым и интересным собеседником
в БУДУЩИХ разговорах. Фиксируй паттерны, а не разовые состояния. Не делай психологических диагнозов.
Не используй слова «всегда» и «никогда». Формулируй fact_text одной короткой фразой от третьего лица
(«Пользователь …»), без HTML.

Типы фактов:
- profile — базовые сведения: имя, семья, город, работа, важные люди и обстоятельства.
- preference — вкусы и предпочтения (еда, музыка, форматы, что любит и не любит).
- habit — привычки и рутины («бегает по утрам», «пьёт кофе после обеда»).
- goal — цели и долгосрочные задачи, над которыми пользователь работает.
- emotional_pattern — повторяющиеся эмоциональные паттерны («часто устаёт вечером»).
- activity_rhythm — ритм активности («чаще пишет поздно вечером»).
- communication_style — стиль общения («предпочитает короткие ответы», «не любит много вопросов»).
- open_loop — незакрытая линия: план, событие, проблема или самочувствие без финала
  («собирался к врачу, обещал рассказать»). Для open_loop задавай ttl_days (по умолчанию 30).
- topic_energy — темы, где пользователь явно оживляется или теряет интерес.
- discovery_seed — темы, которые пользователь хотел бы попробовать или изучить
  («давно думаю попробовать йогу»).

НЕ сохраняй:
- что-либо из реплик ассистента;
- случайные эмоции, одноразовые детали, очевидные вещи, погоду, smalltalk;
- команды боту («покажи заметки», «напомни завтра») — это действия, а не факты о человеке;
- чувствительные данные (паспорт, платёжные данные, точный адрес, медицинские диагнозы) — пропускай
  такие сведения целиком;
- неуверенные догадки: если сомневаешься — снижай confidence или не сохраняй вовсе.

Реакция пользователя (например :heart:) на сообщение ассистента значима, только если смысл реакции
однозначен из текста сообщения, на которое он отреагировал: «Ты любишь торты?» + :heart: →
preference «Пользователь любит торты». Вежливое одобрение без содержания — не факт.

Срок жизни факта. Оценивай срок жизни факта по его природе, как это сделал бы человек:
- Именования и устойчивые договорённости об общении («называй меня на ты», «тебя зовут Шарик»,
  «отвечай без смайликов») — бессрочные: ttl_days = null. Действуют до явной отмены или замены.
- Сиюминутные оценки и настроения («ты весёлый», «ты сегодня молодец», «мне скучно») — не факты:
  не сохраняй. Если видишь повторяющийся паттерн — сохраняй паттерн, а не разовую реплику.
- Рабочие договорённости о текущей задаче («будешь помогать с курсовой», «правь тексты, которые
  пришлю») — это open_loop или goal со сроком: ttl_days 30–60. Они актуальны, пока жива задача,
  и должны затухать сами, если к ним не возвращаются.

Если сохранять нечего — верни {"facts": []}. Чаще всего так и есть.`;

// Fact extraction from user messages. assistantSummary is the summary of the ASSISTANT ANSWER the user
// was REPLYING TO (context of the message), not of the current answer. userMessages — the user's latest
// messages, the last one being the current one. intent — classifier result (intent of the current phrase).
export async function extractFacts({
  skillName = null,
  domainKey,
  userMessages = [],
  assistantSummary = '',
  intent = null,
}) {
  const messages = (Array.isArray(userMessages) ? userMessages : [userMessages]).filter(Boolean);
  if (!messages.length) {
    return [];
  }
  const skill = skillName ? getSkill(skillName) : getSkillByDomain(domainKey);
  const extractModel = skill?.model?.extract || config.llm.extractModel;
  const skillExtraction = skill ? getFactExtractionPrompt(skill.name) : '';
  const skillBlock = skillExtraction
    ? `\n\nACTIVE_SKILL_FACT_EXTRACTION (дополнение активного skill; правило «факты только из <user>» сохраняет силу)\n${skillExtraction}`
    : '';

  const intentLine = intent?.intent ? `Намерение пользователя (по классификатору): ${intent.intent}\n` : '';
  const assistantBlock = assistantSummary ? `<assistant>${stripHtml(assistantSummary)}</assistant>\n` : '';
  const previous = messages.slice(0, -1);
  const current = messages[messages.length - 1];
  const previousBlock = previous.length
    ? `Предыдущие реплики пользователя (для распознавания паттернов):\n${previous.map((m) => `<user>${m}</user>`).join('\n')}\n\n`
    : '';

  const user = `Домен: ${domainKey}
${intentLine}
${previousBlock}Контекст и текущая реплика:
${assistantBlock}<user>${current}</user>`;

  const result = await chatJSON({
    model: extractModel,
    kind: 'fact_extract',
    schema: EXTRACT_SCHEMA,
    schemaName: 'user_facts',
    system: EXTRACT_SYSTEM + skillBlock,
    user,
    responseFormat: config.llm.extractResponseFormat,
  });
  return Array.isArray(result?.facts) ? result.facts : [];
}

// ---------------------------------------------------------------------------
// Saving with semantic deduplication
// ---------------------------------------------------------------------------

// The semantically closest active fact of the same user and type. Returns a row with a similarity field
// (cosine similarity 0..1) or null. Without the embedding service we look for an exact text match.
async function findNearestFact({ userId, factType, vector, factText }) {
  if (vector) {
    const { rows } = await query(
      `SELECT id, fact_text, confidence, evidence_count, domain_key, source, persistent,
              1 - (embedding <=> $3::vector) AS similarity
         FROM mem.user_facts
        WHERE user_id = $1 AND fact_type = $2 AND status = 'active' AND embedding IS NOT NULL
        ORDER BY embedding <=> $3::vector
        LIMIT 1`,
      [userId, factType, vectorToSql(vector)],
    );
    return rows[0] || null;
  }
  const { rows } = await query(
    `SELECT id, fact_text, confidence, evidence_count, domain_key, source, persistent, 1.0 AS similarity
       FROM mem.user_facts
      WHERE user_id = $1 AND fact_type = $2 AND status = 'active' AND lower(fact_text) = lower($3)
      LIMIT 1`,
    [userId, factType, factText],
  );
  return rows[0] || null;
}

// Forgetting deadline (expires_at) by fact type: an explicit ttl_days from extraction takes priority,
// otherwise the facts.retention table from the config is used (0 — indefinite, expires_at = NULL).
function retentionExpiry(factType, ttlDays) {
  const days = Number(ttlDays) > 0 ? Number(ttlDays) : Number(config.facts.retention?.[factType]) || 0;
  return days > 0 ? new Date(Date.now() + days * 86400000) : null;
}

// Save a single fact with deduplication. opts.source — source type (see SOURCE_RANK, default
// 'user_statement'); fact.persistent = true pins the fact ("remember forever"): expires_at = NULL,
// the background sweep leaves the row alone, replacement is available only to sources of rank
// user_statement and above. Returns { action, id, ... }:
//   confirmed — a close fact already exists, the row was updated (freshness, evidence_count, wording);
//   replaced  — same topic with a new value: the old row is archived, a new one inserted;
//   created   — a new fact;
//   skipped   — failed the confidence threshold or unknown type.
export async function saveFact(userId, domainKey, fact, sourceConversationId = null, opts = {}) {
  const factType = FACT_TYPES.includes(fact.type) ? fact.type : null;
  const factText = String(fact.fact_text || '').trim();
  const confidence = Math.min(Math.max(Number(fact.confidence) || 0, 0), 0.99);
  const source = normalizeSource(opts.source);
  const persistent = fact.persistent === true;
  if (!factType || !factText) {
    return { action: 'skipped', reason: 'unknown type or empty text', fact };
  }
  if (confidence < config.facts.minConfidence) {
    return { action: 'skipped', reason: 'low confidence', fact };
  }

  const factDomain = GENERAL_TYPES.has(factType) ? 'general' : domainKey || 'general';
  const expiresAt = persistent ? null : retentionExpiry(factType, fact.ttl_days);
  const vector = await embed(factText);
  const nearest = await findNearestFact({ userId, factType, vector, factText });
  const similarity = nearest ? Number(nearest.similarity) : 0;
  const sourceRank = SOURCE_RANK[source];
  const nearestRank = nearest ? (SOURCE_RANK[nearest.source] ?? SOURCE_RANK.user_statement) : 0;

  if (nearest && similarity >= config.facts.confirmSimilarity) {
    // Confirmation: same meaning. A fresh wording is accepted only if the source rank is not below
    // the row's rank (for a pinned row — not below user_statement) — a weak source does not rewrite
    // a strong one's text, but it does extend freshness.
    const keepPersistent = nearest.persistent === true || persistent;
    const rewriteText = sourceRank >= (nearest.persistent === true ? SOURCE_RANK.user_statement : nearestRank);
    // A confirmation extends the forgetting deadline from the current moment for any type with non-zero
    // retention; a pinned row stays indefinite.
    const nextExpiry = keepPersistent ? null : retentionExpiry(factType, fact.ttl_days);
    await query(
      `UPDATE mem.user_facts
          SET fact_text = CASE WHEN $6 THEN $2 ELSE fact_text END,
              confidence = GREATEST(confidence, $3), evidence_count = evidence_count + 1,
              embedding = CASE WHEN $6 THEN COALESCE($4::vector, embedding) ELSE embedding END,
              last_confirmed_at = now(), updated_at = now(),
              persistent = $7,
              expires_at = CASE WHEN $7 THEN NULL ELSE COALESCE($5, expires_at) END
        WHERE id = $1`,
      [nearest.id, factText, confidence, vector ? vectorToSql(vector) : null, nextExpiry, rewriteText, keepPersistent],
    );
    return { action: 'confirmed', id: nearest.id, similarity, source };
  }

  if (nearest && similarity >= config.facts.replaceSimilarity) {
    // Same topic, new value ("moved to Kazan" on top of "lives in Moscow"): replacement.
    // Conflict rule: only a source of rank not below the old one may replace. For a pinned
    // (persistent) row the threshold is fixed — user_statement and above: the person explicitly
    // changed their mind ("Your name is Bobik" over the pinned "Your name is Sharik") — a regular
    // change with archiving. Otherwise a weak source merely confirms the row's freshness without
    // touching its text.
    const requiredRank = nearest.persistent === true ? SOURCE_RANK.user_statement : nearestRank;
    if (sourceRank < requiredRank) {
      await query(
        `UPDATE mem.user_facts
            SET evidence_count = evidence_count + 1, last_confirmed_at = now(), updated_at = now()
          WHERE id = $1`,
        [nearest.id],
      );
      return { action: 'confirmed', id: nearest.id, similarity, source, reason: 'source rank below existing' };
    }
    // Pinning is inherited: an explicit change of a pinned fact stays pinned (and indefinite).
    const insertPersistent = persistent || nearest.persistent === true;
    const { rows } = await query(
      `INSERT INTO mem.user_facts
         (user_id, domain_key, fact_type, fact_text, confidence, source_conversation_id, embedding,
          expires_at, source, persistent, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, jsonb_build_object('replaces', $11::text))
       RETURNING id`,
      [
        userId,
        factDomain,
        factType,
        factText,
        confidence,
        sourceConversationId,
        vector ? vectorToSql(vector) : null,
        insertPersistent ? null : expiresAt,
        source,
        insertPersistent,
        nearest.id,
      ],
    );
    await query(
      `UPDATE mem.user_facts
          SET status = 'archived', updated_at = now(),
              metadata = metadata || jsonb_build_object('replaced_by', $2::text)
        WHERE id = $1`,
      [nearest.id, rows[0].id],
    );
    return { action: 'replaced', id: rows[0].id, archived: nearest.id, similarity, source };
  }

  const { rows } = await query(
    `INSERT INTO mem.user_facts
       (user_id, domain_key, fact_type, fact_text, confidence, source_conversation_id, embedding,
        expires_at, source, persistent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      userId,
      factDomain,
      factType,
      factText,
      confidence,
      sourceConversationId,
      vector ? vectorToSql(vector) : null,
      expiresAt,
      source,
      persistent,
    ],
  );
  return { action: 'created', id: rows[0].id, source };
}

// Save a batch of extracted facts. Sequentially: deduplication within the batch must see the result
// of the previous inserts (two wordings of the same fact in one turn collapse into one).
// opts.source is passed to each saveFact.
export async function saveFacts(userId, domainKey, facts, sourceConversationId = null, opts = {}) {
  const results = [];
  for (const fact of facts || []) {
    try {
      results.push(await saveFact(userId, domainKey, fact, sourceConversationId, opts));
    } catch (err) {
      results.push({ action: 'error', error: String(err.message || err), fact });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Background sweep: collapsing accumulated semantic duplicates
// ---------------------------------------------------------------------------

// A pass over the user's active facts: same-type pairs with similarity above confirmSimilarity are
// merged — the row with the larger evidence_count survives (on a tie — the fresher one), its
// evidence_count is increased by the duplicate's counter, and the duplicate is archived.
// Returns { merged, checked } (in dry-run — the list of pairs without changes).
export async function dedupeFactsSweep({ userId, dryRun = false, limit = 500 } = {}) {
  const { rows: facts } = await query(
    `SELECT id, fact_type, fact_text, confidence, evidence_count, last_confirmed_at, embedding IS NOT NULL AS has_vec
       FROM mem.user_facts
      WHERE user_id = $1 AND status = 'active'
      ORDER BY fact_type, last_confirmed_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  const pairs = [];
  // Pairs are found in SQL with a single self-join by type: cosine similarity above the threshold.
  // Pinned (persistent) rows are never archived as duplicates: they can only be the "surviving"
  // side of a pair, so side b is always unpinned, and in the comparison pinning outweighs
  // evidence_count and freshness.
  const { rows: dupRows } = await query(
    `SELECT a.id AS keep_id, b.id AS drop_id, 1 - (a.embedding <=> b.embedding) AS similarity
       FROM mem.user_facts a
       JOIN mem.user_facts b
         ON b.user_id = a.user_id AND b.fact_type = a.fact_type AND b.id <> a.id
        AND b.status = 'active' AND b.embedding IS NOT NULL AND NOT b.persistent
      WHERE a.user_id = $1 AND a.status = 'active' AND a.embedding IS NOT NULL
        AND 1 - (a.embedding <=> b.embedding) >= $2
        AND (a.persistent, a.evidence_count, a.last_confirmed_at, a.id)
            > (b.persistent, b.evidence_count, b.last_confirmed_at, b.id)`,
    [userId, config.facts.confirmSimilarity],
  );
  const dropped = new Set();
  for (const row of dupRows) {
    if (dropped.has(row.keep_id) || dropped.has(row.drop_id)) {
      continue; // transitive chains are merged over several passes, not as a cascade in one
    }
    dropped.add(row.drop_id);
    pairs.push({ keepId: row.keep_id, dropId: row.drop_id, similarity: Number(row.similarity) });
  }
  if (dryRun) {
    return { merged: 0, checked: facts.length, pairs };
  }
  for (const pair of pairs) {
    await query(
      `UPDATE mem.user_facts
          SET evidence_count = evidence_count + (SELECT evidence_count FROM mem.user_facts WHERE id = $2),
              updated_at = now()
        WHERE id = $1`,
      [pair.keepId, pair.dropId],
    );
    await query(
      `UPDATE mem.user_facts
          SET status = 'archived', updated_at = now(),
              metadata = metadata || jsonb_build_object('merged_into', $2::text)
        WHERE id = $1`,
      [pair.dropId, pair.keepId],
    );
  }
  // Sweep summary — the memory.sweep event. Runs outside the request context (a scheduler task or
  // a manual script), so the event's correlation fields are NULL — the viewer shows it as a service one.
  logAgentEvent({
    eventType: AGENT_EVENTS.MEMORY_SWEEP,
    title: 'Чистка дубликатов памяти',
    data: { checked: facts.length, merged: pairs.length, pairs },
  });
  return { merged: pairs.length, checked: facts.length, pairs };
}
