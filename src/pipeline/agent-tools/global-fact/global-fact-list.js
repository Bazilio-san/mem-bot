import { listGlobalFacts } from '../../global-memory.js';

export const globalFactListTool = {
  name: 'global_fact_list',
  title: 'Список глобальных фактов',
  requiresAdmin: true,
  isEnabled: (ctx, config) => config.globalMemory.factsEnabled && ctx.isAdmin,
  definition: {
    type: 'function',
    function: {
      name: 'global_fact_list',
      description: 'List global facts with identifiers.',
      parameters: { type: 'object', additionalProperties: false, required: [], properties: {} },
    },
  },
  async handler() {
    const facts = await listGlobalFacts({ includeDisabled: true });
    return {
      facts: facts.map((f) => ({
        id: f.id,
        fact_text: f.fact_text,
        enabled: f.enabled,
        priority: f.priority,
      })),
    };
  },
};
