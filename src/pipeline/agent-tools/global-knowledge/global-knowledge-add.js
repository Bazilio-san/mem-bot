import { addGlobalKnowledge } from '../../global-memory.js';

export const globalKnowledgeAddTool = {
  name: 'global_knowledge_add',
  title: 'Добавление в базу знаний',
  requiresAdmin: true,
  isEnabled: (ctx, config) => config.globalMemory.ragEnabled && ctx.isAdmin,
  definition: {
    type: 'function',
    function: {
      name: 'global_knowledge_add',
      description: 'Add a text fragment to the shared knowledge base.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['content'],
        properties: {
          title: { type: ['string', 'null'], description: 'Short optional title.' },
          content: { type: 'string', description: 'Knowledge text content.' },
        },
      },
    },
  },
  async handler(ctx, args) {
    const k = await addGlobalKnowledge({ title: args.title ?? null, content: args.content, createdBy: ctx.userId });
    return { id: k.id, title: k.title, content: k.content };
  },
};
