# 12. Reference Map

Use this map when looking for the source of a behavior.

## External References

- OpenAI-compatible API behavior is wrapped by `../../../src/llm.js`.
- PostgreSQL and pgvector schema is owned by `../../../migrations/001_init.sql`.
- Telegram channel behavior is in [../telegram/telegram-bot.md](../telegram/telegram-bot.md).
- Admin UI behavior is in [../admin/admin-interface.md](../admin/admin-interface.md).

## Internal Code Map

- Agent loop: `../../../src/agent.js`
- Persistence helpers: `../../../src/repo.js`, `../../../src/db.js`
- Pipeline modules: `../../../src/pipeline/`
- Channel adapters: `../../../src/telegram/`, `../../../src/server/`
- Notes subsystem: `../../../src/notes/`, `../../../src/notes-mcp/`, `../../../web/src/components/notes/`
- Admin frontend: `../../../web/src/`
- Config: `../../../config/`
- Tests: `../../../tests/`
