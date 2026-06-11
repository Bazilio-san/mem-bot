# 11. Skills: domains, schemas, and behavior

## [SKILL-1] Skill structure

The skill registry is file-based. Each skill lives in its own directory:

```text
skills/
  <name>/
    SKILL.md            machine fields + prompt blocks
    domain-schema.json  closed description of the domain's subject entities (optional)
    references/         heavy reference files, read on demand (optional)
```

`SKILL.md` is divided into a machine section (YAML front matter) and human-readable markdown blocks with stable
headings that the code extracts deterministically, without guessing meaning through arbitrary parsing:

```markdown
---
name: flight-search
domain_key: flight_search
title: Flight Search
description: Search for flights, airports, routes, departure dates, layovers, and price comparison.
enabled: true
classification:
  when_to_use: >
    The user asks about plane tickets, flights, airports, travel dates, routes,
    layovers, flight prices, baggage, or ways to get somewhere by air.
  positive_signals: [ticket, flight, airline, airport, departure, layover, baggage]
  negative_signals: [general travel question without asking about a flight]
memory:
  scopes: [profile, domain, dialog]
  schema: domain-schema.json
tools:
  allowed: [search_flights, find_airports, get_booking_options]
  base: true
model:
  main: null
  extract: null
references:
  allowed: true
---

# Skill Prompt

Instructions that are added to the main response when the skill is active.

## Fact Extraction Prompt

Instructions that are added to the fact extraction prompt.

## Domain Schema

The closed schema can be embedded here as a ```json block if it is small, instead of a separate domain-schema.json.

## References

- `references/airlines.md`: what it contains and when to read it.
```

Required fields: `name` (the skill key, matches the directory name), `domain_key` (the domain namespace for memory),
`classification.when_to_use` (the semantic routing rule for the router), and the `# Skill Prompt` block. Everything
else is optional: `positive_signals` and `negative_signals` are hints to the router, not a strict list;
`tools.allowed` restricts the domain-specific tools; `tools.base` enables the base system tools;
`memory.scopes` hints at which memory sections are typically needed; `model.main` and `model.extract` override
the models for this skill; `references` enables reading of the `references/**` directory.

## [SKILL-2] Domain entity schema

The schema source is a file next to the skill: `domain-schema.json` or an embedded `## Domain Schema` block.
The schema is a closed, machine-checkable description of the subject entities the domain works with. Each entity
declares a closed JSON schema for its `data` fields (`additionalProperties: false`, all fields in `required`,
specific types and `enum` where needed) and an `entity_key` formation rule:

```jsonc
{
  "domain_key": "math_tutor",
  "title": "Math Tutor",
  "entities": [
    {
      "entity_type": "student_skill",
      "entity_key": { "mode": "fixed_vocab",
        "vocabulary": ["linear_equations", "quadratic_equations", "fractions", "word_problems"],
        "synonyms": { "quadratic_equations": ["quadratic equations", "discriminant"], "fractions": ["fractions"] } },
      "data_schema": {
        "type": "object", "additionalProperties": false,
        "required": ["topic", "level", "last_errors"],
        "properties": {
          "topic": { "type": "string" },
          "level": { "type": ["string", "null"] },
          "last_errors": { "type": "array", "items": { "type": "string" } }
        }
      }
    },
    {
      "entity_type": "learning_goal",
      "entity_key": { "mode": "slug" },
      "data_schema": {
        "type": "object", "additionalProperties": false,
        "required": ["goal", "deadline", "status"],
        "properties": {
          "goal": { "type": "string" }, "deadline": { "type": ["string", "null"] },
          "status": { "type": ["string", "null"] }
        }
      }
    }
  ]
}
```

The schema serves the skill-authoring toolset ([SKILL-4]): it gives the part generators a precise, validatable
definition of what the domain is about, lets schema edits be applied surgically entity by entity, and lets the
meta-validator reject a malformed definition before it is written to disk. The memory pipeline does not consume
these schemas: long-term memory stores flat one-sentence facts in `mem.user_facts`, addressed by `domain_key`
and `fact_type` (see [06-memory.md](06-memory.md)). What domain knowledge reaches memory is steered by the
skill's `## Fact Extraction Prompt` block, not by the entity schema.

---

## [SKILL-3] How the layer is structured

Domain behavior is defined by data (skill files), not by code: adding a domain requires no changes to source files.
Layer components:

- Module `src/pipeline/skills/`: `parse.js` (parses `SKILL.md` into front matter and blocks), `registry.js` (loading,
  validation, in-memory cache, access to prompt blocks, schema, and references), `cli.js` (commands `validate | list | sync`).
- Module `src/schema/`: `meta.js` (meta-schema definition and the shared `ajv` validator), `registry.js` (access to
  the domain schema and entity specification via the skill registry), `validate.js` (`validateAndCanonicalize`).
