import { deleteByEntity } from '../../admin.js';

export const memoryForgetEntityTool = {
  name: 'memory_forget_entity',
  title: 'Удаляю факт из личной памяти...',
  definition: {
    type: 'function',
    function: {
      name: 'memory_forget_entity',
      description:
        'Soft-delete personal memory by fact text fragment, item id, or exact fact text shown by memory_list.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['entity_name', 'entity_type'],
        properties: {
          entity_name: { type: 'string', description: 'Fact text fragment, item id, or exact fact text to delete.' },
          entity_type: { type: ['string', 'null'], description: 'Fact type hint, or null when no hint is needed.' },
        },
      },
    },
  },
  handler(ctx, args) {
    return deleteByEntity(ctx.userId, args.entity_name, args.entity_type || null);
  },
};
