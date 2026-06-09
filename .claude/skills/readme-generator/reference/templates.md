# Section Templates (Main README)

Canonical blocks for the main `README.md`. Copy a block, then adapt placeholders (`<Name>`,
`<command>`, `<package>`, `<PORT>`, …) to the actual project. Rename headings to fit the project's
vocabulary — "Commands" for a CLI, "API" for a library, "Endpoints" for a service.

---

## 1. Title + one-liner

```markdown
# <Project Name>

<One-sentence description: what it is and the single most important thing it does.>
```

Example:

```markdown
# acme-parser

A streaming JSON parser for Node.js — parse multi-gigabyte documents without loading them into memory.
```

---

## 2. Badges

Prefer shields.io. Include only badges that are meaningful (skip build status if there is no CI yet).

```markdown
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/<package>.svg)](https://www.npmjs.com/package/<package>)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![CI](https://img.shields.io/github/actions/workflow/status/<owner>/<repo>/ci.yml)](../../actions)
```

Pick the badges that match the stack — language/runtime, package registry, build status, license.

---

## 2a. Quick Links

Navigation block for the main README. Sits immediately after the badges, before **Overview**. Lists
only the major sections a reader is likely to jump to — never a full table of contents.

**Inclusion rule.** Include a link for every `##` section that is either (a) one of the headline
topics (Quick Start, Usage, Key Features, API / Commands, Configuration, Build & Run, Integration),
or (b) a notable dynamic feature section produced in Step 3 of the workflow. Exclude Overview,
Stack, License, and every `###` sub-subsection. Target 8–14 entries.

```markdown
## Quick Links

- [Quick Start](#quick-start)
- [Usage](#usage)
- [Key Features](#key-features)
- [API](#api)
- [Configuration](#configuration-basics)
- [Build & Run](#build--run)
- [Architecture](#architecture)
```

**Anchor-slug rules (GitHub Markdown).**

