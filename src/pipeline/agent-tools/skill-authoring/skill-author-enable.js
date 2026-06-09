import { writeSkill } from '../../skills/writer.js';
import { authoringEnabled, loadEditable, summarize } from '../../skills/authoring-support.js';

// Включить навык (enabled=true), чтобы роутер мог его выбирать. Пишет сразу.
export const skillAuthorEnableTool = {
  name: 'skill_author_enable',
  title: 'Включаю навык...',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_enable',
      description: 'Enable a skill (set enabled=true) so the router can select it. Writes immediately.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
    },
  },
  async handler(ctx, args) {
    const skill = loadEditable(args.name);
    skill.enabled = true;
    await writeSkill(skill);
    return { name: args.name, enabled: true, summary: summarize(skill) };
  },
};
