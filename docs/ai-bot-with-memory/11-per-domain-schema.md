# 11. Skills: domains and behavior

## [SKILL-1] Skill structure

The skill registry is file-based. Each skill lives in its own directory:

```text
skills/
  <name>/
    SKILL.md            machine fields + prompt blocks
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
  hint: "Flights and air travel: ticket, flight, airport, departure, layover, baggage."
  when_to_use: >
    The user asks about plane tickets, flights, airports, travel dates, routes,
    layovers, flight prices, baggage, or ways to get somewhere by air.
  positive_signals: [ticket, flight, airline, airport, departure, layover, baggage]
  negative_signals: [general travel question without asking about a flight]
memory:
  scopes: [profile, domain, dialog]
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

## References

- `references/airlines.md`: what it contains and when to read it.
```

Required fields: `name` (the skill key, matches the directory name), `domain_key` (the domain namespace for memory),
`classification.when_to_use` (the semantic routing rule for the router), and the `# Skill Prompt` block. Everything
else is optional: `classification.hint` is the single line the classifier prompt shows for the skill — its essence
plus a few trigger words in the language users actually type (for a skill without a `hint`, the registry composes
the line from `description` and the first `positive_signals`); `positive_signals` and `negative_signals` document
the routing boundary for skill authors and feed the composed fallback hint;
`tools.allowed` restricts the domain-specific tools; `tools.base` enables the base system tools;
`memory.scopes` hints at which memory sections are typically needed; `model.main` and `model.extract` override
the models for this skill; `references` enables reading of the `references/**` directory.

## [SKILL-2] Domain specificity of memory

Long-term memory stores flat one-sentence facts in `mem.user_facts` (see [06-memory.md](06-memory.md)); there
is no separate layer of structured per-domain data. A skill shapes the memory of its domain through exactly
two mechanisms:

1. **The `## Fact Extraction Prompt` block** — the only mechanism for tuning fact extraction to the domain.
   Its text is appended to the shared extraction prompt when the skill is active (with an explicit note that
   the "facts only from user messages" rule still applies). The block describes, in natural language, which
   stable facts matter in this subject area and which do not. Example phrasings:

   ```markdown
   ## Fact Extraction Prompt

   Save as goal/open_loop facts: the route the user is searching (origin, destination, dates,
   passengers, baggage), strong airline or layover preferences. One trip = one fact; a refined
   search replaces the previous trip fact rather than adding a new one. Do not save one-off
   price quotes or the contents of search results.
   ```

   ```markdown
   ## Fact Extraction Prompt

   Save the topics the student struggles with and the learning goals with their deadlines.
   Phrase progress as a pattern ("struggles with quadratic equations"), not as a session log.
   ```

2. **The `domain_key` storage coordinate** — facts of domain-bound types (`goal`, `open_loop`) are stored
   under the active skill's `domain_key`, while person-level types go to `general`. Retrieval always covers
   the current domain plus `general`, so domain memory never leaks across skills. All storage policies apply
   per fact row regardless of the domain: per-type retention, source ranks, and pinning (see
   [06-memory.md](06-memory.md), MEM-5/MEM-6).

---

## [SKILL-3] How the layer is structured

Domain behavior is defined by data (skill files), not by code: adding a domain requires no changes to source files.
Layer components:

- Module `src/pipeline/skills/`: `parse.js` (parses `SKILL.md` into front matter and blocks), `registry.js` (loading,
  validation, in-memory cache, access to prompt blocks and references), `cli.js` (commands `validate | list | sync`).
- Directory `skills/` in the repository: skills as source text for review and git. The registry reads them at startup.

**Domain addition flow.** A directory `skills/<name>/` is created with a `SKILL.md` file and, if needed,
`references/`. The `validate` command checks all skills (front matter shape, presence of required blocks). The
`sync` command creates a row in `mem.agent_domains` mapping `domain_key` to `domain_id` for each new domain key.
The `list` command shows active skills and their tools. After adding the skill directory, the router sees it on
the next startup.

**Classification selects the skill.** A cheap model receives a compact list of skills — one line per skill,
`- <name> — <hint>`, where the hint is `classification.hint` or its composed fallback — and returns the
`skill_name` of the most appropriate skill. The domain key for memory addressing is derived from the selected
skill by code, not from the model's response. If no specialized skill fits, the fallback `general` skill is
selected.

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
[08-prompts-and-models.md](08-prompts-and-models.md)).

---

## [SKILL-4] Creating and editing skills

Skills are created and edited by an administrator through the skill authoring toolset — a set of agent tools that
the model operates directly within the conversation. The toolset is delivered as a skill-editor skill called
`skill-author` (domain `skill_author`): its `# Skill Prompt` block describes the anatomy of a skill, the purpose
of each part, and the workflow, while `tools.allowed` lists the authoring tools. This is a self-applicable
construction — a skill that edits skills.

Under the hood, the model generates skill parts as strict JSON (a full skill draft from a description, rewriting
prompt blocks) inside `src/pipeline/skills/author.js`. Assembling `SKILL.md` from its parts, checking invariants,
and performing an atomic write with hot-reload of the registry all live in `src/pipeline/skills/writer.js`.

Any part of a skill is editable: front matter fields (name, description, classifier hint and signals, tool list,
models),
the `# Skill Prompt` block, the `## Fact Extraction Prompt` block, references, and also enabling, disabling, and
deleting a skill. The workflow is fixed: read the current state of the skill, preview the proposed change with
validator notes, get confirmation from the administrator, and only then write with a backup of the previous
version. Writing and deletion are restricted to the skills directory: absolute paths and traversal outside it are
rejected, and destructive actions require explicit confirmation.

The toolset is available only to administrators (flagged with `is_admin` in `mem.users`) and only when the
corresponding flag is enabled; all editing operations are logged. Access details and the tool list are in
[10-operations.md](10-operations.md); skill part generators are described in
[08-prompts-and-models.md](08-prompts-and-models.md).
