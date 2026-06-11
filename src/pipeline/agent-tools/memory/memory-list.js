import { listMemory } from '../../admin.js';
import { FACT_TYPES } from '../../facts.js';

export const memoryListTool = {
  name: 'memory_list',
  title: 'Смотрю личную память...',
  definition: {
    type: 'function',
    function: {
      name: 'memory_list',
      description: 'Show the user what facts are stored in their personal memory.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['fact_type', 'include_archived'],
        properties: {
          fact_type: {
            type: ['string', 'null'],
            enum: [...FACT_TYPES, null],
            description: 'Optional fact type filter; null means all types.',
          },
          include_archived: { type: 'boolean', description: 'Whether archived records should be included.' },
        },
      },
    },
  },
  async handler(ctx, args) {
    const rows = await listMemory(ctx.userId, { includeArchived: args.include_archived === true });
    const factType = args.fact_type || null;
    const filtered = factType ? rows.filter((r) => r.fact_type === factType) : rows;
    const items = filtered.map((r) => ({
      id: r.id,
      fact_type: r.fact_type,
      domain: r.domain_key,
      confidence: Number(r.confidence),
      status: r.status,
      fact_text: r.fact_text,
    }));
    return { items };
  },
};
