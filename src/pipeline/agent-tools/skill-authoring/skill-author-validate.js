import { validateSkill } from '../../skills/writer.js';
import { authoringEnabled, editableOrStaged } from '../../skills/authoring-support.js';

// Validate a skill without writing: the draft prepared in this conversation, or the on-disk skill.
export const skillAuthorValidateTool = {
  name: 'skill_author_validate',
  title: 'Проверяю навык...',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_validate',
      description: `Validate a skill without writing it: checks frontmatter shape, required blocks, schema
meta-validation, that allowed tools exist, and domain_key uniqueness. Validates the draft prepared
in this conversation if any, otherwise the on-disk skill. Returns ok and a list of issues.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            description: 'Skill name to validate.',
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    const skill = editableOrStaged(ctx, args.name);
    const { ok, issues } = await validateSkill(skill);
    return { ok, issues };
  },
};
