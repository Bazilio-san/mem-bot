import { writeSkill, validateSkill } from '../../skills/writer.js';
import { authoringEnabled, getStaged, clearStaged, summarize } from '../../skills/authoring-support.js';

// Записать на диск навык, подготовленный в этом диалоге (созданный или отредактированный), с подтверждением.
// Делает резервную копию, перезагружает реестр и заводит строку домена. Разрушающее действие: confirm=true.
export const skillAuthorApplyTool = {
  name: 'skill_author_apply',
  title: 'Применяю изменения навыка...',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_apply',
      description:
        'Write the skill prepared in this conversation (created or edited) to disk and hot-reload the ' +
        'registry. Requires confirm=true. Use after showing the preview to the admin and getting approval.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'confirm'],
        properties: {
          name: { type: 'string', description: 'Skill name to apply.' },
          confirm: { type: 'boolean', description: 'Must be true to write.' },
        },
      },
    },
  },
  async handler(ctx, args) {
    if (args.confirm !== true) {
      return { applied: false, error: 'Нужно подтверждение confirm=true.' };
    }
    const skill = getStaged(ctx, args.name);
    if (!skill) {
      return { applied: false, error: `Нет подготовленного черновика навыка «${args.name}» в этом диалоге.` };
    }
    const { ok, issues } = await validateSkill(skill);
    if (!ok) {
      return { applied: false, issues, error: 'Навык не прошёл валидацию; исправьте и повторите.' };
    }
    const res = await writeSkill(skill);
    clearStaged(ctx, args.name);
    return { applied: true, path: res.path, summary: summarize(skill) };
  },
};
