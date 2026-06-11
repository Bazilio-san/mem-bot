import { query, vectorToSql } from '../../../db.js';
import { embed } from '../../../llm.js';

export const memorySearchTool = {
  name: 'memory_search',
  title: 'Ищу в личной памяти...',
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
    const vec = await embed(args.query);
    if (vec) {
      const { rows } = await query(
        `SELECT fact_text, 1 - (embedding <=> $3::vector) AS relevance
           FROM mem.user_facts
          WHERE user_id=$1 AND status='active' AND embedding IS NOT NULL
            AND (expires_at IS NULL OR expires_at > now())
            AND domain_key IN ('general', $2)
          ORDER BY embedding <=> $3::vector LIMIT $4`,
        [ctx.userId, ctx.domainKey || 'general', vectorToSql(vec), args.limit || 10],
      );
      return { facts: rows.map((r) => r.fact_text) };
    }
    const { rows } = await query(
      `SELECT fact_text FROM mem.user_facts
        WHERE user_id=$1 AND status='active' AND search_tsv @@ plainto_tsquery('simple',$2)
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY confidence DESC LIMIT $3`,
      [ctx.userId, args.query, args.limit || 10],
    );
    return { facts: rows.map((r) => r.fact_text) };
  },
};
