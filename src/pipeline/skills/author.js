// Generation layer for the skill-editing toolkit: the model creates and edits parts of a skill under the hood,
// and the code checks the result with the meta-validator before writing. Pure functions on top of chatJSON: none
// of them write to disk. Returned domain schema definitions always come with a list of validator issues, so the
// calling tool can show a preview and, if needed, ask the model to fix things.
import { chatJSON } from '../../llm.js';
import { config } from '../../config.js';
import { validateDefinition } from '../../schema/meta.js';

// Generation model: explicitly set in config, or the agent's main model (quality matters more than speed).
function authoringModel() {
  return config.skills.authoring.model || config.llm.mainModel;
}

// Domain schema format requirements, shared across all generators. Embedded into the system prompt.
const SCHEMA_RULES = `Правила схемы домена:
- entities — массив сущностей; у каждой entity_type (строка), необязательное description, entity_key и data_schema.
- entity_key.mode — строго "fixed_vocab" или "slug". Для "fixed_vocab" задай непустой массив vocabulary и при
  необходимости synonyms (объект "канонический ключ → массив синонимов", ключи синонимов только из vocabulary).
- data_schema — ЗАКРЫТАЯ JSON Schema: "type":"object", "additionalProperties":false, непустой "required" со ВСЕМИ
  полями, конкретные типы (допустимы объединения вроде ["string","null"]) и при необходимости enum.
- Если у домена нет устойчивых предметных сущностей, верни entities: [].`;

// Description of one schema entity for the model hint (data_schema fields are free-form, so the type is generic).
const ENTITY_SHAPE = {
  type: 'object',
  required: ['entity_type', 'entity_key', 'data_schema'],
  properties: {
    entity_type: { type: 'string' },
    description: { type: ['string', 'null'] },
    entity_key: {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['fixed_vocab', 'slug'] },
        vocabulary: { type: 'array', items: { type: 'string' } },
        synonyms: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
      },
    },
    data_schema: { type: 'object' },
  },
};

// Assemble the definition object from parts and run the meta-validator. Returns { definition, issues }.
// For an empty entity list there is no schema — definition === null, issues is empty.
function buildDefinition({ domain_key, title, description, entities }) {
  if (!Array.isArray(entities) || entities.length === 0) {
    return { definition: null, issues: [] };
  }
  const definition = { domain_key, title, description: description ?? null, entities };
  const { ok, issues } = validateDefinition(definition);
  return { definition, issues: ok ? [] : issues };
}

// Generate a draft of a whole skill from a natural-language description.
export async function generateSkillDraft({ skillDescription, hints = '' }) {
  const schema = {
    type: 'object',
    required: [
      'name',
      'domain_key',
      'title',
      'description',
      'when_to_use',
      'positive_signals',
      'negative_signals',
      'skill_prompt',
      'fact_extraction_prompt',
      'entities',
    ],
    properties: {
      name: {
        type: 'string',
      },
      domain_key: {
        type: 'string',
      },
      title: {
        type: 'string',
      },
      description: {
        type: 'string',
      },
      when_to_use: {
        type: 'string',
      },
      positive_signals: {
        type: 'array',
        items: { type: 'string' },
      },
      negative_signals: {
        type: 'array',
        items: { type: 'string' },
      },
      skill_prompt: {
        type: 'string',
      },
      fact_extraction_prompt: {
        type: 'string',
      },
      entities: {
        type: 'array',
        items: ENTITY_SHAPE,
      },
    },
  };
  const system = `Ты конструктор навыков (skills) для агентского приложения с памятью. По описанию области собери навык.
name — короткий kebab-case (латиница, дефисы), domain_key — короткий snake_case (латиница, подчёркивания).
when_to_use — смысловое правило, когда роутер выбирает этот навык. positive_signals/negative_signals — короткие
подсказки. skill_prompt — инструкции основного ответа в этом домене. fact_extraction_prompt — какие устойчивые
факты сохранять. ${SCHEMA_RULES}
Верни только JSON по схеме.`;
  const draft = await chatJSON({
    model: authoringModel(),
    kind: 'skill_authoring',
    schema,
    schemaName: 'skill_draft',
    system,
    user: `Описание навыка: ${skillDescription}\n${hints ? `Дополнительно: ${hints}` : ''}`,
  });
  const { definition, issues } = buildDefinition({
    domain_key: draft.domain_key,
    title: draft.title,
    description: draft.description,
    entities: draft.entities,
  });
  return {
    name: draft.name,
    domain_key: draft.domain_key,
    title: draft.title,
    description: draft.description,
    when_to_use: draft.when_to_use,
    positive_signals: draft.positive_signals || [],
    negative_signals: draft.negative_signals || [],
    skill_prompt: draft.skill_prompt,
    fact_extraction_prompt: draft.fact_extraction_prompt,
    definition,
    issues,
  };
}

