// Domain definition meta-schema and the shared setup of the JSON Schema validator (ajv).
//
// Two things are solved here. First, the shape of the definition object itself is described
// (the one the model generates and a human edits), so that a broken schema cannot be saved.
// Second, it is verified that each data_schema inside the definition is itself a valid closed
// JSON Schema: with additionalProperties=false and a non-empty list of required fields.
// Being closed is what makes data machine-readable.
import Ajv from 'ajv';

// A single shared validator instance per process.
// strict is disabled intentionally: our schemas contain type unions like
// ["string", "null"], which ajv's strict mode considers suspicious even though they are correct.
export const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });

// Allowed modes for forming entity_key. Only closed modes: a synonym dictionary or a slug.
// There is no free-form mode — a stable key is required for reliable deduplication.
export const ENTITY_KEY_MODES = ['fixed_vocab', 'slug'];

// Memory kinds a domain may declare in allowed_memory_kinds.
// They match the mem.memory_kind type from migrations/001_init.sql.
export const MEMORY_KINDS = [
  'fact',
  'preference',
  'constraint',
  'goal',
  'history',
  'state',
  'progress',
  'instruction',
  'relationship',
  'reminder',
  'secure_reference',
  'emotional_pattern',
  'activity_rhythm',
  'communication_style',
  'open_loop',
  'topic_energy',
  'discovery_seed',
];

// Meta-schema: what the shape of the definition object must be.
// Checks the top level and the shape of each entity; the correctness of data_schema itself
// as a JSON Schema is additionally checked in code in validateDefinition (ajv.compile).
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
              // List of canonical keys for the fixed_vocab mode.
              vocabulary: { type: 'array', items: { type: 'string' } },
              // Mapping "canonical key -> list of synonyms".
              synonyms: {
                type: 'object',
                additionalProperties: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          // Closed JSON Schema of the data field. Correctness is checked separately (see validateDefinition).
          data_schema: { type: 'object' },
        },
      },
    },
  },
};

const validateMetaShape = ajv.compile(DEFINITION_META_SCHEMA);

// Check that the data_schema object is a closed schema: type object, additionalProperties=false,
// non-empty required, and is itself a valid JSON Schema (compiles in ajv).
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
  // The schema itself must compile: otherwise it cannot be used to validate data.
  try {
    ajv.compile(dataSchema);
  } catch (err) {
    issues.push(`${prefix}: data_schema не является валидной JSON Schema — ${err.message}`);
  }
  return issues;
}

// Validate a full domain definition. Returns { ok, issues }.
// First the shape is checked against the meta-schema, then the closedness of each data_schema
// and the consistency of the entity_key mode (fixed_vocab must have a non-empty dictionary).
export function validateDefinition(definition) {
  const issues = [];
  if (!validateMetaShape(definition)) {
    for (const e of validateMetaShape.errors || []) {
      issues.push(`Форма определения: ${e.instancePath || '/'} ${e.message}.`);
    }
    // If the basic shape is broken, it's unsafe to check further.
    return { ok: false, issues };
  }

  for (const entity of definition.entities) {
    issues.push(...checkClosedDataSchema(entity.data_schema, entity.entity_type));

    const key = entity.entity_key;
    if (key.mode === 'fixed_vocab') {
      if (!Array.isArray(key.vocabulary) || key.vocabulary.length === 0) {
        issues.push(`сущность «${entity.entity_type}»: режим fixed_vocab требует непустой vocabulary.`);
      }
      // Synonyms, if provided, must point to keys from the dictionary.
      for (const canonical of Object.keys(key.synonyms || {})) {
        if (Array.isArray(key.vocabulary) && !key.vocabulary.includes(canonical)) {
          issues.push(
            `сущность «${entity.entity_type}»: синоним привязан к «${canonical}», которого нет в vocabulary.`,
          );
        }
      }
    }
  }

  // Uniqueness of entity_type within the domain.
  const types = definition.entities.map((e) => e.entity_type);
  const dupes = types.filter((t, i) => types.indexOf(t) !== i);
  if (dupes.length) {
    issues.push(`Повторяющиеся entity_type: ${[...new Set(dupes)].join(', ')}.`);
  }

  return { ok: issues.length === 0, issues };
}
