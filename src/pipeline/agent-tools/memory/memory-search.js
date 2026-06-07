import { query, vectorToSql } from '../../../db.js';
import { embed } from '../../../llm.js';
import { getDomainId } from '../../../repo.js';

export const memorySearchTool = {
  name: 'memory_search',
  title: 'Поиск в памяти',
  definition: {
    type: 'function',
    function: {
      name: 'memory_search',
      description: 'Find relevant user memory facts for the current context.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'limit'],
        properties: {
          query: { type: 'string', description: 'Search query.' },
          limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Maximum number of facts to return.' },
        },
      },
    },
  },
  async handler(ctx, args) {
    const domainId = await getDomainId(ctx.domainKey);
    const vec = await embed(args.query);
    if (vec) {
      const { rows } = await query(
        `SELECT memory_text, scope, importance, 1 - (embedding <=> $3::vector) AS relevance
         FROM mem.memory_items
         WHERE user_id=$1 AND status='active' AND embedding IS NOT NULL
           AND sensitivity IN ('public','low','normal')
           AND (scope='profile' OR (scope='domain' AND domain_id=$2) OR scope='dialog')
         ORDER BY embedding <=> $3::vector LIMIT $4`,
        [ctx.userId, domainId, vectorToSql(vec), args.limit || 10],
      );
      return { facts: rows.map((r) => r.memory_text) };
    }
    const { rows } = await query(
      `SELECT memory_text FROM mem.memory_items
       WHERE user_id=$1 AND status='active' AND search_tsv @@ plainto_tsquery('simple',$2)
         AND sensitivity IN ('public','low','normal')
       ORDER BY importance DESC LIMIT $3`,
      [ctx.userId, args.query, args.limit || 10],
    );
    return { facts: rows.map((r) => r.memory_text) };
  },
};
