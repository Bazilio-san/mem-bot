// Слой генерации для инструментария редактирования навыков: модель под капотом создаёт и правит части
// навыка, а код проверяет результат мета-валидатором до записи. Чистые функции поверх chatJSON: ни одна не
// пишет на диск. Возвращаемые определения схемы домена всегда сопровождаются списком замечаний валидатора,
// чтобы вызывающий инструмент мог показать предпросмотр и при необходимости попросить модель исправиться.
import { chatJSON } from '../../llm.js';
import { config } from '../../config.js';
import { validateDefinition } from '../../schema/meta.js';

// Модель генерации: явно заданная в конфиге или основная модель агента (качество важнее скорости).
function authoringModel() {
  return config.skills.authoring.model || config.llm.mainModel;
}

// Требования к формату схемы домена, общие для всех генераторов. Встраиваются в системный промпт.
const SCHEMA_RULES = `Правила схемы домена:
- entities — массив сущностей; у каждой entity_type (строка), необязательное description, entity_key и data_schema.
- entity_key.mode — строго "fixed_vocab" или "slug". Для "fixed_vocab" задай непустой массив vocabulary и при
  необходимости synonyms (объект "канонический ключ → массив синонимов", ключи синонимов только из vocabulary).
- data_schema — ЗАКРЫТАЯ JSON Schema: "type":"object", "additionalProperties":false, непустой "required" со ВСЕМИ
  полями, конкретные типы (допустимы объединения вроде ["string","null"]) и при необходимости enum.
- Если у домена нет устойчивых предметных сущностей, верни entities: [].`;

// Описание одной сущности схемы для подсказки модели (поля data_schema свободные, поэтому тип общий).
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

// Собрать объект definition из частей и прогнать мета-валидатор. Возвращает { definition, issues }.
// Для пустого списка сущностей схемы нет — definition === null, issues пуст.
function buildDefinition({ domain_key, title, description, entities }) {
  if (!Array.isArray(entities) || entities.length === 0) {
    return { definition: null, issues: [] };
  }
  const definition = { domain_key, title, description: description ?? null, entities };
  const { ok, issues } = validateDefinition(definition);
  return { definition, issues: ok ? [] : issues };
}

// Сгенерировать черновик целого навыка по описанию на естественном языке.
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

// Переписать или улучшить prompt-блок навыка по инструкции. kind: 'skill_prompt' | 'fact_extraction_prompt'.
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

// Сгенерировать определение схемы домена (сущности, закрытые data_schema, словари ключей).
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

// Точечно поправить существующее определение схемы по инструкции. Возвращает новое определение и описание правки.
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
