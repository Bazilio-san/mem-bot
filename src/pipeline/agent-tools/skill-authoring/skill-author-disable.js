import { writeSkill } from '../../skills/writer.js';
import { authoringEnabled, loadEditable, summarize } from '../../skills/authoring-support.js';

// Disable a skill (enabled=false): the router stops selecting it, but the skill is not deleted. Writes immediately.
export const skillAuthorDisableTool = {
  name: 'skill_author_disable',
  title: 'Выключаю навык...',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_disable',
      description: `Disable a skill (set enabled=false) so the router stops selecting it, without deleting it.
Writes immediately.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: {
            type: 'string',
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    const skill = loadEditable(args.name);
    skill.enabled = false;
    await writeSkill(skill);
    return { name: args.name, enabled: false, summary: summarize(skill) };
  },
};
