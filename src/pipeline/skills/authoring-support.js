// Shared helpers for the skill-editing tools: a single access predicate, a staging store for prepared drafts
// (preview → apply), and skill-shape transformations. Deliberately placed outside the agent-tools directory:
// there the "one tool — one file" rule applies, whereas this is a helper module.
import { getSkill } from './registry.js';

// Access: admin only, and only when the toolkit flag is enabled.
export const authoringEnabled = (ctx, config) => config.skills.authoring.enabled && ctx.isAdmin === true;

// Staging store for prepared skills for the duration of a dialog. Key is the dialog plus the skill name.
// Generating tools put the result here and return a preview; apply takes it from here and writes to disk.
const staging = new Map();
const key = (ctx, name) => `${ctx.conversationId}::${name}`;

export function stageSkill(ctx, skill) {
  staging.set(key(ctx, skill.name), skill);
}
export function getStaged(ctx, name) {
  return staging.get(key(ctx, name)) || null;
}
export function clearStaged(ctx, name) {
  staging.delete(key(ctx, name));
}

// Build a skill object (registry shape) from a generator draft.
export function buildSkillFromDraft(draft) {
  return {
    name: draft.name,
    domain_key: draft.domain_key,
    title: draft.title,
    description: draft.description,
    enabled: true,
    classification: {
      when_to_use: draft.when_to_use,
      positive_signals: draft.positive_signals || [],
      negative_signals: draft.negative_signals || [],
    },
    memory: { scopes: ['profile', 'domain', 'dialog'] },
    tools: { allowed: [], base: true },
    model: { main: null, extract: null },
    references: { allowed: false },
    skillPrompt: draft.skill_prompt,
    factExtractionPrompt: draft.fact_extraction_prompt,
  };
}

// Load a skill for editing: deep copy of the editable fields (without computed dir, etc.).
export function loadEditable(name) {
  const s = getSkill(name);
  if (!s) {
    throw new Error(`Skill «${name}» not found.`);
  }
  return JSON.parse(
    JSON.stringify({
      name: s.name,
      domain_key: s.domain_key,
      title: s.title,
      description: s.description,
      enabled: s.enabled,
      classification: s.classification,
      memory: s.memory,
      tools: s.tools,
      model: s.model,
      references: s.references,
      skillPrompt: s.skillPrompt,
      factExtractionPrompt: s.factExtractionPrompt,
    }),
  );
}

// Take a skill for editing: first the one staged in this dialog, otherwise from disk.
export function editableOrStaged(ctx, name) {
  return getStaged(ctx, name) || loadEditable(name);
}

// Apply or stage the changed skill. With apply=true it validates and writes to disk; otherwise it puts it into
// the staging store and returns a preview with issues (the actual write goes through a separate skill_author_apply).
export async function applyOrStage(ctx, skill, { apply } = {}) {
  const { validateSkill, writeSkill } = await import('./writer.js');
  const { ok, issues } = await validateSkill(skill);
  stageSkill(ctx, skill);
  if (apply === true) {
    if (!ok) {
      return { applied: false, issues, error: 'Навык не прошёл валидацию; исправьте и повторите.' };
    }
    const res = await writeSkill(skill);
    clearStaged(ctx, skill.name);
    return { applied: true, path: res.path, summary: summarize(skill) };
  }
  return {
    applied: false,
    ok,
    issues,
    summary: summarize(skill),
    next: 'Покажите изменение админу и вызовите skill_author_apply с confirm=true.',
  };
}

// Brief skill summary for tool responses.
export function summarize(skill) {
  return {
    name: skill.name,
    domain_key: skill.domain_key,
    title: skill.title,
    enabled: skill.enabled !== false,
    tools_allowed: skill.tools?.allowed || [],
    references_allowed: skill.references?.allowed === true,
  };
}
