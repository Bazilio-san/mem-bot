import { searchGlobalKnowledge } from '../../global-memory.js';

export const globalKnowledgeSearchTool = {
  name: 'global_knowledge_search',
  title: 'Поиск в базе знаний',
  isEnabled: (ctx, config) => config.globalMemory.ragEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'global_knowledge_search',
      description: 'Find relevant text fragments in the shared knowledge base. Use this when the user asks for '
        + 'documented bot capabilities, policies, manuals, or knowledge-base content.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'limit'],
        properties: {
          query: { type: 'string', description: 'Search query.' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum number of fragments to return.' },
        },
      },
    },
  },
  async handler(ctx, args) {
    const hits = await searchGlobalKnowledge({ domainKey: ctx.domainKey, query: args.query, limit: args.limit || 5 });
    return { fragments: hits.map((h) => (h.title ? `${h.title}: ${h.content}` : h.content)) };
  },
};
