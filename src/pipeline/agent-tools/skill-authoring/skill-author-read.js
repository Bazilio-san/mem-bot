import { authoringEnabled, loadEditable, summarize } from '../../skills/authoring-support.js';

// Показать разобранный навык целиком или одну его часть. Нужно перед редактированием, чтобы модель правила
// то, что реально есть, а не угадывала.
export const skillAuthorReadTool = {
  name: 'skill_author_read',
  title: 'Чтение навыка',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_read',
      description: 'Read a parsed skill, fully or one part. Use to inspect current content before editing. '
        + 'part: "all" (default), "frontmatter", "skill_prompt", "fact_extraction_prompt", "domain_schema", '
        + '"references".',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Skill name (kebab-case).' },
          part: {
            type: 'string',
            enum: ['all', 'frontmatter', 'skill_prompt', 'fact_extraction_prompt', 'domain_schema', 'references'],
            description: 'Which part to return; defaults to "all".',
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    const s = loadEditable(args.name);
    switch (args.part) {
      case 'skill_prompt': return { skill_prompt: s.skillPrompt };
      case 'fact_extraction_prompt': return { fact_extraction_prompt: s.factExtractionPrompt };
      case 'domain_schema': return { domain_schema: s.definition };
      case 'references': return { references: s.references };
      case 'frontmatter':
        return {
          name: s.name, domain_key: s.domain_key, title: s.title, description: s.description,
          enabled: s.enabled, classification: s.classification, memory: s.memory, tools: s.tools,
          model: s.model, references: s.references,
        };
      default:
        return { summary: summarize(s), skill: s };
    }
  },
};
