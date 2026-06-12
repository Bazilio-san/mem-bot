# Admin Interface

The admin interface is the operator surface for the same bot state used by the core and Telegram adapter. It combines an
Express server, admin JSON APIs, notes APIs, the notes MCP endpoint, and a Vue front end.

Project documentation rules are in [../documentation-principles.md](../documentation-principles.md).

## Process Model

The combined server starts from `../../../src/server/index.js`. It serves the built Vue admin app, mounts admin auth,
admin data APIs, notes APIs, notes MCP, and the Mini App notes entry point. Configuration lives in
`../../../config/default.yaml`.

The server can also start background helpers such as log retention and embedding repair when their feature flags are
enabled.

## Authentication

Admin sign-in uses Telegram Login Widget data and an HMAC-signed session cookie. The exact validation, cookie shape,
session lifetime, and localhost rules belong to `../../../src/server/admin-auth.js` and configuration.

Admin authorization for memory and global-knowledge mutations is checked in the API and core helpers:

- Admin auth router: `../../../src/server/admin-auth.js`
- Admin API router: `../../../src/server/admin-api.js`
- Core admin helpers: `../../../src/pipeline/admin.js`
- Telegram Mini App init validation for notes: `../../../src/notes/telegram-init-data.js`

## Operator Areas

- **Users and memory:** user list, selected user details, memory groups, proactivity state, and deletion operations.
- **Chat timeline and live chat:** recent messages, request cycles, and server-sent chat events.
- **LLM logs:** request list, payload inspection, response inspection, usage, cycle grouping, and optional AI analysis.
- **Shared knowledge:** create, edit, archive, search, and re-embed global knowledge fragments.
- **Notes widget:** user-owned note management through the same notes API used by the Mini App.

Frontend owners:

- App shell and user-memory view: `../../../web/src/App.vue`
- API client: `../../../web/src/api.js`
- LLM log UI: `../../../web/src/components/llm-log/`
- Knowledge UI: `../../../web/src/components/knowledge/`
- Notes UI: `../../../web/src/components/notes/`
- Styling: `../../../web/src/styles.css`

## Backend API Map

Route definitions are source of truth:

- Admin data and mutations: `../../../src/server/admin-api.js`
- Auth routes: `../../../src/server/admin-auth.js`
- Chat event stream: `../../../src/server/chat-events.js`
- LLM log data: `../../../src/server/llm-log-data.js`
- Log analysis streaming: `../../../src/server/log-analysis.js`
- Notes REST API: `../../../src/server/notes-api.js`
- Notes MCP endpoint: `../../../src/notes-mcp/server.js`

Do not duplicate endpoint lists here; use the files above for exact paths, methods, parameters, and responses.

## Core Boundaries

The admin UI displays and mutates state; it does not define memory, proactivity, logging, or shared-knowledge business
rules. Those concepts are documented in:

- [../core/06-memory.md](../core/06-memory.md)
- [../core/09-proactivity.md](../core/09-proactivity.md)
- [../core/10-operations.md](../core/10-operations.md)
- [../core/14-global-memory.md](../core/14-global-memory.md)
- [../core/15-notes.md](../core/15-notes.md)
