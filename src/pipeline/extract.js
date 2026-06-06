// Этап извлечения кандидатов в долговременную память из диалога (после ответа).
// Запускается асинхронно, чтобы не задерживать ответ пользователю. Сохраняет только
// то, что полезно в будущем; мусор и одноразовые детали отбрасывает.
import { chatJSON } from '../llm.js';
import { config } from '../config.js';
import { loadDomainDefinition, getEntitySpec } from '../schema/registry.js';

// Подсказка для первого прохода: если у домена есть схема, перечисляем его сущности и поля data,
// чтобы модель сразу выбирала правильный entity_type. Для доменов без схемы возвращается пустая строка.
async function buildSchemaHint(domainKey) {
  const def = await loadDomainDefinition(domainKey);
  if (!def || !def.entities?.length) return '';
  const lines = def.entities.map((e) => {
    const fields = Object.keys(e.data_schema?.properties || {}).join(', ');
    return `  - ${e.entity_type}: поля data — ${fields}`;
  });
  return `\nУ домена есть схема памяти. Для предметных фактов используй эти типы сущностей и поля data:\n${lines.join('\n')}`;
}

// Собрать строгую закрытую схему ответа под конкретную сущность для второго прохода.
// Модель обязана вернуть ровно entity_key, memory_text и data по схеме сущности: лишних полей нет,
// все поля data перечислены, типы и enum заданы. Для fixed_vocab ключ ограничивается словарём.
function buildEntityExtractionSchema(spec) {
  const entityKeyProp = spec.entity_key.mode === 'fixed_vocab'
    ? { type: 'string', enum: spec.entity_key.vocabulary || [] }
    : { type: 'string' };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['entity_key', 'memory_text', 'data'],
    properties: {
      entity_key: entityKeyProp,
      memory_text: { type: 'string' },
      data: spec.data_schema,
    },
  };
}

// Второй проход: перезаполнить data и entity_key кандидата строго по схеме его сущности.
// Кандидат без entity_type или сущность вне схемы домена возвращаются без изменений
// (на записи такой предметный факт всё равно будет отклонён, если сущности нет в схеме).
async function refineCandidate(domainKey, candidate, contextText) {
  if (!candidate.entity_type) return candidate;
  const spec = await getEntitySpec(domainKey, candidate.entity_type);
  if (!spec) return candidate;

  const schema = buildEntityExtractionSchema(spec);
  const system = `Ты заполняешь факт памяти для домена «${domainKey}», сущность «${spec.entity_type}».
Заполни data СТРОГО по схеме: только перечисленные поля, точные типы и enum, без лишних ключей.
entity_key выбери по смыслу${spec.entity_key.mode === 'fixed_vocab' ? ' из допустимых значений словаря' : ' (короткий стабильный ключ)'}.
memory_text — короткая человеческая фраза о факте. Если значения поля нет в реплике — поставь null или пустой массив.`;
  const user = `Факт: ${candidate.memory_text}\n\nКонтекст диалога:\n${contextText}`;

  try {
    const filled = await chatJSON({
      model: config.llm.extractModel,
      schema,
      schemaName: spec.entity_type,
      system,
      user,
    });
    return {
      ...candidate,
      data: filled?.data ?? candidate.data,
      entity_key: filled?.entity_key ?? candidate.entity_key,
      memory_text: filled?.memory_text || candidate.memory_text,
    };
  } catch {
    // Если строгий проход не удался — оставляем кандидата как есть; контроль сработает на записи.
    return candidate;
  }
}

// Прогнать все кандидаты через второй проход. Предметные кандидаты со схемой уточняются параллельно;
// для домена без схемы список возвращается без изменений (второй проход не запускается).
async function refineCandidates(domainKey, candidates, contextText) {
  const def = await loadDomainDefinition(domainKey);
  if (!def) return candidates;
  return Promise.all(candidates.map((c) => refineCandidate(domainKey, c, contextText)));
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'memory_kind', 'entity_type', 'entity_key', 'memory_text', 'data',
          'importance', 'confidence', 'sensitivity', 'ttl_days', 'requires_confirmation', 'reason'],
        properties: {
          scope: { type: 'string', enum: ['profile', 'domain', 'dialog', 'system'] },
          memory_kind: { type: 'string', enum: ['fact', 'preference', 'constraint', 'goal', 'history', 'state', 'progress', 'instruction', 'relationship', 'reminder', 'secure_reference'] },
          entity_type: { type: ['string', 'null'] },
          entity_key: { type: ['string', 'null'] },
          memory_text: { type: 'string' },
          data: { type: 'object', additionalProperties: true },
          importance: { type: 'number', minimum: 0, maximum: 1 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          sensitivity: { type: 'string', enum: ['public', 'low', 'normal', 'high', 'secret'] },
          ttl_days: { type: ['integer', 'null'] },
          requires_confirmation: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
    },
  },
};

