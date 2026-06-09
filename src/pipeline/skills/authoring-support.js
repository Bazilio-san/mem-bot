// Общие помощники инструментов редактирования навыков: единый предикат доступа, промежуточное хранилище
// подготовленных черновиков (предпросмотр → применение) и преобразования формы навыка. Лежит вне каталога
// agent-tools намеренно: там действует правило «один инструмент — один файл», а это вспомогательный модуль.
import { getSkill } from './registry.js';

// Доступ: только администратор и только при включённом флаге инструментария.
export const authoringEnabled = (ctx, config) => config.skills.authoring.enabled && ctx.isAdmin === true;

// Промежуточное хранилище подготовленных навыков на время диалога. Ключ — диалог и имя навыка.
// Порождающие инструменты кладут сюда результат и возвращают предпросмотр; apply берёт отсюда и пишет на диск.
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

// Собрать объект навыка (форма как у реестра) из черновика генератора.
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
    definition: draft.definition || null,
  };
}

// Загрузить навык для редактирования: глубокая копия редактируемых полей (без вычисляемых dir и т. п.).
export function loadEditable(name) {
  const s = getSkill(name);
  if (!s) throw new Error(`Навык «${name}» не найден.`);
  return JSON.parse(JSON.stringify({
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
    definition: s.definition,
  }));
}

// Взять навык для редактирования: сначала подготовленный в этом диалоге, иначе с диска.
export function editableOrStaged(ctx, name) {
  return getStaged(ctx, name) || loadEditable(name);
}

// Применить или подготовить изменённый навык. При apply=true валидирует и пишет на диск; иначе кладёт в
// промежуточное хранилище и возвращает предпросмотр с замечаниями (запись — отдельным skill_author_apply).
export async function applyOrStage(ctx, skill, { apply } = {}) {
  const { validateSkill, writeSkill } = await import('./writer.js');
  const { ok, issues } = await validateSkill(skill);
  stageSkill(ctx, skill);
  if (apply === true) {
    if (!ok) return { applied: false, issues, error: 'Навык не прошёл валидацию; исправьте и повторите.' };
    const res = await writeSkill(skill);
    clearStaged(ctx, skill.name);
    return { applied: true, path: res.path, summary: summarize(skill) };
  }
  return { applied: false, ok, issues, summary: summarize(skill),
    next: 'Покажите изменение админу и вызовите skill_author_apply с confirm=true.' };
}

// Краткая сводка навыка для ответов инструментов.
export function summarize(skill) {
  return {
    name: skill.name,
    domain_key: skill.domain_key,
    title: skill.title,
    enabled: skill.enabled !== false,
    tools_allowed: skill.tools?.allowed || [],
    references_allowed: skill.references?.allowed === true,
    has_schema: !!skill.definition,
    entities: skill.definition ? skill.definition.entities.map((e) => e.entity_type) : [],
  };
}
