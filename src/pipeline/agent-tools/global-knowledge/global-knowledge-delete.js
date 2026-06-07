import { deleteGlobalKnowledge } from '../../global-memory.js';

export const globalKnowledgeDeleteTool = {
  name: 'global_knowledge_delete',
  title: 'Удаление из базы знаний',
  requiresAdmin: true,
  isEnabled: (ctx, config) => config.globalMemory.ragEnabled && ctx.isAdmin,
  definition: {
    type: 'function',
    function: {
      name: 'global_knowledge_delete',
      description: 'Delete a shared knowledge base text fragment by identifier.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: 'Knowledge fragment identifier.' } },
      },
    },
  },
  async handler(ctx, args) {
    const ok = await deleteGlobalKnowledge(args.id);
    return { deleted: ok };
  },
};
