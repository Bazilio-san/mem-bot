// A universal mechanism for applying the domain schema when writing a fact.
// It does two things: validates candidate.data against the entity's closed schema and brings
// candidate.entity_key to a stable form by the domain rule (synonym dictionary or slug).
//
// The schema is mandatory. A subject fact (one with entity_type set) is saved only if the domain
// has an active schema, that schema declares this entity, and data passes validation. Otherwise the
// fact is rejected (ok=false) and is NOT saved — there is no "soft" mode.
// A fact without entity_type (e.g. a free-form profile preference) is not described by a schema and
// passes through unchanged: it is not a domain entity, and there is nothing to validate.
import { ajv } from './meta.js';
import { getEntitySpec, loadDomainDefinition, getActiveVersion } from './registry.js';
import { config } from '../config.js';
import { embed } from '../llm.js';

// ---- Transliteration and slug -----------------------------------------------

// Mapping of Cyrillic letters to Latin combinations for building a slug.
const TRANSLIT = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

// Convert an arbitrary string to a slug: transliterate Cyrillic, lowercase, hyphen separation, no extra
// characters. For example "Стамбул" becomes "stambul".
export function slugify(value) {
  const lower = String(value || '')
    .trim()
    .toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (Object.prototype.hasOwnProperty.call(TRANSLIT, ch)) {
      out += TRANSLIT[ch];
    } else if (/[a-z0-9]/.test(ch)) {
      out += ch;
    } else {
      out += '-';
    }
  }
  // Collapse repeated hyphens and trim them at the edges.
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// ---- Cosine similarity for canonicalizing a key by meaning ------------------

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Find the dictionary key closest in meaning to the given value via embeddings.
// Returns { key, score } or null if embeddings are unavailable. Used only as a fallback
// when an exact match and synonyms did not work.
async function nearestVocabKey(value, vocabulary) {
  const valueVec = await embed(value);
  if (!valueVec) {
    return null;
  }
  let best = null;
  for (const key of vocabulary) {
    const keyVec = await embed(key);
    if (!keyVec) {
      continue;
    }
    const score = cosine(valueVec, keyVec);
    if (!best || score > best.score) {
      best = { key, score };
    }
  }
  return best;
}

// ---- entity_key canonicalization --------------------------------------------

// Bring the candidate's entity_key to canonical form by the entity rule.
// Returns { entity_key, issues }.
async function canonicalizeKey(rawKey, keySpec) {
  const issues = [];
  const { mode } = keySpec;

  if (mode === 'slug') {
    const slug = slugify(rawKey);
    if (!slug) {
      issues.push(`entity_key «${rawKey}» после нормализации в slug оказался пустым.`);
    }
    return { entity_key: slug || rawKey, issues };
  }

  // fixed_vocab
  const vocabulary = keySpec.vocabulary || [];
  // 1. Exact match with the dictionary — nothing to change.
  if (vocabulary.includes(rawKey)) {
    return { entity_key: rawKey, issues };
  }

  // 2. Synonym lookup: "откуда" is mapped to the canonical "departure".
  const lowered = String(rawKey).trim().toLowerCase();
  for (const [canonical, synonyms] of Object.entries(keySpec.synonyms || {})) {
    if ((synonyms || []).some((s) => String(s).trim().toLowerCase() === lowered)) {
      return { entity_key: canonical, issues };
    }
  }

  // 3. The dictionary key closest in meaning (embeddings), if similarity is above the threshold.
  const nearest = await nearestVocabKey(rawKey, vocabulary);
  if (nearest && nearest.score >= config.schema.keyEmbedThreshold) {
    issues.push(
      `entity_key «${rawKey}» канонизирован по смыслу в «${nearest.key}» (близость ${nearest.score.toFixed(2)}).`,
    );
    return { entity_key: nearest.key, issues };
  }

  // 4. Fallback: a slug from the original value, plus a note about the un-canonicalized key.
  const fallback = slugify(rawKey) || rawKey;
  issues.push(`entity_key «${rawKey}» не найден в словаре домена; записан как «${fallback}».`);
  return { entity_key: fallback, issues };
}

