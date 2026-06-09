import { deleteGlobalFact } from '../../global-memory.js';

export const globalFactDeleteTool = {
  name: 'global_fact_delete',
  title: 'Удаляю глобальный факт...',
  requiresAdmin: true,
  isEnabled: (ctx, config) => config.globalMemory.factsEnabled && ctx.isAdmin,
  definition: {
    type: 'function',
    function: {
      name: 'global_fact_delete',
      description: 'Delete a global fact by identifier.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: 'Global fact identifier.' } },
      },
    },
  },
  async handler(ctx, args) {
    const ok = await deleteGlobalFact(args.id);
    return { deleted: ok };
  },
};
