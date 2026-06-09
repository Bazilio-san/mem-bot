import { removeReference } from '../../skills/writer.js';
import { authoringEnabled } from '../../skills/authoring-support.js';

// Удалить файл справочника навыка (требует подтверждения).
export const skillAuthorRemoveReferenceTool = {
  name: 'skill_author_remove_reference',
  title: 'Удаление справочника навыка',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_remove_reference',
      description: 'Delete a reference file from a skill references folder. Requires confirm=true. The path must '
        + 'be relative inside references/** (no absolute paths or "..").',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'path', 'confirm'],
        properties: {
          name: { type: 'string' },
          path: { type: 'string' },
          confirm: { type: 'boolean' },
        },
      },
    },
  },
  async handler(ctx, args) {
    if (args.confirm !== true) return { removed: false, error: 'Нужно подтверждение confirm=true.' };
    return removeReference(args.name, args.path, { confirm: true });
  },
};
