# 11. Skills and Domain Behavior

Skills define domain routing, extra instructions, extraction guidance, reference files, and allowed tools. They are the
project's domain layer; a skill can change how the same core agent behaves for a subject area without forking the core.

## Skill Shape

The authoritative parser and writer define the file format:

- Registry and cache: `../../../src/pipeline/skills/registry.js`
- Frontmatter and section parsing: `../../../src/pipeline/skills/parse.js`
- File composition and writes: `../../../src/pipeline/skills/writer.js`
- CLI validation and sync: `../../../src/pipeline/skills/cli.js`
- Runtime skill directory: `../../../skills/`

## Routing and Memory

Each skill maps to a domain key. Domain keys scope memory retrieval and can influence which tools and references are
available for a model turn. The router and prompt insertion points are owned by `../../../src/agent.js` and
`../../../src/pipeline/skills/registry.js`.

## Skill Authoring

Admins can create and edit skills through model-callable authoring tools. The authoring system stages or writes skill
changes, validates shape, and reloads the registry.

Code owners:

- Authoring support: `../../../src/pipeline/skills/authoring-support.js`
- Draft/refine model calls: `../../../src/pipeline/skills/author.js`
- Authoring tools: `../../../src/pipeline/agent-tools/skill-authoring/`

Do not copy skill examples here. Use real skill files in `../../../skills/` and tests in
`../../../tests/skills.test.mjs`, `../../../tests/skill-authoring.test.mjs`.
