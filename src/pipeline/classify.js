// Pipeline stage 1: fast classification of the incoming message with a cheap model.
// The classifier picks the single best-fitting skill (skill_name is the source of truth), and the domain key
// for addressing memory is derived from the chosen skill in code. It also determines the intent, important
// entities, which kinds of memory are needed, and whether tools are needed.
import { chatJSON } from '../llm.js';
import { config } from '../config.js';
import { listSkillRoutes } from './skills/registry.js';

// Schema of the classification result. The source of truth is skill_name, restricted to the available skills.
function buildSchema(routeNames) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'intent',
      'skill_name',
      'domain_key',
      'confidence',
      'entities',
      'needs_memory',
      'needed_memory_scopes',
      'needs_tools',
      'candidate_tools',
    ],
    properties: {
      intent: { type: 'string' },
      skill_name: { type: 'string', enum: routeNames },
      domain_key: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason: { type: 'string' },
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
}

// System prompt: a list of skills with a usage rule for each one.
function buildSystemPrompt(routes) {
  const list = routes
    .map((r) => {
      const pos = r.positive_signals?.length ? `\n    Положительные сигналы: ${r.positive_signals.join('; ')}` : '';
      const neg = r.negative_signals?.length ? `\n    Отрицательные сигналы: ${r.negative_signals.join('; ')}` : '';
      return `  - ${r.name} / domain ${r.domain_key}\n    Назначение: ${r.description}\n    Когда использовать: ${r.when_to_use}${pos}${neg}`;
    })
    .join('\n');
  return `Ты классификатор входящего сообщения для агентского приложения с памятью.
Определи намерение, важные сущности, какие виды памяти нужны и нужны ли инструменты.
Выбери ОДИН наиболее подходящий skill по смыслу запроса и верни его имя в поле skill_name точно как в списке.
В поле domain_key продублируй доменный ключ выбранного skill.
Положительные и отрицательные сигналы — подсказки, а не строгий список: выбирай по смыслу.
Если ни один специализированный skill не подходит, выбери general.

Доступные skills:
${list}

Не отвечай пользователю. Верни только JSON по схеме.`;
}

export async function classifyIntent(userMessage, currentDomainKey = 'general', shortState = '') {
  const routes = listSkillRoutes();
  const routeNames = routes.map((r) => r.name);
  return chatJSON({
    model: config.llm.auxModel,
    kind: 'intent_classify',
    schema: buildSchema(routeNames),
    schemaName: 'skill_classification',
    system: buildSystemPrompt(routes),
    user: `Текущий домен агента: ${currentDomainKey}
Последнее состояние диалога: ${shortState || 'нет'}
Сообщение пользователя: ${userMessage}`,
  });
}
