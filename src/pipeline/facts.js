// Долговременные факты о пользователе: извлечение из диалога, саммари ответа ассистента,
// сохранение с семантической дедупликацией и фоновая чистка дубликатов.
//
// Принципы (см. docs/ai-bot-with-memory/06-memory.md):
// - Источник фактов — ТОЛЬКО реплики пользователя. Ответ ассистента подаётся в контекст извлечения
//   как короткое саммари без HTML в теге <assistant> и явно исключается из извлечения, иначе модель
//   принимает перечисленные ботом сохранённые факты за новые сведения и память лавинообразно растёт.
// - Хранилище плоское: mem.user_facts (пользователь × домен × тип × текст + embedding).
//   Никаких entity-схем и второго прохода уточнения — одно обращение к LLM на ход.
// - Дедупликация на записи: близкий по смыслу факт того же типа подтверждает существующую строку
//   (evidence_count+1, свежесть) либо замещает её (новое значение той же темы), а не плодит дубликаты.
import { query, vectorToSql } from '../db.js';
import { chatJSON, embed } from '../llm.js';
import { config } from '../config.js';
import { getFactExtractionPrompt, getSkill, getSkillByDomain } from './skills/registry.js';

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

// Типы, описывающие человека вне предметной области: хранятся в домене general и доступны из любого
// домена. Остальные (goal, open_loop) привязываются к домену текущего разговора.
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

// Маппинг старых memory_kind (суммаризатор истории, миграция) в типы плоской таблицы.
const KIND_TO_TYPE = {
  fact: 'profile',
  preference: 'preference',
  constraint: 'preference',
  goal: 'goal',
  history: 'profile',
  state: 'open_loop',
  progress: 'goal',
  instruction: 'communication_style',
  relationship: 'profile',
  emotional_pattern: 'emotional_pattern',
  activity_rhythm: 'activity_rhythm',
  communication_style: 'communication_style',
  open_loop: 'open_loop',
  topic_energy: 'topic_energy',
  discovery_seed: 'discovery_seed',
};

export function mapKindToType(kind) {
  return KIND_TO_TYPE[kind] || null;
}

// Грубая очистка от HTML-разметки: ответы бота в Telegram-канале содержат <b>/<i> и т.п.
// Используется для саммари-фолбэка и для текста цели реакции.
export function stripHtml(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Саммари ответа ассистента
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

// Краткое содержание ответа ассистента. Хранится в metadata сообщения и заменяет полный текст ответа
// в контексте извлечения фактов. При любой ошибке LLM возвращается обрезанный plain-text — конвейер
// не зависит от доступности модели.
export async function summarizeAnswer(answer, { model = config.llm.auxModel } = {}) {
  const plain = stripHtml(answer);
  const maxChars = config.facts.summaryMaxChars;
  if (!plain) {
    return '';
  }
  if (plain.length <= 120) {
    return plain; // короткий ответ сам себе саммари — не тратим вызов модели
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
// Извлечение фактов
// ---------------------------------------------------------------------------

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'fact_text', 'confidence', 'ttl_days'],
        properties: {
          type: { type: 'string', enum: FACT_TYPES },
          fact_text: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          ttl_days: { type: ['integer', 'null'] },
        },
      },
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

Если сохранять нечего — верни {"facts": []}. Чаще всего так и есть.`;

// Извлечение фактов из реплик пользователя. assistantSummary — краткое содержание ОТВЕТА АССИСТЕНТА,
// НА КОТОРЫЙ пользователь отвечал (контекст реплики), не текущего ответа. userMessages — последние
// реплики пользователя, последняя — текущая. intent — результат классификатора (намерение текущей фразы).
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
  });
  return Array.isArray(result?.facts) ? result.facts : [];
}

// ---------------------------------------------------------------------------
// Сохранение с семантической дедупликацией
// ---------------------------------------------------------------------------

// Ближайший по смыслу активный факт того же пользователя и типа. Возвращает строку с полем similarity
// (косинусное сходство 0..1) либо null. Без embedding-сервиса ищем точное совпадение текста.
async function findNearestFact({ userId, factType, vector, factText }) {
  if (vector) {
    const { rows } = await query(
      `SELECT id, fact_text, confidence, evidence_count, domain_key,
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
    `SELECT id, fact_text, confidence, evidence_count, domain_key, 1.0 AS similarity
       FROM mem.user_facts
      WHERE user_id = $1 AND fact_type = $2 AND status = 'active' AND lower(fact_text) = lower($3)
      LIMIT 1`,
    [userId, factType, factText],
  );
  return rows[0] || null;
}

function openLoopExpiry(ttlDays) {
  const days = Number(ttlDays) > 0 ? Number(ttlDays) : config.facts.openLoopTtlDays;
  return new Date(Date.now() + days * 86400000);
}

