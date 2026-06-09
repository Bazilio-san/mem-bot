# Satellite Templates (`readme-docs/*.md`)

Skeletons for common satellite Markdown files referenced from the main README. Each skeleton ends
with the values a skill should fill in from the actual project. **Create a satellite only when the
project actually has the topic; do not emit stubs for absent features.**

All files live under `readme-docs/` in the project root. Naming: kebab-case by topic
(`configuration.md`, `architecture.md`, `authentication.md`, …). Keep the folder name exactly
`readme-docs/` and link every file from the main README — an unlinked satellite is orphaned (see
*The `readme-docs/` folder* in `SKILL.md`).

Every satellite begins with a one-sentence summary so it stands alone when opened directly.

---

## `readme-docs/configuration.md`

Use when the config reference is more than ~15 parameters or spans multiple subsystems.

```markdown
# Configuration

Full configuration reference for <Project>.

<One line on precedence, e.g.:> Priority: env vars > `config/local.yaml` > `config/default.yaml`.

## Core

| Key / Variable        | Description                             | Default   |
|-----------------------|-----------------------------------------|-----------|
| `<key>`               | <what it controls>                      | `<value>` |
| `<key>`               | <what it controls>                      | —         |

## <Subsystem>

| Key / Variable        | Description                             | Default   |
|-----------------------|-----------------------------------------|-----------|
| `<key>`               | <what it controls>                      | `<value>` |

Add one section per subsystem the project configures (database, cache, auth, server, …).
```

---

## `readme-docs/architecture.md`

Use when the design is worth more than the 2–3 sentences inlined in the main README.

```markdown
# Architecture

How <Project> is structured and why.

## Overview

<2–4 sentences on the high-level shape: the main components and how a request / call flows through
them.>

## Components

| Component        | Responsibility                          | Source                      |
|------------------|-----------------------------------------|-----------------------------|
| `<component>`    | <what it does>                          | `src/<path>`                |
| `<component>`    | <what it does>                          | `src/<path>`                |

## Data flow

<Step-by-step or a small diagram of the primary path through the system.>

## Design decisions

<Notable trade-offs and why they were made. Link to ADRs if the project keeps them.>
```

---

## `readme-docs/development.md`

Use when contributor setup goes beyond the build/run commands inlined in the main README.

```markdown
# Development

Setup and conventions for working on <Project>.

## Prerequisites

- <runtime / toolchain version>
- <any required services for local dev>

## Setup

```bash
<clone / install / bootstrap commands>
```

## Common tasks

| Task        | Command            |
|-------------|--------------------|
| Build       | `<command>`        |
| Test        | `<command>`        |
| Lint        | `<command>`        |
| Type-check  | `<command>`        |

## Project layout

<Brief map of the important directories.>

## Conventions

<Coding style, commit conventions, branch model — keep to what the project actually enforces.>
```

---

## `readme-docs/api.md`

Use for an exhaustive API / endpoint reference with schemas that is too large to inline.

```markdown
# API Reference

Complete reference for the <Project> <API / HTTP / CLI> surface.

## <Group / Resource>

### `<identifier>(<params>)`  *(or:  `<METHOD> /path`)*

<One-sentence description.>

| Parameter   | Type     | Required | Description                  |
|-------------|----------|----------|------------------------------|
| `<param>`   | `<type>` | yes/no   | <what it is>                 |

**Returns:** `<type>` — <description>.

Example:

```<language>
<minimal call + result>
```

Repeat per item. Group by resource / module.
```

---

## `readme-docs/authentication.md`

Use when auth is non-trivial (multiple methods, header-based override, token resolution order).

```markdown
# Authentication

How callers authenticate to <Project> and how <Project> authenticates to its dependencies.

## Supported methods

- **<Method>** — <how it is supplied, e.g. `Authorization: Bearer <token>`>
- **<Method>** — <how it is supplied>

## Resolution order

The first matching rule wins:

| # | Source                       | Condition           | Effect                          |
|---|------------------------------|---------------------|---------------------------------|
| 1 | <header / config key>        | <when it applies>   | <resulting credential>          |
| 2 | <header / config key>        | <when it applies>   | <resulting credential>          |

## Invariants

- <Any non-obvious rule, e.g. "header credentials override config defaults".>

## Configuration

```yaml
<auth-related config block with placeholder values>
```
```

---

## `readme-docs/deployment.md`

Use when the project ships a real deployment story (container, CI/CD, cloud target).

```markdown
# Deployment

How to deploy <Project> to a real environment.

## Build artifact

```bash
<build / package command>
```

## Container

```dockerfile
<or reference the project's Dockerfile and the key build/run args>
```

```bash
docker build -t <image> .
docker run -p <PORT>:<PORT> --env-file .env <image>
```

## Environment

| Variable     | Required | Description           |
|--------------|----------|-----------------------|
| `<ENV_VAR>`  | yes/no   | <what it controls>    |

## Health & observability

<Health endpoint, metrics, logs — whatever the project exposes.>
```

---

## `readme-docs/troubleshooting.md`

Use when there are recurring, diagnosable failure modes worth documenting.

```markdown
# Troubleshooting

Common problems and their fixes.

## <Symptom / error message>

**Cause:** <why it happens.>

**Fix:**

```bash
<command or steps>
```

Repeat per known issue. Quote error messages verbatim so readers can search for them.
```

---

## `readme-docs/debugging.md`

Use when the project has a structured logging / debug-flag mechanism.

```markdown
# Debug Logging

How to turn on verbose diagnostics in <Project>.

<One line on the mechanism, e.g. the `DEBUG` environment variable with namespaces.>

| Namespace / flag    | What it logs                          |
|---------------------|---------------------------------------|
| `<namespace>`       | <what it shows>                       |
| `<namespace>`       | <what it shows>                       |

Examples:

```bash
<command to enable a single namespace>
<command to enable several>
```
```

---

## `readme-docs/testing.md`

Use when the testing story is more than a single `test` command.

```markdown
# Testing

How <Project> is tested and how to run the suites.

## Running tests

```bash
<unit test command>
<integration test command>
<coverage command>
```

## Test layout

<Where tests live and how they are organised.>

## Writing tests

<Conventions, fixtures, and any helpers contributors should know about.>
```

---

## Project-specific satellite template

For capabilities unique to a project (a custom algorithm, caching strategy, batch limits, format
conversion, plugin system, etc.), compose a satellite with this shape:

```markdown
# <Feature Name>

<One-sentence summary — the feature opened standalone still makes sense.>

## Overview

<Why it exists. What problem it solves.>

## How it works

<Mechanism. Diagrams or pseudocode as needed. Reference the relevant source path.>

## Configuration

```yaml
<relevant config block with placeholder values>
```

## Examples

<One or two minimal, runnable examples.>

## Caveats

<Limits, failure modes, invariants.>
```
