import { loadSkills, invalidateSkillsCache, getAllSkills } from '../../skills/registry.js';
import { authoringEnabled } from '../../skills/authoring-support.js';

// Перечитать реестр навыков с диска (после правок файлов вне бота).
export const skillAuthorReloadTool = {
  name: 'skill_author_reload',
  title: 'Перезагружаю реестр навыков...',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_reload',
      description: 'Reload the skills registry from disk. Use after files were edited outside the bot.',
      parameters: {
        type: 'object',
        additionalProperties: false, properties: {},
      },
    },
  },
  async handler () {
    invalidateSkillsCache();
    loadSkills({ force: true });
    return { reloaded: true, skills: getAllSkills().map((s) => s.name) };
  },
};
