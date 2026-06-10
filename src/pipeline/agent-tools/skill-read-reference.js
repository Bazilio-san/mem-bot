import { getReference } from '../skills/registry.js';

// Reads a reference file of the active skill from its references/** directory. This enables progressive
// disclosure: the router sees a short description, the main prompt gets a compact "# Skill Prompt", and the
// heavy material is read only when explicitly needed. The tool is available only when a skill with
// references.allowed is active, accepts a relative path inside references/**, and cannot escape the current
// skill's directory.
export const skillReadReferenceTool = {
  name: 'skill_read_reference',
  title: 'Читаю справочник навыка...',
  isEnabled: (ctx) => ctx.activeSkill?.references?.allowed === true,
  definition: {
    type: 'function',
    function: {
      name: 'skill_read_reference',
      description: `Read a reference document that belongs to the currently active skill. 
Use this only when the task needs detailed domain material that is not already in your instructions. 
Pass a relative path inside the skill references folder (for example "airlines.md"). 
Absolute paths and parent traversal are rejected.`,
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
    if (!skillName) {
      return { error: 'Активный skill не определён.' };
    }
    const content = getReference(skillName, args.path);
    return { path: args.path, content };
  },
};
