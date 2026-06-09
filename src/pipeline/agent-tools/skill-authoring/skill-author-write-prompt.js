import { refineBlock } from '../../skills/author.js';
import { authoringEnabled, editableOrStaged, applyOrStage } from '../../skills/authoring-support.js';

// Переписать или улучшить блок «# Skill Prompt» навыка по инструкции (под капотом — модель).
export const skillAuthorWritePromptTool = {
  name: 'skill_author_write_prompt',
  title: 'Правка промпта ответа навыка',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_write_prompt',
      description: 'Rewrite or improve the skill response prompt (the "# Skill Prompt" block) following an '
        + 'instruction. Use to change HOW the bot answers in this domain, not what it remembers. Returns a '
        + 'preview unless apply=true.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'instruction'],
        properties: {
          name: { type: 'string' },
          instruction: { type: 'string', description: 'How to change the response prompt.' },
          apply: { type: ['boolean', 'null'] },
        },
      },
    },
  },
  async handler(ctx, args) {
    const skill = editableOrStaged(ctx, args.name);
    const { text } = await refineBlock({
      kind: 'skill_prompt', current: skill.skillPrompt, instruction: args.instruction,
      skillContext: { name: skill.name, domain_key: skill.domain_key, title: skill.title, description: skill.description },
    });
    skill.skillPrompt = text;
    const res = await applyOrStage(ctx, skill, { apply: args.apply === true });
    return { ...res, skill_prompt: text };
  },
};
