# Project Documentation Principles

This document governs all project documentation under `docs/proj/`.

## Language

All project documentation is written in English. Runtime user-facing Russian strings may be described, but the
documentation text itself stays English.

## Source of Truth

Documentation explains concepts, architecture, boundaries, data flow, and operational intent. It does not duplicate
implementation details that already live in source files, configuration, migrations, tests, or package metadata.

When a detail is owned by code, link to the owning file instead of copying it. This rule applies to SQL DDL, route
lists, command lists, prompt text, JSON schemas, tool definitions, model names, configuration defaults, and test cases.

## Current State Only

Every document describes the current implementation state. Do not keep historical notes such as "previously",
"before", "after the refactor", or migration narratives unless the document is explicitly an operations runbook and the
history is necessary to execute the operation.

## Boundaries

`docs/proj/core/` describes channel-independent agent concepts. It may reference code in `src/agent.js`,
`src/pipeline/`, `src/repo.js`, `src/llm.js`, `migrations/`, `config/`, and `tests/`, but it should not explain
Telegram-specific rendering, button labels, or admin UI screens.

`docs/proj/telegram/` describes how Telegram presents and delivers the core behavior. It links back to the core docs
for business rules and links to `src/telegram/` for adapter details.

`docs/proj/admin/` describes the combined web server, admin API, and Vue admin UI. It links to the core docs for memory,
logging, and global knowledge semantics.

`docs/proj/ops/` contains operator runbooks. Runbooks may include commands when the command itself is the operating
procedure, but they should still link to scripts and configuration files instead of restating implementation contracts.

## Consistency Rules

Update all affected project documents in the same change. Keep cross-links relative and verify old paths after moving or
renaming documents. If source behavior changes, update the document that explains the concept and the document that
explains the channel or UI surface, when both are affected.

Keep Markdown lines at 120 columns or less, except URLs, tables, and code blocks.
