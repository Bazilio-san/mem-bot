import { writeReference } from '../../skills/writer.js';
import { authoringEnabled, editableOrStaged, applyOrStage } from '../../skills/authoring-support.js';

// Создать или обновить файл справочника навыка и включить чтение справочников. Содержимое пишет модель в content.
export const skillAuthorAddReferenceTool = {
  name: 'skill_author_add_reference',
  title: 'Добавление справочника навыка',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_add_reference',
      description: 'Create or update a reference file inside a skill references folder and enable references for '
        + 'the skill. Provide the file content directly. The path must be relative inside references/** (no '
        + 'absolute paths or ".."). The reference file is written immediately; references.allowed is set on the '
        + 'skill and persisted on apply.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'path', 'content'],
        properties: {
          name: { type: 'string', description: 'Skill name.' },
          path: { type: 'string', description: 'Relative path inside references/, e.g. "airlines.md".' },
          content: { type: 'string', description: 'Reference file content.' },
          apply: { type: ['boolean', 'null'] },
        },
      },
    },
  },
  async handler(ctx, args) {
    const written = await writeReference(args.name, args.path, args.content);
    const skill = editableOrStaged(ctx, args.name);
    skill.references.allowed = true;
    const res = await applyOrStage(ctx, skill, { apply: args.apply === true });
    return { ...res, reference_path: written.path };
  },
};
