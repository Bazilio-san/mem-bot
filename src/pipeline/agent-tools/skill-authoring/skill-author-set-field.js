import { authoringEnabled, editableOrStaged, applyOrStage } from '../../skills/authoring-support.js';

// Изменить машинное поле фронтматтера навыка прямым значением.
const FIELDS = ['title', 'description', 'enabled', 'when_to_use', 'positive_signals', 'negative_signals',
  'tools_allowed', 'tools_base', 'model_main', 'model_extract', 'references_allowed'];

function setField(skill, field, value) {
  switch (field) {
    case 'title': skill.title = String(value); break;
    case 'description': skill.description = String(value); break;
    case 'enabled': skill.enabled = value === true || value === 'true'; break;
    case 'when_to_use': skill.classification.when_to_use = String(value); break;
    case 'positive_signals': skill.classification.positive_signals = toArray(value); break;
    case 'negative_signals': skill.classification.negative_signals = toArray(value); break;
    case 'tools_allowed': skill.tools.allowed = toArray(value); break;
    case 'tools_base': skill.tools.base = value === true || value === 'true'; break;
    case 'model_main': skill.model.main = value || null; break;
    case 'model_extract': skill.model.extract = value || null; break;
    case 'references_allowed': skill.references.allowed = value === true || value === 'true'; break;
    default: throw new Error(`Неизвестное поле: ${field}`);
  }
}

function toArray(v) {
  if (Array.isArray(v)) return v.map(String);
  if (v == null || v === '') return [];
  return [String(v)];
}

export const skillAuthorSetFieldTool = {
  name: 'skill_author_set_field',
  title: 'Изменяю поле навыка...',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_set_field',
      description: 'Set a frontmatter field of a skill to a direct value. Use for non-text settings and lists: '
        + 'title, description, enabled, when_to_use, positive_signals, negative_signals, tools_allowed, '
        + 'tools_base, model_main, model_extract, references_allowed. For prompt wording use '
        + 'skill_author_write_prompt; for the memory schema use the schema tools. Returns a preview unless apply=true.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'field', 'value'],
        properties: {
          name: { type: 'string' },
          field: { type: 'string', enum: FIELDS },
          value: { description: 'New value: string, boolean, or array of strings depending on the field.' },
          apply: { type: ['boolean', 'null'], description: 'Write to disk when true; otherwise preview only.' },
        },
      },
    },
  },
  async handler(ctx, args) {
    const skill = editableOrStaged(ctx, args.name);
    setField(skill, args.field, args.value);
    return applyOrStage(ctx, skill, { apply: args.apply === true });
  },
};
