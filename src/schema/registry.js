// Access to the domain memory schema. The source of truth is the skills registry: the closed data schema
// and the entity_key canonicalization rules live in the domain-schema.json file next to SKILL.md and are
// loaded into memory at startup. This module is a thin wrapper over the skills registry for the memory-write
// layer (extract.js, validate.js): it returns a domain definition by domain key and the spec of a single entity.
import { getDomainDefinitionByKey } from '../pipeline/skills/registry.js';

// Load a domain definition by its key. Returns a definition object (closed schema and entity_key
// dictionaries) or null if the domain has no schema (a domain without subject entities).
export async function loadDomainDefinition(domainKey) {
  return getDomainDefinitionByKey(domainKey);
}

// Identifier of the schema source for writing into a fact's metadata. Returns the string marker 'skill' if
// the domain has a schema, otherwise null. The schema is versioned together with the skill in version
// control, so there is no numeric version at runtime.
export async function getActiveVersion(domainKey) {
  return getDomainDefinitionByKey(domainKey) ? 'skill' : null;
}

// Spec of a specific domain entity: the key rule and the closed data schema.
// Returns { entity_type, entity_key, data_schema } or null if the entity is not in the schema.
export async function getEntitySpec(domainKey, entityType) {
  const definition = await loadDomainDefinition(domainKey);
  if (!definition || !entityType) {
    return null;
  }
  const entity = definition.entities.find((e) => e.entity_type === entityType);
  if (!entity) {
    return null;
  }
  return { entity_type: entity.entity_type, entity_key: entity.entity_key, data_schema: entity.data_schema };
}
