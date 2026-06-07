import { getSecureValue } from '../secure.js';

export const secureRecordGetTool = {
  name: 'secure_record_get',
  title: 'Доступ к защищённой записи',
  definition: {
    type: 'function',
    function: {
      name: 'secure_record_get',
      description: 'Read a full protected value only when it is required for a concrete action and consent exists.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['secure_record_id', 'purpose'],
        properties: {
          secure_record_id: { type: 'string', description: 'Protected record identifier.' },
          purpose: { type: 'string', description: 'Concrete reason why the protected value is needed.' },
        },
      },
    },
  },
  async handler(ctx, args) {
    const res = await getSecureValue(args.secure_record_id, args.purpose);
    return { record_type: res.record_type, value: res.value, purpose: res.purpose };
  },
};
