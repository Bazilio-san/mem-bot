import { getReference } from '../skills/registry.js';

// Чтение справочного файла активного skill из его каталога references/**. Это даёт прогрессивное раскрытие:
// роутер видит короткое описание, основной prompt — компактный «# Skill Prompt», а тяжёлые материалы
// читаются только по явной необходимости. Инструмент доступен лишь при активном skill с references.allowed,
// принимает относительный путь внутри references/** и не может выйти за пределы каталога текущего skill.
export const skillReadReferenceTool = {
  name: 'skill_read_reference',
  title: 'Чтение справочника навыка',
  isEnabled: (ctx) => ctx.activeSkill?.references?.allowed === true,
  definition: {
    type: 'function',
    function: {
      name: 'skill_read_reference',
      description: 'Read a reference document that belongs to the currently active skill. Use this only when the '
        + 'task needs detailed domain material that is not already in your instructions. Pass a relative path '
        + 'inside the skill references folder (for example "airlines.md"). Absolute paths and parent traversal '
        + 'are rejected.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: {
            type: 'string',
            description: 'Relative path to a reference file inside the active skill references folder.',
          },
        },
      },
    },
  },
  async handler(ctx, args) {
    const skillName = ctx.activeSkill?.name || ctx.skillName;
    if (!skillName) return { error: 'Активный skill не определён.' };
    const content = getReference(skillName, args.path);
    return { path: args.path, content };
  },
};