// ---- Code-level normalization of data ---------------------------------------

// Cheap normalization of the data object to fit the closed schema: drops extra keys, coerces obvious types
// (numeric string -> number, single value -> array when the schema expects an array), fills missing fields
// with null. This is not a "soft mode" but coercion of unambiguous mismatches; whatever still doesn't fit
// afterwards is considered invalid and the fact is rejected.
function normalizeData(data, dataSchema) {
  const props = dataSchema.properties || {};
  const out = {};
  for (const [field, fieldSchema] of Object.entries(props)) {
    let value = data ? data[field] : undefined;
    const types = Array.isArray(fieldSchema.type) ? fieldSchema.type : [fieldSchema.type];

    if (value === undefined) {
      // Missing field: null if allowed, otherwise an empty array for an array.
      value = types.includes('null') ? null : types.includes('array') ? [] : null;
    } else if (types.includes('array') && !Array.isArray(value) && value !== null) {
      // A single value where an array is expected — wrap it in an array.
      value = [value];
    } else if ((types.includes('integer') || types.includes('number')) && typeof value === 'string') {
      // A numeric string — coerce to a number if possible.
      const num = Number(value);
      if (!Number.isNaN(num)) {
        value = types.includes('integer') ? Math.trunc(num) : num;
      }
    }
    out[field] = value;
  }
  return out;
}

// ---- Main function ----------------------------------------------------------

// Validate and canonicalize a candidate before saving it to memory.
// Returns { ok, candidate, issues, schema_version, reason? }.
//
// Rules (the schema is mandatory):
//  - no entity_type -> the fact is not a domain entity, pass it through unchanged (ok=true);
//  - has entity_type but the domain has no schema -> ok=false (reason 'domain_without_schema');
//  - has entity_type but it is not declared in the domain schema -> ok=false (reason 'entity_not_in_schema');
//  - data does not pass validation even after normalization -> ok=false (reason 'data_invalid').
// On ok=false the calling code (processCandidate) does NOT save the fact.
export async function validateAndCanonicalize(domainKey, candidate) {
  // A fact without an entity is not described by a schema — nothing to validate.
  if (!candidate.entity_type) {
    return { ok: true, candidate, issues: [], schema_version: null };
  }

  const definition = await loadDomainDefinition(domainKey);
  if (!definition) {
    return {
      ok: false,
      candidate,
      schema_version: null,
      reason: 'domain_without_schema',
      issues: [`У домена «${domainKey}» нет активной схемы, а факт содержит сущность «${candidate.entity_type}».`],
    };
  }

  const spec = await getEntitySpec(domainKey, candidate.entity_type);
  if (!spec) {
    return {
      ok: false,
      candidate,
      schema_version: await getActiveVersion(domainKey),
      reason: 'entity_not_in_schema',
      issues: [`Сущность «${candidate.entity_type}» не объявлена в схеме домена «${domainKey}».`],
    };
  }

  const schemaVersion = await getActiveVersion(domainKey);
  const issues = [];
  const validateData = ajv.compile(spec.data_schema);
  let data = candidate.data || {};

  if (!validateData(data)) {
    // One pass — cheap code-level normalization. If it still doesn't fit afterwards — the fact is invalid.
    data = normalizeData(data, spec.data_schema);
    if (!validateData(data)) {
      for (const e of validateData.errors || []) {
        issues.push(`data${e.instancePath || ''} ${e.message}.`);
      }
      return { ok: false, candidate, schema_version: schemaVersion, reason: 'data_invalid', issues };
    }
  }

  // Canonicalize the key by the entity rule.
  const { entity_key: canonicalKey, issues: keyIssues } = await canonicalizeKey(candidate.entity_key, spec.entity_key);
  issues.push(...keyIssues);

  return {
    ok: true,
    candidate: { ...candidate, entity_key: canonicalKey, data },
    issues,
    schema_version: schemaVersion,
  };
}
