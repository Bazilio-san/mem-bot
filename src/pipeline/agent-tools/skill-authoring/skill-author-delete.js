import { deleteSkill } from '../../skills/writer.js';
import { authoringEnabled } from '../../skills/authoring-support.js';

// Delete the entire skill directory (requires confirmation; general and skill-author are protected).
export const skillAuthorDeleteTool = {
  name: 'skill_author_delete',
  title: 'Удаляю навык...',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_delete',
      description: `Delete a skill directory entirely. Requires confirm=true. The general and skill-author
skills cannot be deleted.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'confirm'],
        properties: {
          name: {
            type: 'string',
          },
          confirm: {
            type: 'boolean',
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    if (args.confirm !== true) {
      return { removed: false, error: 'Confirmation required: confirm=true.' };
    }
    return deleteSkill(args.name, { confirm: true });
  },
};
