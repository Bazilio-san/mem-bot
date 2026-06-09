import { getAllSkills } from '../../skills/registry.js';
import { authoringEnabled, summarize } from '../../skills/authoring-support.js';

// Перечислить все навыки с краткой сводкой: имя, домен, инструменты, наличие схемы и справочников.
export const skillAuthorListTool = {
  name: 'skill_author_list',
  title: 'Показываю навыки...',
  requiresAdmin: true,
  isEnabled: authoringEnabled,
  definition: {
    type: 'function',
    function: {
      name: 'skill_author_list',
      description: `List all skills with a short summary (name, domain, allowed tools, whether it has a memory
schema and references). Use before creating or editing to see what already exists.`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
  },
  async handler() {
    return { skills: getAllSkills().map(summarize) };
  },
};
