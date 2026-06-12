# 05. Data Schema

The authoritative schema is SQL, not this document. Use `../../../migrations/001_init.sql` for table definitions,
indexes, enum values, generated columns, vector indexes, and idempotent migration details.

## Conceptual Storage Areas

- **Users and conversations:** identity, Telegram profile synchronization, conversations, messages, external message
  references, and active conversation summaries.
- **Personal memory:** durable facts with scope, type, confidence, embeddings, status, retention, provenance, and
  deduplication metadata.
- **Secure memory:** encrypted records with redacted summaries and explicit consent access.
- **Scheduler and outbox:** scheduled tasks, task runs, pending notifications, and retry metadata.
- **Proactivity:** topic mentions, trigger settings, event deliveries, and contact-policy state.
- **Global memory:** shared facts and shared knowledge fragments with embeddings and status.
- **Logs:** LLM request logs, usage-cost logs, and agent event logs in the separate logs database.
- **Notes:** user notes with title/body embeddings, full-text search, tags, pinning, and soft deletion.

## Code Owners

- General persistence helpers: `../../../src/repo.js`
- Database pools, listeners, and vector formatting: `../../../src/db.js`
- Migration runner: `../../../src/migrate.js`
- Personal memory writes: `../../../src/pipeline/facts.js`
- Scheduler storage operations: `../../../src/pipeline/scheduler.js`
- Global memory and knowledge storage: `../../../src/pipeline/global-memory.js`
- Notes storage: `../../../src/notes/store.js`
- LLM and agent-event log writers: `../../../src/pipeline/llm-log.js`,
  `../../../src/pipeline/agent-event-log.js`, `../../../src/pipeline/log-writer.js`

## Documentation Rule

Do not copy DDL into documentation. When a schema-level change matters, explain the concept here and point to the
migration that owns the exact SQL.
