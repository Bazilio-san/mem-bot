// Мета-схема определения домена и общая настройка валидатора JSON Schema (ajv).
//
// Здесь решаются две задачи. Во-первых, описывается форма самого объекта definition
// (того, что генерирует модель и правит человек), чтобы при сохранении нельзя было
// записать сломанную схему. Во-вторых, проверяется, что каждая data_schema внутри
// определения сама является валидной закрытой JSON Schema: с additionalProperties=false
// и непустым списком обязательных полей. Закрытость и делает data машиночитаемым.
import Ajv from 'ajv';

// Один общий экземпляр валидатора на процесс.
// strict отключён намеренно: на наших схемах встречаются объединения типов вида
// ["string", "null"], которые строгий режим ajv считает подозрительными, хотя они корректны.
export const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

// Допустимые режимы формирования entity_key. Только закрытые режимы: словарь синонимов или slug.
// Свободного режима нет — стабильный ключ обязателен для надёжной дедупликации.
export const ENTITY_KEY_MODES = ['fixed_vocab', 'slug'];

// Виды памяти, которые домен может объявить в allowed_memory_kinds.
// Совпадают с типом mem.memory_kind из migrations/001_init.sql.
export const MEMORY_KINDS = [
  'fact', 'preference', 'constraint', 'goal', 'history', 'state',
  'progress', 'instruction', 'relationship', 'reminder', 'secure_reference',
  'emotional_pattern', 'activity_rhythm', 'communication_style',
  'open_loop', 'topic_energy', 'discovery_seed',
];

// Мета-схема: какой должна быть форма объекта definition.
// Проверяет верхний уровень и форму каждой сущности; саму корректность data_schema
// как JSON Schema мы дополнительно проверяем кодом в validateDefinition (ajv.compile).
export const DEFINITION_META_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['domain_key', 'title', 'entities'],
  properties: {
    domain_key: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    description: { type: ['string', 'null'] },
    allowed_memory_kinds: {
      type: 'array',
      items: { type: 'string', enum: MEMORY_KINDS },
    },
    entities: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['entity_type', 'entity_key', 'data_schema'],
        properties: {
          entity_type: { type: 'string', minLength: 1 },
          description: { type: ['string', 'null'] },
          entity_key: {
            type: 'object',
            additionalProperties: false,
            required: ['mode'],
            properties: {
              mode: { type: 'string', enum: ENTITY_KEY_MODES },
              // Список канонических ключей для режима fixed_vocab.
              vocabulary: { type: 'array', items: { type: 'string' } },
              // Сопоставление «канонический ключ → список синонимов».
              synonyms: {
                type: 'object',
                additionalProperties: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          // Закрытая JSON Schema поля data. Корректность проверяется отдельно (см. validateDefinition).
          data_schema: { type: 'object' },
        },
      },
    },
  },
};

const validateMetaShape = ajv.compile(DEFINITION_META_SCHEMA);

// Проверить, что объект data_schema — закрытая схема: тип object, additionalProperties=false,
// непустой required, и сам по себе является валидной JSON Schema (компилируется в ajv).
function checkClosedDataSchema(dataSchema, entityType) {
  const issues = [];
  const prefix = `сущность «${entityType}»`;
  if (dataSchema.type !== 'object') {
    issues.push(`${prefix}: data_schema.type должен быть "object".`);
  }
  if (dataSchema.additionalProperties !== false) {
    issues.push(`${prefix}: data_schema должна быть закрытой (additionalProperties: false).`);
  }
  if (!Array.isArray(dataSchema.required) || dataSchema.required.length === 0) {
    issues.push(`${prefix}: data_schema.required не должен быть пустым (перечислите все поля).`);
  }
  if (!dataSchema.properties || typeof dataSchema.properties !== 'object') {
    issues.push(`${prefix}: data_schema.properties отсутствует или не является объектом.`);
  }
  // Сама схема должна компилироваться: иначе ей нельзя валидировать данные.
  try {
    ajv.compile(dataSchema);
  } catch (err) {
    issues.push(`${prefix}: data_schema не является валидной JSON Schema — ${err.message}`);
  }
  return issues;
}

// Проверить полное определение домена. Возвращает { ok, issues }.
// Сначала проверяется форма по мета-схеме, затем — закрытость каждой data_schema
// и согласованность режима entity_key (fixed_vocab обязан иметь непустой словарь).
export function validateDefinition(definition) {
  const issues = [];
  if (!validateMetaShape(definition)) {
    for (const e of validateMetaShape.errors || []) {
      issues.push(`Форма определения: ${e.instancePath || '/'} ${e.message}.`);
    }
    // Если базовая форма сломана, дальше проверять небезопасно.
    return { ok: false, issues };
  }

  for (const entity of definition.entities) {
    issues.push(...checkClosedDataSchema(entity.data_schema, entity.entity_type));

    const key = entity.entity_key;
    if (key.mode === 'fixed_vocab') {
      if (!Array.isArray(key.vocabulary) || key.vocabulary.length === 0) {
        issues.push(`сущность «${entity.entity_type}»: режим fixed_vocab требует непустой vocabulary.`);
      }
      // Синонимы, если заданы, должны указывать на ключи из словаря.
      for (const canonical of Object.keys(key.synonyms || {})) {
        if (Array.isArray(key.vocabulary) && !key.vocabulary.includes(canonical)) {
          issues.push(
            `сущность «${entity.entity_type}»: синоним привязан к «${canonical}», которого нет в vocabulary.`,
          );
        }
      }
    }
  }

  // Уникальность entity_type внутри домена.
  const types = definition.entities.map((e) => e.entity_type);
  const dupes = types.filter((t, i) => types.indexOf(t) !== i);
  if (dupes.length) {
    issues.push(`Повторяющиеся entity_type: ${[...new Set(dupes)].join(', ')}.`);
  }

  return { ok: issues.length === 0, issues };
}
