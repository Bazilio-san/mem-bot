import { generateDomainSchema } from '../../skills/author.js';
import { authoringEnabled, editableOrStaged, applyOrStage } from '../../skills/authoring-support.js';

// Сгенерировать (или пересоздать) закрытую схему доменной памяти навыка: сущности, поля data, словари ключей.
export const skillAuthorSchemaGenerateTool = {
  name: 'skill_author_schema_generate',
  title: 'Генерирую схему навыка...',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_schema_generate',
      description: `Generate (or regenerate) the closed domain memory schema of a skill: entities, their data
fields and entity_key rules. Use to give a skill a structured memory from scratch. For small edits to
an existing schema use skill_author_schema_edit. Returns a preview and validation issues unless apply=true.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: {
            type: 'string',
          },
          instruction: {
            type: ['string', 'null'],
            description: 'Optional guidance on what to model.',
          },
          samples: {
            type: ['array', 'null'],
            items: {
              type: 'string',
            },
            description: 'Optional example user phrases.',
          },
          apply: {
            type: ['boolean', 'null'],
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    const skill = editableOrStaged(ctx, args.name);
    const { definition, issues } = await generateDomainSchema({
      domain_key: skill.domain_key,
      title: skill.title,
      description: `${skill.description || ''} ${args.instruction || ''}`.trim(),
      samples: Array.isArray(args.samples) ? args.samples : [],
    });
    skill.definition = definition;
    const res = await applyOrStage(ctx, skill, { apply: args.apply === true });
    return { ...res, schema_issues: issues, entities: definition ? definition.entities.map((e) => e.entity_type) : [] };
  },
};
