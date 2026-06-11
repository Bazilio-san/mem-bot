import { generateSkillDraft } from '../../skills/author.js';
import { writeSkill, validateSkill } from '../../skills/writer.js';
import { getSkill } from '../../skills/registry.js';
import {
  authoringEnabled,
  buildSkillFromDraft,
  stageSkill,
  clearStaged,
  summarize,
} from '../../skills/authoring-support.js';

// Create a new skill from a natural-language description. Under the hood it drafts a whole skill,
// validates it, and by default only shows a preview; it writes to disk only when apply=true.
export const skillAuthorCreateTool = {
  name: 'skill_author_create',
  title: 'Создаю навык...',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_create',
      description: `Create a NEW skill from a natural-language description: the model drafts name, domain_key,
classification and prompts. By default returns a preview and validation issues without writing.
Set apply=true to write it to disk and hot-reload the registry.
Use for a brand-new domain, not for editing an existing skill.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['skillDescription'],
        properties: {
          skillDescription: {
            type: 'string',
            description: 'What the skill is for, in natural language.',
          },
          hints: {
            type: ['string', 'null'],
            description: 'Optional extra constraints or preferences.',
          },
          apply: {
            type: ['boolean', 'null'],
            description: 'Write to disk when true; otherwise preview only.',
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    const draft = await generateSkillDraft({ skillDescription: args.skillDescription, hints: args.hints || '' });
    const skill = buildSkillFromDraft(draft);

    if (getSkill(skill.name)) {
      return {
        error: `A skill named "${skill.name}" already exists. Use the editing tools or a different name.`,
      };
    }

    const { ok, issues } = await validateSkill(skill);
    stageSkill(ctx, skill);

    const preview = {
      summary: summarize(skill),
      when_to_use: skill.classification.when_to_use,
      skill_prompt: skill.skillPrompt,
      fact_extraction_prompt: skill.factExtractionPrompt,
    };

    if (args.apply === true) {
      if (!ok) {
        return { applied: false, issues, preview, error: 'The skill failed validation; fix the issues and retry.' };
      }
      const res = await writeSkill(skill);
      clearStaged(ctx, skill.name);
      return { applied: true, path: res.path, summary: summarize(skill) };
    }
    return {
      applied: false,
      ok,
      issues,
      preview,
      next: 'Show the preview to the admin and call skill_author_apply with confirm=true.',
    };
  },
};
