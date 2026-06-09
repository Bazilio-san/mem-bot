import { proposeSchemaEdit } from '../../skills/author.js';
import { authoringEnabled, editableOrStaged, applyOrStage } from '../../skills/authoring-support.js';

// Точечно поправить схему домена навыка: добавить/убрать сущность, поле, значение словаря, синоним, режим ключа.
export const skillAuthorSchemaEditTool = {
  name: 'skill_author_schema_edit',
  title: 'Правлю схему навыка...',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_schema_edit',
      description: `Edit the existing domain memory schema by instruction: add or remove an entity, a data field,
a vocabulary value, a synonym, or change the entity_key mode. Use for targeted schema changes; to
create a schema from scratch use skill_author_schema_generate. Returns a preview and validation issues
unless apply=true.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'instruction'],
        properties: {
          name: {
            type: 'string',
          },
          instruction: {
            type: 'string',
            description: 'What to change in the schema.',
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
    if (!skill.definition) {
      return { error: 'У навыка нет схемы. Сначала создайте её через skill_author_schema_generate.' };
    }
    const { definition, summary, issues } = await proposeSchemaEdit({
      definition: skill.definition,
      instruction: args.instruction,
    });
    skill.definition = definition;
    const res = await applyOrStage(ctx, skill, { apply: args.apply === true });
    return {
      ...res,
      summary,
      schema_issues: issues,
      entities: definition ? definition.entities.map((e) => e.entity_type) : [],
    };
  },
};
