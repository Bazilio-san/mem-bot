import { refineBlock } from '../../skills/author.js';
import { authoringEnabled, editableOrStaged, applyOrStage } from '../../skills/authoring-support.js';

// Переписать или улучшить блок «## Fact Extraction Prompt» навыка по инструкции (под капотом — модель).
export const skillAuthorWriteExtractionTool = {
  name: 'skill_author_write_extraction',
  title: 'Правлю промпт извлечения навыка...',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_write_extraction',
      description: 'Rewrite or improve the fact-extraction prompt (the "## Fact Extraction Prompt" block) '
        + 'following an instruction. Use to change WHICH durable facts the skill remembers. Returns a preview '
        + 'unless apply=true.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'instruction'],
        properties: {
          name: { type: 'string' },
          instruction: { type: 'string', description: 'How to change the fact-extraction prompt.' },
          apply: { type: ['boolean', 'null'] },
        },
      },
    },
  },
  async handler(ctx, args) {
    const skill = editableOrStaged(ctx, args.name);
    const { text } = await refineBlock({
      kind: 'fact_extraction_prompt', current: skill.factExtractionPrompt, instruction: args.instruction,
      skillContext: { name: skill.name, domain_key: skill.domain_key, title: skill.title, description: skill.description },
    });
    skill.factExtractionPrompt = text;
    const res = await applyOrStage(ctx, skill, { apply: args.apply === true });
    return { ...res, fact_extraction_prompt: text };
  },
};
