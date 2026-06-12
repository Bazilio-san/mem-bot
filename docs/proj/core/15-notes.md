# 15. User Notes

Notes are user-owned long-form text items with semantic and full-text search. They are a separate subsystem from memory:
memory is model-curated facts, while notes are user-authored material.

## Surfaces

- The core storage and search layer powers all note access.
- The notes MCP server exposes notes to MCP clients and the agent context.
- The web widget provides create, edit, search, pin, delete, and restore operations.
- Telegram can open the widget as a Mini App when a public HTTPS URL is configured.

## Code Owners

- Storage, validation, embeddings, pagination, and hybrid search: `../../../src/notes/store.js`
- Note events in conversation history: `../../../src/notes/events.js`
- Widget token issue and verification: `../../../src/notes/widget-token.js`
- Telegram Mini App init-data validation: `../../../src/notes/telegram-init-data.js`
- REST API: `../../../src/server/notes-api.js`
- MCP server: `../../../src/notes-mcp/server.js`
- Web widget: `../../../web/src/components/notes/`
- Mini App entry point: `../../../web/src/miniapp-notes.js`, `../../../web/miniapp/notes.html`
- Schema and indexes: `../../../migrations/001_init.sql`

## Search Model

Notes search merges vector relevance with full-text relevance. The implementation owns limits, thresholds, cursor
encoding, deleted-note behavior, and embedding truncation. Configuration is in `../../../config/default.yaml`.

## Verification

Notes behavior is covered by `../../../tests/notes-store.test.mjs`, `../../../tests/notes-api.test.mjs`, and
`../../../tests/notes-mcp.test.mjs`.