const SYSTEM = `Ты извлекаешь кандидаты в долговременную память из диалога.
Сохраняй только то, что будет полезно в будущих диалогах:
устойчивые предпочтения, стиль общения, важные цели и ограничения, предметные факты домена,
прогресс пользователя, долгосрочные задачи, важные отношения сущностей.
НЕ сохраняй: случайные эмоции без будущей пользы; одноразовые детали; очевидные вещи;
неподтверждённые догадки с низкой уверенностью; секретные данные как обычный текст.
Чувствительные данные (паспорт, телефон, адрес, дата рождения, платёжные, медицинские):
ставь sensitivity = high или secret и requires_confirmation = true, а memory_text делай безопасным
резюме без полного значения.
Если из сообщения нечего сохранять (короткие подтверждения, смех, эмоции, погода) — верни {"candidates": []}.

Примеры:
Сообщение «Я не люблю длинные ответы, пиши коротко» →
  candidates:[{scope:"profile",memory_kind:"preference",memory_text:"Пользователь предпочитает короткие ответы",importance:0.8,confidence:0.9,sensitivity:"low",requires_confirmation:false,...}]
Сообщение «Я плохо понимаю квадратные уравнения» (домен math_tutor) →
  candidates:[{scope:"domain",memory_kind:"progress",entity_type:"topic",entity_key:"quadratic_equations",memory_text:"Пользователь слабо понимает квадратные уравнения",importance:0.8,confidence:0.85,sensitivity:"normal",...}]
Сообщение «Ок» / «Хаха» / «Сегодня плохая погода» → candidates:[]
Сообщение «Мой паспорт 1234 567890» →
  candidates:[{scope:"domain",memory_kind:"secure_reference",memory_text:"У пользователя есть паспорт (полное значение не хранить как обычный факт)",importance:0.7,confidence:0.9,sensitivity:"secret",requires_confirmation:true,...}]`;

export async function extractCandidates({ domainKey, recentMessages, assistantResponse }) {
  const schemaHint = await buildSchemaHint(domainKey);
  const result = await chatJSON({
    model: config.llm.extractModel,
    schema: SCHEMA,
    schemaName: 'memory_candidates',
    system: SYSTEM + schemaHint,
    user: `Домен: ${domainKey}

Последние сообщения:
${recentMessages}

Ответ ассистента:
${assistantResponse}`,
  });
  const candidates = result.candidates || [];
  // Второй проход: для предметных кандидатов со схемой перезаполняем data/entity_key строго по схеме сущности.
  return refineCandidates(domainKey, candidates, `${recentMessages}\n${assistantResponse}`);
}

// Извлечение тем диалога для тематического трекинга (критерий 13). Возвращает массив тем с оценкой
// вовлечённости пользователя. Используется только в режиме собеседника (COMPANION_MODE).
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
          topic_key: { type: 'string' },        // короткий стабильный ключ: fitness, work_stress, travel
          user_engagement: { type: 'number' },   // 0..1 — насколько живо пользователь отвечал по теме
        },
      },
    },
  },
};

const TOPICS_SYSTEM = `Ты выделяешь темы из диалога. Верни короткие стабильные ключи тем латиницей в snake_case
и оценку вовлечённости пользователя в каждую тему от 0 до 1 (высокая — пользователь активно отвечает и развивает тему,
низкая — отвечает односложно или уходит). Если тем нет — верни {"topics": []}.`;

export async function extractTopics({ recentMessages }) {
  try {
    const res = await chatJSON({
      model: config.llm.auxModel,
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