// Сохранить один факт с дедупликацией. Возвращает { action, id, ... }:
//   confirmed — близкий факт уже есть, строка обновлена (свежесть, evidence_count, формулировка);
//   replaced  — та же тема с новым значением: старая строка архивирована, вставлена новая;
//   created   — новый факт;
//   skipped   — не прошёл порог уверенности или неизвестный тип.
export async function saveFact(userId, domainKey, fact, sourceConversationId = null) {
  const factType = FACT_TYPES.includes(fact.type) ? fact.type : mapKindToType(fact.type);
  const factText = String(fact.fact_text || '').trim();
  const confidence = Math.min(Math.max(Number(fact.confidence) || 0, 0), 0.99);
  if (!factType || !factText) {
    return { action: 'skipped', reason: 'unknown type or empty text', fact };
  }
  if (confidence < config.facts.minConfidence) {
    return { action: 'skipped', reason: 'low confidence', fact };
  }

  const factDomain = GENERAL_TYPES.has(factType) ? 'general' : domainKey || 'general';
  const expiresAt =
    factType === 'open_loop' ? openLoopExpiry(fact.ttl_days) : fact.ttl_days ? openLoopExpiry(fact.ttl_days) : null;
  const vector = await embed(factText);
  const nearest = await findNearestFact({ userId, factType, vector, factText });
  const similarity = nearest ? Number(nearest.similarity) : 0;

  if (nearest && similarity >= config.facts.confirmSimilarity) {
    // Подтверждение: тот же смысл. Берём более свежую формулировку, поднимаем уверенность и свежесть.
    await query(
      `UPDATE mem.user_facts
          SET fact_text = $2, confidence = GREATEST(confidence, $3), evidence_count = evidence_count + 1,
              embedding = COALESCE($4::vector, embedding), last_confirmed_at = now(), updated_at = now(),
              expires_at = CASE WHEN fact_type = 'open_loop' THEN $5 ELSE expires_at END
        WHERE id = $1`,
      [nearest.id, factText, confidence, vector ? vectorToSql(vector) : null, expiresAt],
    );
    return { action: 'confirmed', id: nearest.id, similarity };
  }

  if (nearest && similarity >= config.facts.replaceSimilarity) {
    // Та же тема, новое значение («переехал в Казань» поверх «живёт в Москве»): замещение.
    const { rows } = await query(
      `INSERT INTO mem.user_facts
         (user_id, domain_key, fact_type, fact_text, confidence, source_conversation_id, embedding,
          expires_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, jsonb_build_object('replaces', $9::text))
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
    return { action: 'replaced', id: rows[0].id, archived: nearest.id, similarity };
  }

  const { rows } = await query(
    `INSERT INTO mem.user_facts
       (user_id, domain_key, fact_type, fact_text, confidence, source_conversation_id, embedding, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
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
    ],
  );
  return { action: 'created', id: rows[0].id };
}

// Сохранить пачку извлечённых фактов. Последовательно: дедупликация внутри пачки должна видеть
// результат предыдущих вставок (две формулировки одного факта в одном ходе схлопнутся).
export async function saveFacts(userId, domainKey, facts, sourceConversationId = null) {
  const results = [];
  for (const fact of facts || []) {
    try {
      results.push(await saveFact(userId, domainKey, fact, sourceConversationId));
    } catch (err) {
      results.push({ action: 'error', error: String(err.message || err), fact });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Фоновая чистка: схлопывание накопившихся семантических дубликатов
// ---------------------------------------------------------------------------

// Проход по активным фактам пользователя: пары одного типа со сходством выше confirmSimilarity
// сливаются — остаётся строка с большим evidence_count (при равенстве — более свежая), её
// evidence_count увеличивается на счётчик дубликата, дубликат архивируется.
// Возвращает { merged, checked } (в dry-run — список пар без изменений).
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
  // Пары ищем в SQL одним самосоединением по типу: косинусное сходство выше порога.
  const { rows: dupRows } = await query(
    `SELECT a.id AS keep_id, b.id AS drop_id, 1 - (a.embedding <=> b.embedding) AS similarity
       FROM mem.user_facts a
       JOIN mem.user_facts b
         ON b.user_id = a.user_id AND b.fact_type = a.fact_type AND b.id <> a.id
        AND b.status = 'active' AND b.embedding IS NOT NULL
      WHERE a.user_id = $1 AND a.status = 'active' AND a.embedding IS NOT NULL
        AND 1 - (a.embedding <=> b.embedding) >= $2
        AND (a.evidence_count, a.last_confirmed_at, a.id) > (b.evidence_count, b.last_confirmed_at, b.id)`,
    [userId, config.facts.confirmSimilarity],
  );
  const dropped = new Set();
  for (const row of dupRows) {
    if (dropped.has(row.keep_id) || dropped.has(row.drop_id)) {
      continue; // транзитивные цепочки сливаем за несколько проходов, не каскадом за один
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
  return { merged: pairs.length, checked: facts.length, pairs };
}
