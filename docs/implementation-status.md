# Implementation Status

This file is the project-level snapshot for the documentation in `docs/proj/`. It is intentionally short: exact behavior
is verified by code and tests, not by duplicated checklists in Markdown.

## Documentation Layout

- Core concepts: [proj/core/README.md](proj/core/README.md)
- Telegram adapter: [proj/telegram/telegram-bot.md](proj/telegram/telegram-bot.md)
- Admin interface: [proj/admin/admin-interface.md](proj/admin/admin-interface.md)
- Operations: [proj/ops/sync-local-db-to-remote.md](proj/ops/sync-local-db-to-remote.md)
- Documentation rules: [proj/documentation-principles.md](proj/documentation-principles.md)

## Current Implementation Summary

| Area | Status | Primary owners |
| --- | --- | --- |
| Core agent loop | Implemented | `../src/agent.js`, `../src/llm.js`, `../src/pipeline/` |
| Personal memory | Implemented | `../src/pipeline/facts.js`, `../src/pipeline/retrieve.js` |
| Secure memory | Implemented | `../src/pipeline/secure.js`, `../src/pipeline/agent-tools/secure-record-get.js` |
| History compression | Implemented | `../src/pipeline/history-context.js`, `../src/pipeline/history-compress.js` |
| Scheduler and reminders | Implemented | `../src/pipeline/scheduler.js`, `../src/scheduler-run.js` |
| Proactivity | Implemented | `../src/pipeline/proactive*.js`, `../src/pipeline/events.js` |
| Global facts and knowledge | Implemented | `../src/pipeline/global-memory.js`, `../src/pipeline/embedding-repair.js` |
| Skills and authoring | Implemented | `../src/pipeline/skills/`, `../src/pipeline/agent-tools/skill-authoring/` |
| Telegram adapter | Implemented | `../src/telegram/`, `../src/voice/` |
| Admin web interface | Implemented | `../src/server/`, `../web/src/` |
| Notes subsystem | Implemented | `../src/notes/`, `../src/notes-mcp/`, `../web/src/components/notes/` |
| LLM and agent logging | Implemented | `../src/pipeline/llm-log.js`, `../src/pipeline/agent-event-log.js` |
| Tests | Implemented | `../tests/run.js`, `../tests/*.test.mjs` |

## Verification Entry Points

- Script index: `../package.json`
- Broad behavioral suite: `../tests/run.js`
- Focused tests: `../tests/*.test.mjs`
- Schema owner: `../migrations/001_init.sql`
- Runtime configuration: `../config/default.yaml`

## Documentation Model

The active documentation model is explanation plus source links. SQL, prompts, route lists, tool schemas, configuration
defaults, and test matrices are owned by code, configuration, migrations, and tests rather than copied into Markdown.
