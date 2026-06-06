// Этап 1 пайплайна: быстрая классификация входящего сообщения дешёвой моделью.
// Определяет намерение, домен, сущности и то, какие виды памяти и инструменты нужны.
import { chatJSON } from '../llm.js';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'domain_key', 'confidence', 'entities', 'needs_memory', 'needed_memory_scopes', 'needs_tools', 'candidate_tools'],
  properties: {
    intent: { type: 'string' },
    domain_key: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    entities: { type: 'object', additionalProperties: true },
    needs_memory: { type: 'boolean' },
    needed_memory_scopes: {
      type: 'array',
      items: { type: 'string', enum: ['dialog', 'profile', 'domain', 'secure', 'reminder'] },
    },
    needs_tools: { type: 'boolean' },
    candidate_tools: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM = `Ты классификатор входящего сообщения для агентского приложения с памятью.
Определи: намерение пользователя; домен (general, travel, landing_sales, math_tutor или другой явно указанный);
важные сущности; какие виды памяти нужны; нужны ли инструменты.
Не отвечай пользователю. Верни только JSON по схеме.`;

export async function classifyIntent(userMessage, currentDomainKey = 'general', shortState = '') {
  return chatJSON({
    schema: SCHEMA,
    schemaName: 'intent_classification',
    system: SYSTEM,
    user: `Текущий домен агента: ${currentDomainKey}
Последнее состояние диалога: ${shortState || 'нет'}
Сообщение пользователя: ${userMessage}`,
  });
}