- Dependency `ajv` (JSON Schema validator).
- Directory `skills/` in the repository: skills as source text for review and git. The registry reads them at startup.

**Domain addition flow.** A directory `skills/<name>/` is created with a `SKILL.md` file and, if needed,
`domain-schema.json` and `references/`. The `validate` command checks all skills (front matter shape, presence of
required blocks, schema validity against the meta-schema). The `sync` command creates a row in `mem.agent_domains`
mapping `domain_key` to `domain_id` for each new domain key. The `list` command shows active skills, their tools,
and whether a schema is present. After adding the skill directory, the router sees it on the next startup.

**Classification selects the skill.** A cheap model receives a compact list of skills (`name`, `domain_key`, `title`,
`description`, `when_to_use`, signals) and returns the `skill_name` of the most appropriate skill. The domain key
for memory addressing is derived from the selected skill by code, not from the model's response. If no specialized
skill fits, the fallback `general` skill is selected.

**Schema layer utilities.** The `src/schema/` module gives the authoring toolset a deterministic contract for
working with entity definitions. `meta.js` holds the meta-schema and the shared `ajv` validator that every
definition must pass; `registry.js` resolves a domain schema and an entity specification through the skills
registry (`getEntitySpec`); `validate.js` provides `validateAndCanonicalize` for checking a candidate entity
object against its schema: code-level normalization runs first (extra keys are dropped, a single value is wrapped
in an array where the schema expects one, a numeric string is coerced to a number, missing fields are filled with
`null`), and an object that still does not match the schema is rejected. Canonicalization of `entity_key` has two
modes: `fixed_vocab` requires the key to come from the vocabulary — an exact match passes through as-is, a
synonym is mapped to the canonical key, a semantically close value is matched by embedding above a threshold,
and anything else is flagged and stored as a slug; `slug` mode normalizes the key to a Latin slug by
transliteration and lowercasing ("Nizhniy Novgorod" becomes `nizhniy-novgorod`).

**Tools and references.** Base system tools (memory, scheduler, global memory, response form) are always available
if permitted by flags and permissions. A domain-specific tool is available only if it is listed in `tools.allowed`
of the active skill. The `skill_read_reference` tool is available when the active skill has `references.allowed` set
and reads files only from that skill's `references/**` directory, blocking absolute paths and traversal via `..`.
This enables progressive disclosure: the router sees a short description, the main prompt receives a compact
`# Skill Prompt`, and heavy reference material is read only when explicitly needed.

**Integration points.** When generating a response, `src/agent.js` determines the active skill, derives the domain
key from it, injects the `ACTIVE_SKILL_CONTEXT` block containing the `# Skill Prompt` content, and restricts tools
to those in `tools.allowed`. Fact extraction after the response receives the active skill's
`## Fact Extraction Prompt` block inside the single `extractFacts` call, and the resulting facts are stored as
flat rows in `mem.user_facts` (see [06-memory.md](06-memory.md) and
[08-prompts-and-models.md](08-prompts-and-models.md)). The domain entity schema enters the picture only through
the skill-authoring tools ([SKILL-4]), which create, edit, and validate it.

---

## [SKILL-4] Creating and editing skills

Skills are created and edited by an administrator through the skill authoring toolset — a set of agent tools that
the model operates directly within the conversation. The toolset is delivered as a skill-editor skill called
`skill-author` (domain `skill_author`): its `# Skill Prompt` block describes the anatomy of a skill, the purpose
of each part, and the workflow, while `tools.allowed` lists the authoring tools. This is a self-applicable
construction — a skill that edits skills.

Under the hood, the model generates skill parts as strict JSON (a full skill draft from a description, rewriting
prompt blocks, generating and patching the domain schema) inside `src/pipeline/skills/author.js`, and the code
validates the result with the `validateDefinition` meta-validator before writing. Assembling `SKILL.md` from its
parts, checking invariants, and performing an atomic write with hot-reload of the registry all live in
`src/pipeline/skills/writer.js`.

Any part of a skill is editable: front matter fields (name, description, classification signals, tool list, models),
the `# Skill Prompt` block, the `## Fact Extraction Prompt` block, the closed domain schema (entities, `data`
fields, `entity_key` vocabularies), references, and also enabling, disabling, and deleting a skill. The workflow
is fixed: read the current state of the skill, preview the proposed change with validator notes, get confirmation
from the administrator, and only then write with a backup of the previous version. Writing and deletion are
restricted to the skills directory: absolute paths and traversal outside it are rejected, and destructive actions
require explicit confirmation.

The toolset is available only to administrators (flagged with `is_admin` in `mem.users`) and only when the
corresponding flag is enabled; all editing operations are logged. Access details and the tool list are in
[10-operations.md](10-operations.md); skill part generators are described in
[08-prompts-and-models.md](08-prompts-and-models.md).
