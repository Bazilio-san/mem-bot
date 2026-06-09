---
name: readme-generator
description: Generates a structured, user-friendly README.md for any software project using the progressive-disclosure idea. Inventories the project, decides per topic whether to drop it, inline it, or move it to a satellite readme-docs/*.md file, then emits a scannable main README with Quick Links and collapsible blocks. Use when creating or refreshing a project's README.
---

# README Generator

Generates a `README.md` that answers three progressive questions — *what is this?*, *how do I use
it?*, *how do I operate it?* — without drowning casual readers in operational detail. The skill is
project-agnostic: it works for a library, a CLI, a service, a web app, a framework, or a tool. It
inventories whatever the project actually is, then builds the README to match.

## Philosophy: progressive disclosure

The README is organised as a three-level information hierarchy. A reader gets exactly as much as
they need at their current depth, and can descend one level at a time.

**Level 1 — What it is & how to start (first 30 seconds)**

- What the project is and who it is for
- The primary entry point — the public API, the main command, or the core feature
- The shortest path to first success (install + a minimal working example)

**Level 2 — Features & basics (the interested reader)**

- Key features, supported configuration, the essential setup a real user needs

**Level 3 — Operations (the deployer / maintainer)**

- Build & run, the full configuration reference, deployment, and deep technical topics

Level 1 and 2 live in the main README. Level 3 content longer than ~15 lines moves to a satellite
Markdown file under `readme-docs/`. The main README stays scannable; the deep detail is one click
away, never deleted.

### Scannability devices: Quick Links + collapsible blocks

Two devices keep the main README scannable even when it carries substantial inline content:

- **Quick Links** — a short navigation block right after the badges, pointing to the *major*
  sections a reader is likely to jump to (Quick Start, Usage, Features, Configuration, API /
  Commands, Build & Run, and any notable feature section that has its own heading). Do **not** dump
  a full table of contents: secondary headings such as Overview, Stack, License, and minor
  sub-subsections stay out. Rule of thumb: 8–14 links, never more.
- **Collapsible `<details>` blocks** — wrap content that *should* appear inline (so a reader and any
  documentation-assembly tooling still find it in the main document) but whose volume would drown
  neighbouring sections on a casual scroll. The canonical case is a large reference table — a full
  API method list, a CLI command catalogue, an endpoint matrix (often 50+ rows). Use `<details>`
  when all three hold: (1) the content belongs in this section, (2) it is long enough to push
  everything below off-screen, (3) a casual reader does not need every row right away. Do **not**
  use `<details>` for content readers need at a glance (Quick Start commands, Key Features bullets,
  the compact Configuration Basics table, usage snippets). See `reference/templates.md` for the
  required markup — the `<br>` after `</summary>` is mandatory, GitHub will not render the first
  child block correctly without it.
- **`<details>` is not an escape hatch for the configuration dump.** A collapsed block still lives
  in the main README and still bloats it. The full environment-variable / parameter list — grouped
  by category, with defaults — must go to `readme-docs/configuration.md`, **never** into a
  `<details>` in the README. The README keeps only the compact Configuration Basics table. The
  `<details>`-inline allowance is for a project's *public surface* (API methods, CLI commands,
  endpoints), not for configuration.

## The `readme-docs/` folder

Satellite Markdown files live in `readme-docs/` at the project root. This is the convention this
skill follows for every project, and **the folder name must not be changed** — keep it exactly
`readme-docs/`.

The rule that makes the folder load-bearing:

- **A satellite file reaches readers only if the main README links to it.** Every file you create
  under `readme-docs/` must be linked from `README.md` with a short 2–3 sentence summary. An
  unlinked satellite is orphaned — nobody navigates to it, and any tool that assembles the README
  together with its satellites (a documentation site, or an MCP `doc://readme`-style resource that
  inlines linked files for RAG indexing) will skip it.
- **Do not rename the folder.** Tooling and links across the project assume `readme-docs/`; any
  other name (`docs/`, `doc/`, `readme-parts/`, …) breaks those assumptions.

If the project already has a `readme-docs/` folder, treat its existing files as the source of truth
for content you are not explicitly regenerating — do not delete or restructure them gratuitously.

## Dynamic detection is mandatory

The set of sections and satellite files is **not fixed**. The skill inventories the project, decides
per topic whether it applies, and only then produces the matching README sections and
`readme-docs/*.md` files. **Do not invent sections for capabilities the project does not have.** Do
not emit empty sections or satellite stubs for absent features.

## Workflow

### Step 1 — Inventory the project

Collect, from the actual repository, whatever applies. Adapt to the project's ecosystem — the items
below are a checklist, not a requirement that all be present.

**Identity & metadata**

- Package / manifest file (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, …)
  → name, version, description, license, dependencies
- Git remote URL, license file
- Project type: library, CLI, service / server, web app, framework, or tool

**Entry points & public surface**

- The primary way a user invokes the project: imported API, CLI command(s), HTTP endpoints, UI
- The full public surface worth listing: exported functions/classes, subcommands, routes, tools
- How a consumer installs and connects (package manager, container, hosted endpoint)

**Operational surface**

- Build / run / test commands (from scripts, Makefile, task runner)
- Configuration: files, environment variables, defaults, and which keys actually matter
- Notable subsystems the project integrates (database, cache, auth, queue, service discovery, …)
- Deployment story, if any (container, CI, cloud target)

**Project-specific capabilities** — anything non-trivial that distinguishes this project:

- Custom algorithms, batch limits, caching strategy, version auto-detection, format conversion,
  plugin system, in-project tooling (e.g. Claude Code skills under `.claude/skills/`), etc.

Record all findings in a working note — they drive the decisions in the next step.

### Step 2 — Classify findings: drop / inline / satellite

For each finding, pick a placement:

- **Drop** — the project does not have this; no section, no satellite file.
- **Inline** — description ≤ ~15 lines. Put a short subsection in the main README.
- **Satellite** — description > ~15 lines, OR the topic contains reference tables, priority rules,
  request/response schemas, or long examples. Create `readme-docs/<kebab-name>.md` and link to it
  from the main README with a 2–3 sentence summary.

**Always satellite** (a firm rule — move out even if it would fit inline):

- **Configuration.** When the project has many configuration parameters (more than ~10), the full
  list with descriptions and defaults goes into a second-level file `readme-docs/configuration.md`.
  The main README keeps only a compact **Configuration Basics** table of the 5–8 keys that matter
  most (the ones without which the project will not start, plus the handful of behaviour switches a
  typical user flips first), plus a link to the full reference. Never dump the complete parameter
  list into the main README — not as a flat table, not as category bullet lists, and **not hidden
  inside a `<details>` block**. The first page is for understanding what the project does and the
  minimum to run it; exhaustive parameter reference always lives one level down.

**Lean satellite** (move out even if borderline) for topics that are reference-heavy or
operations-only:

- Authentication / authorization resolution order and priority tables
- Deployment, infrastructure, and detailed subsystem setup (database, cache, discovery, …)
- Exhaustive API / endpoint references with schemas
- Architecture deep-dives and design rationale

**Always inline in the main README** (never moved out entirely):

- The one-line description and Overview
- Quick Start (install + minimal run)
- Key Features bullet list
- The public-surface listing (API / commands / endpoints) — readers need to see what the project
  offers; wrap it in `<details>` if it is long, but keep it in the main document
- A compact Configuration Basics table (the 5–8 keys that matter most)

### Step 3 — Build the main README section list

Canonical section order. Include only sections backed by actual findings; omit anything empty.
Rename headings to fit the project's vocabulary (e.g. "Commands" for a CLI, "API" for a library,
"Endpoints" for a service).

1. **Title + one-line description** (from the manifest)
2. **Badges** — license, language/runtime, build status, key stack badges via shields.io
3. **Quick Links** — 8–14 anchor links to the major sections only (see *Scannability devices*)
4. **Overview** — 2–4 sentences. Answers: what is this, for whom, core value
5. **Quick Start** — install + minimal working example, in 2–4 short steps; a user productive in
   under two minutes
6. **Usage / Examples** — the most common real task, shown end to end. For a library, an idiomatic
   code sample; for a CLI, the headline commands; for a service, a sample request/response
7. **Key Features** — 5–8 bullets covering enabled capabilities and project-specific strengths
8. **Public surface — API / Commands / Endpoints** — a grouped table of the public interface. If it
   is long, wrap the listing in a `<details>` block, keeping the `##` heading *outside* the block so
   it stays visible and anchor-linkable from Quick Links
9. **Configuration Basics** — the 5–8 most important keys in a compact table; link to
   `readme-docs/configuration.md` for the full reference. The complete parameter list never appears
   in the main README, not even inside a `<details>` block
10. **Build & Run / Development** — build, run, test, lint commands; environment variables
11. **Feature sections (dynamic)** — one short subsection per notable subsystem or project-specific
    capability. Each: 2–3 sentences + a link to its `readme-docs/*.md` when a satellite is warranted.
    Typical candidates: authentication, database, caching, deployment, integrations, plugin system,
    in-project skills, and any distinguishing capability. Anchor rule: any feature section
    referenced from **Quick Links** must live at `##` level (not `###`) so the anchor resolves
12. **Integration** *(only if applicable)* — how to connect or consume the project from other tools
    or clients, with concrete config snippets adapted to the project's real interface
13. **Architecture / How it works** *(optional)* — 2–3 sentences + link to
    `readme-docs/architecture.md` for the deep version
14. **Stack** — 4–7 bullets: framework, runtime/language, transport/protocol, key libraries
15. **Contributing** *(optional)* — short pointer + link to `readme-docs/contributing.md` if present
16. **License**

### Step 4 — Generate `README.md`

Apply the canonical section order from Step 3. Respect these rules:

- H1 is the project name only — no duplicate title in the next line.
- Reference-table column widths consistent within the file. Identifiers (function names, commands,
  keys) as inline code.
- Every code fence has a language specifier (` ```bash `, ` ```json `, ` ```yaml `, ` ```python `,
  ` ```typescript `, …) matching the project's languages.
- Commands, ports, and paths in examples match the project's actual values (read them from config /
  scripts, do not guess).
- Relative links for internal references: `[…](./readme-docs/configuration.md)`.
- Line length ≤ 120 chars where practical. Exceptions: URLs, code blocks, tables.
- No marketing superlatives. Active voice. Short paragraphs (2–4 sentences).

See `reference/templates.md` for canonical blocks.

### Step 5 — Generate satellite `readme-docs/*.md` files

For each finding classified as *satellite* in Step 2, create a Markdown file under `readme-docs/`
(create the folder if missing). Use `reference/satellite-templates.md` as a starting point —
skeletons are provided for common topics (configuration, architecture, development, API reference,
authentication, deployment, troubleshooting). **Adapt every skeleton to actual values from the
project.**

For project-specific capabilities compose a new `readme-docs/<kebab-name>.md` with sections:
*Overview*, *How it works*, *Configuration*, *Examples*, *Caveats*.

Every satellite file begins with a one-sentence summary so it stands alone when opened directly,
and is linked from the main README (an unlinked satellite is orphaned — see *The `readme-docs/`
folder*).

### Step 6 — In-project tooling index *(only if present)*

If the project ships its own tooling worth cataloguing — for example Claude Code skills under
`.claude/skills/` — generate a satellite index for it (e.g. `readme-docs/SKILLS.md`) with one
section per item (command, purpose, arguments, examples) and link to it from the main README. Skip
this step entirely when there is nothing to catalogue.

### Step 7 — Validate

Run through this checklist before declaring done:

- [ ] Canonical section order followed; no empty headings
- [ ] **Quick Links** block is present, sits right after the badges, has 8–14 entries covering only
      major sections, and every anchor resolves to an existing `##` heading in the file
- [ ] Any long reference table is wrapped in `<details><summary>…</summary><br>` with its `##`
      heading kept *outside* the block
- [ ] No `<details>` used to hide content readers need at a glance (Quick Start, Key Features,
      Configuration Basics, usage snippets)
- [ ] Every section in the main README is ≤ ~40 lines (or wrapped in `<details>`, or split into a
      satellite)
- [ ] Counts in any `## … (<count>)` heading match the corresponding table
- [ ] Every satellite link resolves to an existing file in `readme-docs/`, and every file in
      `readme-docs/` is linked from the main README
- [ ] No satellite file for an absent feature
- [ ] When the project has many config parameters (> ~10), the full list lives in
      `readme-docs/configuration.md`; the main README shows only the compact Configuration Basics
      table (5–8 keys) plus a link, and the full list is **not** present in the README even inside a
      `<details>` block
- [ ] Commands, ports, and paths match the project's actual config / scripts
- [ ] JSON snippets are valid JSON; YAML snippets are valid YAML
- [ ] Every code fence has a language tag
- [ ] Relative links use `./readme-docs/...` form
- [ ] Line length ≤ 120 chars outside URLs / code / tables
- [ ] Previous README backed up to `README.backup.md` when rewriting

## Output

1. `README.md` — restructured per the canonical order
2. `readme-docs/<topic>.md` — one per satellite topic, only those the project needs
3. `readme-docs/<tooling-index>.md` — only if the project ships catalogue-worthy in-project tooling
4. `README.backup.md` — backup of the previous README when rewriting

## References

- `reference/templates.md` — canonical section blocks for the main README
- `reference/satellite-templates.md` — skeletons for common `readme-docs/*.md` files
- `reference/best-practices.md` — writing style and formatting guidelines
