import { addGlobalFact } from '../../global-memory.js';

export const globalFactAddTool = {
  name: 'global_fact_add',
  title: 'Добавляю глобальный факт...',
  requiresAdmin: true,
  isEnabled: (ctx, config) => config.globalMemory.factsEnabled && ctx.isAdmin,
  definition: {
    type: 'function',
    function: {
      name: 'global_fact_add',
      description: 'Add a global fact that is visible to all users and included in every request.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['fact_text'],
        properties: {
          fact_text: { type: 'string', description: 'Global fact text.' },
          priority: { type: ['integer', 'null'], description: 'Lower values are included earlier; default is 100.' },
        },
      },
    },
  },
  async handler(ctx, args) {
    const f = await addGlobalFact({ factText: args.fact_text, priority: args.priority ?? 100, createdBy: ctx.userId });
    return { id: f.id, fact_text: f.fact_text, priority: f.priority };
  },
};
