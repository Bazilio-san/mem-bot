import { forgetAll } from '../../admin.js';

export const memoryForgetAllTool = {
  name: 'memory_forget_all',
  title: 'Полное удаление личной памяти',
  definition: {
    type: 'function',
    function: {
      name: 'memory_forget_all',
      description: 'Forget all active personal memory only after an explicit user request and confirmation.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['confirm'],
        properties: {
          confirm: { type: 'boolean', description: 'Must be true to protect against accidental full deletion.' },
        },
      },
    },
  },
  async handler(ctx, args) {
    if (args.confirm !== true) {
      return { deleted: 0, error: 'Нужно явное подтверждение пользователя (confirm=true).' };
    }
    const deleted = await forgetAll(ctx.userId);
    return { deleted };
  },
};
