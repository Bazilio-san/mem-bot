import { deleteByEntity } from '../admin.js';

export const memoryForgetEntityTool = {
  name: 'memory_forget_entity',
  title: 'Удаление факта из памяти',
  definition: {
    type: 'function',
    function: {
      name: 'memory_forget_entity',
      description: 'Soft-delete a specific personal memory entity when the user asks to forget it.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['entity_name', 'entity_type'],
        properties: {
          entity_name: { type: 'string', description: 'Entity name or key to delete, such as address or passport.' },
          entity_type: { type: ['string', 'null'], description: 'Entity type hint, or null when no hint is needed.' },
        },
      },
    },
  },
  handler(ctx, args) {
    return deleteByEntity(ctx.userId, args.entity_name, args.entity_type || null);
  },
};
