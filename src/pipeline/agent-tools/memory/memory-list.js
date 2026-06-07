import { listMemory } from '../../admin.js';

export const memoryListTool = {
  name: 'memory_list',
  title: 'Список личной памяти',
  definition: {
    type: 'function',
    function: {
      name: 'memory_list',
      description: 'Show the user what facts are stored in their personal memory.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['scope', 'include_archived'],
        properties: {
          scope: {
            type: ['string', 'null'],
            enum: ['profile', 'domain', 'dialog', null],
            description: 'Optional memory scope filter; null means all scopes.',
          },
          include_archived: { type: 'boolean', description: 'Whether archived records should be included.' },
        },
      },
    },
  },
  async handler(ctx, args) {
    const rows = await listMemory(ctx.userId, { includeArchived: args.include_archived === true });
    const scope = args.scope || null;
    const filtered = scope ? rows.filter((r) => r.scope === scope) : rows;
    const items = filtered.map((r) => {
      const isProtected = r.sensitivity === 'high' || r.sensitivity === 'secret';
      return {
        id: r.id,
        scope: r.scope,
        entity_type: r.entity_type,
        entity_key: r.entity_key,
        importance: r.importance,
        status: r.status,
        memory_text: isProtected ? '[защищённые данные — скрыто]' : r.memory_text,
      };
    });
    return { items };
  },
};
