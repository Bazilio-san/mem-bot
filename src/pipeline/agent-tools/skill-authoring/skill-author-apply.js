import { writeSkill, validateSkill } from '../../skills/writer.js';
import { authoringEnabled, getStaged, clearStaged, summarize } from '../../skills/authoring-support.js';

// Write the skill prepared in this conversation (created or edited) to disk, with confirmation.
// Makes a backup, reloads the registry, and creates the domain row. Destructive action: confirm=true.
export const skillAuthorApplyTool = {
  name: 'skill_author_apply',
  title: 'Применяю изменения навыка...',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_apply',
      description: `Write the skill prepared in this conversation (created or edited) to disk and hot-reload the
registry. Requires confirm=true. Use after showing the preview to the admin and getting approval.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'confirm'],
        properties: {
          name: {
            type: 'string',
            description: 'Skill name to apply.',
          },
          confirm: {
            type: 'boolean',
            description: 'Must be true to write.',
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    if (args.confirm !== true) {
      return { applied: false, error: 'Confirmation required: confirm=true.' };
    }
    const skill = getStaged(ctx, args.name);
    if (!skill) {
      return { applied: false, error: `No prepared draft for skill "${args.name}" in this conversation.` };
    }
    const { ok, issues } = await validateSkill(skill);
    if (!ok) {
      return { applied: false, issues, error: 'The skill failed validation; fix the issues and retry.' };
    }
    const res = await writeSkill(skill);
    clearStaged(ctx, args.name);
    return { applied: true, path: res.path, summary: summarize(skill) };
  },
};
