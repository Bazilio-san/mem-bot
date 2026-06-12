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

// Ранги источников фактов для разрешения конфликтов при записи: замещение существующей строки
// разрешено, только если ранг нового источника не ниже ранга старого. Закреплённые (persistent)
// строки замещает только источник ранга user_statement и выше — человек явно передумал.
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

Срок жизни факта. Оценивай срок жизни факта по его природе, как это сделал бы человек:
- Именования и устойчивые договорённости об общении («называй меня на ты», «тебя зовут Шарик»,
  «отвечай без смайликов») — бессрочные: ttl_days = null. Действуют до явной отмены или замены.
- Сиюминутные оценки и настроения («ты весёлый», «ты сегодня молодец», «мне скучно») — не факты:
  не сохраняй. Если видишь повторяющийся паттерн — сохраняй паттерн, а не разовую реплику.
- Рабочие договорённости о текущей задаче («будешь помогать с курсовой», «правь тексты, которые
  пришлю») — это open_loop или goal со сроком: ttl_days 30–60. Они актуальны, пока жива задача,
  и должны затухать сами, если к ним не возвращаются.

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
    responseFormat: config.llm.extractResponseFormat,
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

// Срок забывания (expires_at) по типу факта: явный ttl_days из извлечения имеет приоритет,
// иначе берётся таблица facts.retention из конфига (0 — бессрочно, expires_at = NULL).
function retentionExpiry(factType, ttlDays) {
  const days = Number(ttlDays) > 0 ? Number(ttlDays) : Number(config.facts.retention?.[factType]) || 0;
  return days > 0 ? new Date(Date.now() + days * 86400000) : null;
}

// Сохранить один факт с дедупликацией. opts.source — тип источника (см. SOURCE_RANK, дефолт
// 'user_statement'); fact.persistent = true закрепляет факт («запомни навсегда»): expires_at = NULL,
// фоновый sweep строку не трогает, замещение доступно только источникам ранга user_statement и выше.
// Возвращает { action, id, ... }:
//   confirmed — близкий факт уже есть, строка обновлена (свежесть, evidence_count, формулировка);
//   replaced  — та же тема с новым значением: старая строка архивирована, вставлена новая;
//   created   — новый факт;
//   skipped   — не прошёл порог уверенности или неизвестный тип.
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
    // Подтверждение: тот же смысл. Свежая формулировка принимается, только если ранг источника
    // не ниже ранга строки (для закреплённой строки — не ниже user_statement) — слабый источник
    // не переписывает текст сильного, но продлевает свежесть.
    const keepPersistent = nearest.persistent === true || persistent;
    const rewriteText = sourceRank >= (nearest.persistent === true ? SOURCE_RANK.user_statement : nearestRank);
    // Подтверждение продлевает срок забывания от текущего момента для любого типа с ненулевым
    // retention; закреплённая строка остаётся бессрочной.
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
    // Та же тема, новое значение («переехал в Казань» поверх «живёт в Москве»): замещение.
    // Правило конфликтов: замещать может только источник ранга не ниже старого. Для закреплённой
    // (persistent) строки порог фиксированный — user_statement и выше: человек явно передумал
    // («Тебя зовут Бобик» поверх закреплённого «Тебя зовут Шарик») — штатная смена с архивацией.
    // Иначе слабый источник лишь подтверждает свежесть строки, не трогая её текст.
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
    // Закрепление наследуется: явная смена закреплённого факта остаётся закреплённой (и бессрочной).
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

// Сохранить пачку извлечённых фактов. Последовательно: дедупликация внутри пачки должна видеть
// результат предыдущих вставок (две формулировки одного факта в одном ходе схлопнутся).
// opts.source передаётся каждому saveFact.
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
  // Закреплённые (persistent) строки не архивируются как дубликаты: они могут быть только
  // «выжившей» стороной пары, поэтому сторона b всегда не закреплена, а при сравнении
  // закрепление весит больше evidence_count и свежести.
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
  // Итог чистки — событие memory.sweep. Запускается вне request-контекста (задача планировщика или
  // ручной скрипт), поэтому корреляционные поля события NULL — просмотрщик покажет его как сервисное.
  logAgentEvent({
    eventType: AGENT_EVENTS.MEMORY_SWEEP,
    title: 'Чистка дубликатов памяти',
    data: { checked: facts.length, merged: pairs.length, pairs },
  });
  return { merged: pairs.length, checked: facts.length, pairs };
}
