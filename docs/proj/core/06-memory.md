# 06. Personal Memory

Personal memory turns selected dialogue facts into a durable, searchable, scoped context layer. It is separate from
conversation history: memory stores durable facts; history preserves the shape of the recent dialogue.

## Memory Model

Facts are ranked by semantic relevance, scope, confidence, recency, confirmation count, and explicit persistence. The
core distinguishes profile-level facts, domain-specific facts, dialog-open facts, preferences, goals, habits, emotional
patterns, activity rhythms, topic energy, and discovery seeds.

Exact fact types, thresholds, retention rules, schemas, and merge behavior are implemented in:

- Fact model and write pipeline: `../../../src/pipeline/facts.js`
- Retrieval and context formatting: `../../../src/pipeline/retrieve.js`
- Admin and user deletion helpers: `../../../src/pipeline/admin.js`
- Configuration defaults: `../../../config/default.yaml`
- Schema columns and indexes: `../../../migrations/001_init.sql`

## Retrieval

The active user message is embedded and matched against scoped facts. The result is minimized before it enters the
prompt so the model sees the most relevant facts without receiving the whole database.

Memory context belongs to `../../../src/pipeline/retrieve.js`; embedding calls belong to `../../../src/llm.js`.

## Writing and Deduplication

After a response, the system extracts candidate facts, filters low-confidence or unsafe items, embeds accepted facts,
then either confirms, replaces, inserts, or archives rows. Background sweeps clean accumulated near-duplicates.

The implementation owner is `../../../src/pipeline/facts.js`; the manual cleanup script is
`../../../scripts/memory-dedupe.js`.

## User Control

Users can ask the bot to list, search, forget, or pin memory. The callable tools live in
`../../../src/pipeline/agent-tools/memory/`. Admin-side deletion uses `../../../src/pipeline/admin.js` and the web API
in `../../../src/server/admin-api.js`.

## Secure Values

Sensitive values are stored as secure records, not as plain facts. See [07-secure-privacy.md](07-secure-privacy.md).