- Lowercase the heading, replace spaces with `-`, strip punctuation (`,`, `.`, `:`, `?`, `!`, `()`).
- `&` is dropped entirely and produces a double dash — `Build & Run` → `#build--run`.
- `+` is dropped — `Setup + Run` → `#setup--run`.
- If the Quick Links label diverges from the exact heading text, anchor to the heading, not the
  label (the label is for humans; the anchor must match the section's slug).
- When two headings collide (e.g. two `## Configuration`), GitHub appends `-1`, `-2`; avoid that by
  using distinct headings.

Verify every anchor resolves after writing — dead Quick Links are worse than no Quick Links.

---

## 3. Overview

2–4 sentences. Answer: *what is this / for whom / core value*. Active voice. No marketing fluff.

```markdown
## Overview

<Project> <does X> for <audience>. It <core mechanism / approach>, supports <key capabilities>, and
ships with <one or two distinguishing features>. Use it when you need <primary use case>.
```

---

## 4. Quick Start

Two to four steps. Target: a user productive in under two minutes.

````markdown
## Quick Start

```bash
# install
<install command, e.g. npm install acme-parser  |  pip install acme  |  cargo add acme>
```

```<language>
// minimal working example
<the shortest snippet that produces a visible result>
```
````

For a CLI, show the headline invocation instead of a code snippet:

````markdown
## Quick Start

```bash
<install command>
<command> --help            # see available subcommands
<command> <typical args>    # the most common task
```
````

---

## 5. Usage / Examples

The most common real task, shown end to end. Choose the form that fits the project type.

**Library:**

````markdown
## Usage

```<language>
import { thing } from '<package>';

const result = thing.doSomething({ option: true });
console.log(result);
// => <expected output>
```
````

**CLI:**

````markdown
## Usage

```bash
<command> build ./src --out ./dist
<command> watch ./src
```

| Command            | Description                              |
|--------------------|------------------------------------------|
| `<command> build`  | <what it does>                           |
| `<command> watch`  | <what it does>                           |
````

**Service:**

````markdown
## Usage

```bash
curl -X POST http://localhost:<PORT>/api/<resource> \
  -H "Content-Type: application/json" \
  -d '{"<field>": "<value>"}'
```

Response:

```json
{ "<field>": "<value>", "status": "ok" }
```
````

---

## 6. Key Features

5–8 bullets. Include enabled capabilities and project-specific strengths. One line each, verb-first.

```markdown
## Key Features

- **<Capability>**: <one-line description of what it gives the user>
- **<Capability>**: <one-line description>
- **<Capability>**: <one-line description>
```

---

## 7. Public surface — API / Commands / Endpoints

The public interface, grouped by domain. Keep rows short — one-line descriptions only.

If the listing is long, wrap it in a `<details>` block so it does not dominate the page on first
scroll. The `## <Heading> (<N>)` heading itself stays *outside* the block — it must remain visible
and anchor-linkable from **Quick Links**.

````markdown
## API (<N>)

<details><summary>Expand to view the full <API / command / endpoint> list</summary><br>


### <Group 1>

| <Name>                | Description                                        |
|-----------------------|----------------------------------------------------|
| `<identifier>`        | <Short description, verb-first, ≤ 80 chars>        |
| `<identifier>`        | <Short description>                                |

### <Group 2>

| <Name>                | Description                                        |
|-----------------------|----------------------------------------------------|
| `<identifier>`        | <Short description>                                |

</details>
````

Formatting rules specific to this block:

- `<br>` immediately after `</summary>` is **mandatory** — without it GitHub collapses the first
  child block against the summary line.
- Keep one blank line between `<summary>` and the first `###` subsection, and one blank line before
  `</details>`.
- Column widths consistent within the file.
- Identifiers always inline-code.
- If an item has a caveat, use a footnote `*` and explain below the table.

For a short surface (a handful of items) skip `<details>` and show the table directly.

---

## 8. Configuration Basics

Compact table with the 5–8 most important keys. Link to a full reference when the list grows. The
complete parameter list never appears here — it lives in `readme-docs/configuration.md`.

```markdown
## Configuration Basics

<One line on where config comes from and precedence, e.g.:>
Priority: env vars > `config/local.yaml` > `config/default.yaml`.

| Key / Variable        | Description                         | Default   |
|-----------------------|-------------------------------------|-----------|
| `<key>`               | <what it controls>                  | `<value>` |
| `<key>`               | <what it controls>                  | `<value>` |
| `<ENV_VAR>`           | <what it controls>                  | —         |

Full reference: [Configuration](./readme-docs/configuration.md).
```

Drop the last line if there is no full reference satellite.

---

## 9. Build & Run / Development

```markdown
## Build & Run

```bash
<build command>        # e.g. npm run build  |  cargo build --release  |  make
<run command>          # e.g. npm start
<dev command>          # e.g. npm run dev (watch mode)
```

Lint / typecheck / test:

```bash
<lint command>
<typecheck command>
<test command>
```

Environment variables:

- `<ENV_VAR>` — <what it does>
```

Keep only the commands the project actually defines.

---

## 10. Feature sections (dynamic)

One short subsection per notable subsystem or project-specific capability. 2–3 sentences each, with
a link to the satellite file when details warrant one.

```markdown
### Authentication

<One or two sentences on the supported methods.> Resolution order and invariants:
[Authentication](./readme-docs/authentication.md).

### Database

<One or two sentences on what is stored and the engine used.> Setup and schema:
[Database](./readme-docs/database.md).

### Deployment

<One or two sentences on the target and method.> Full guide:
[Deployment](./readme-docs/deployment.md).
```

Anchor rule: a feature section referenced from **Quick Links** must live at `##` level (not `###`)
so the anchor resolves from the top of the document.

---

## 11. Integration (only if applicable)

How to connect or consume the project from another tool or client. Adapt the snippet to the
project's real interface. Example for a service consumed over HTTP:

````markdown
## Integration

Add to your client config:

```json
{
  "<name>": {
    "url": "http://<host>:<PORT>/<path>",
    "headers": { "<header>": "<value>" }
  }
}
```
````

Drop this section entirely when the project is not meant to be wired into another tool.

---

## 12. Architecture (optional)

```markdown
## Architecture

<2–3 sentences on the high-level structure and the main moving parts.> Deep dive:
[Architecture](./readme-docs/architecture.md).
```

---

## 13. Stack

```markdown
## Stack

- **Framework**: <framework + link>
- **Language**: <language / runtime>
- **Transport / protocol**: <if applicable>
- **Key libraries**: <the notable dependencies>
```

---

## 14. License

```markdown
## License

<License name> © <Owner>. See [LICENSE](./LICENSE).
```

---

## 15. Collapsible `<details>` block (generic pattern)

Use this pattern for any section where the content is important enough to stay inline (so a reader
and any doc-assembly tooling still find it in the main document) but bulky enough to drown
neighbouring sections on a casual scroll. Canonical use: the public-surface listing (see section 7).
Other legitimate uses: long example matrices, exhaustive troubleshooting tables, verbose
per-endpoint catalogues.

**Checklist before reaching for `<details>`:**

1. The content must appear *in this section* (cannot be moved to a satellite file without losing
   context).
2. It spans enough lines that a reader scrolling past this section loses sight of the next section
   on a standard screen.
3. A casual first-time reader does not need every line immediately — the summary label alone tells
   them what is hidden.

If any of the three fails, either inline it normally or move it to `readme-docs/`.

```markdown
## <Section heading stays outside>

<Optional 1–3 sentence intro stays outside too — gives readers enough to decide whether to expand.>

<details><summary>Expand to view <what is inside>: <e.g. "the full method list" /
"the request/response schema" / "the per-endpoint example matrix"></summary><br>


<bulky content: tables, code blocks, nested subsections — anything markdown supports>

</details>
```

**Do NOT wrap in `<details>`:**

- Quick Start commands
- Key Features bullet list
- Configuration Basics table (short by design)
- The full environment-variable / parameter list — it goes to `readme-docs/configuration.md`, not
  into a collapsed block in the README (a `<details>` still bloats the main file)
- Usage / integration snippets
- Anything under ~20 lines