// Rewrite or improve a skill prompt block per the instruction. kind: 'skill_prompt' | 'fact_extraction_prompt'.
export async function refineBlock({ kind, current, instruction, skillContext = {} }) {
  const what =
    kind === 'fact_extraction_prompt'
      ? 'блок «## Fact Extraction Prompt» (какие устойчивые факты сохранять в этом домене)'
      : 'блок «# Skill Prompt» (инструкции основного ответа в этом домене)';
  const schema = { type: 'object', required: ['text'], properties: { text: { type: 'string' } } };
  const system = `Ты редактор навыков (skills). Перепиши ${what} по инструкции, сохранив суть и оставаясь в рамках
домена. Верни только новый текст блока в поле text, без заголовка раздела и без markdown-обёртки. Только JSON по схеме.`;
  const ctx = `Навык: ${skillContext.name || '—'} / домен ${skillContext.domain_key || '—'}
Название: ${skillContext.title || '—'}; описание: ${skillContext.description || '—'}`;
  const res = await chatJSON({
    model: authoringModel(),
    kind: 'skill_authoring',
    schema,
    schemaName: 'skill_block',
    system,
    user: `${ctx}\n\nТекущий текст блока:\n${current || '(пусто)'}\n\nИнструкция: ${instruction}`,
  });
  return { text: res.text };
}

// Generate a domain schema definition (entities, closed data_schema, key vocabularies).
export async function generateDomainSchema({ domain_key, title, description = '', samples = [] }) {
  const schema = {
    type: 'object',
    required: ['entities'],
    properties: { entities: { type: 'array', items: ENTITY_SHAPE } },
  };
  const system = `Ты конструктор схемы доменной памяти. Предложи сущности и закрытые схемы их полей data.
${SCHEMA_RULES}
Верни только JSON по схеме.`;
  const user = `Домен: ${domain_key} (${title}). ${description}
${samples.length ? `Примеры реплик пользователя:\n- ${samples.join('\n- ')}` : ''}`;
  const res = await chatJSON({
    model: authoringModel(),
    kind: 'skill_authoring',
    schema,
    schemaName: 'domain_schema',
    system,
    user,
  });
  return buildDefinition({ domain_key, title, description, entities: res.entities });
}

// Make a targeted edit to an existing schema definition per the instruction. Returns the new definition and an edit summary.
export async function proposeSchemaEdit({ definition, instruction }) {
  const schema = {
    type: 'object',
    required: ['entities', 'summary'],
    properties: { entities: { type: 'array', items: ENTITY_SHAPE }, summary: { type: 'string' } },
  };
  const system = `Ты редактор схемы доменной памяти. Применй инструкцию к текущему определению: можно добавить или
убрать сущность, поле, значение vocabulary, синоним, поменять режим entity_key. Сохрани неизменными части, которых
инструкция не касается. ${SCHEMA_RULES}
summary — краткое описание внесённой правки на русском. Верни только JSON по схеме.`;
  const user = `Текущее определение:\n${JSON.stringify(definition, null, 2)}\n\nИнструкция: ${instruction}`;
  const res = await chatJSON({
    model: authoringModel(),
    kind: 'skill_authoring',
    schema,
    schemaName: 'domain_schema_edit',
    system,
    user,
  });
  const built = buildDefinition({
    domain_key: definition.domain_key,
    title: definition.title,
    description: definition.description,
    entities: res.entities,
  });
  return { definition: built.definition, summary: res.summary, issues: built.issues };
}
