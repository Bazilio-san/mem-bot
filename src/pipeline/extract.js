// Этап извлечения кандидатов в долговременную память из диалога (после ответа).
// Запускается асинхронно, чтобы не задерживать ответ пользователю. Сохраняет только
// то, что полезно в будущем; мусор и одноразовые детали отбрасывает.
import { chatJSON } from '../llm.js';
import { config } from '../config.js';

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
  const result = await chatJSON({
    model: config.llm.extractModel,
    schema: SCHEMA,
    schemaName: 'memory_candidates',
    system: SYSTEM,
    user: `Домен: ${domainKey}

Последние сообщения:
${recentMessages}

Ответ ассистента:
${assistantResponse}`,
  });
  return result.candidates || [];
}
