import { saveFact, FACT_TYPES } from '../../facts.js';

// «Запомни навсегда»: явная просьба пользователя закрепить факт. Записывается с source = 'manual'
// (высший ранг) и persistent = true — без срока забывания, фоновый sweep строку не трогает,
// заместить её может только новое явное высказывание пользователя.
export const memoryPinTool = {
  name: 'memory_pin',
  title: 'Запоминаю навсегда...',
  definition: {
    type: 'function',
    function: {
      name: 'memory_pin',
      description: `Permanently pin a fact the user explicitly asked to remember forever. The fact never expires, survives background cleanup and can only be replaced by a new explicit user statement.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['fact_text', 'fact_type'],
        properties: {
          fact_text: {
            type: 'string',
            description: 'The fact to pin, one short third-person sentence in the dialog language, no HTML.',
          },
          fact_type: {
            type: 'string',
            enum: FACT_TYPES,
            description: `Fact type; use 'profile' for free-form facts that do not fit other types.`,
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    const fact = {
      type: args.fact_type,
      fact_text: args.fact_text,
      confidence: 0.99,
      persistent: true,
    };
    const result = await saveFact(ctx.userId, ctx.domainKey || 'general', fact, ctx.conversationId || null, {
      source: 'manual',
    });
    return result;
  },
};
