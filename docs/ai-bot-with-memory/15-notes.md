# 15. User Notes with a Semantic Search Widget

## [NOTES-1] Purpose and Shape of the Subsystem

The bot keeps personal user notes: short free-form records with an optional title, a required body, tags, and a
"pinned" flag. Notes are strictly per-user: every storage and API operation filters by the owner, so one user can
never read or modify another user's notes. The subsystem has three faces that share one data layer
(recommended module `src/notes/store.js`):

1. **LLM tools** — the agent creates, edits, deletes, restores, and searches notes on the user's request.
2. **An interactive widget** — when the user asks to *see* their notes, the agent shows a list UI with search,
   lazy loading, and full editing. The widget fetches data itself through a dedicated REST API; the LLM history
   receives only meta-information ("the widget was shown, N notes total"), never the note bodies.
3. **Widget-initiated meta-events** — every mutation the user performs inside the widget is written back into the
   dialogue history as a short system message, so on the next turn the agent knows what happened.

## [NOTES-2] Storage and Embeddings

Notes live in the `mem.notes` table (see the data schema document, section [DATA-13]). Two embedding columns are
maintained per note — one for the title and one for the body — computed with the project-wide embedding model
(`config.llm.embedModel`) through the shared `embed()` function. Search takes the best (smallest) of the two
cosine distances, so a short precise title is not diluted by a long body.

Limits: the body is at most 20 000 characters (`NOTE_BODY_MAX`), the title at most 400; only the first
8 000 characters of the body are embedded (`EMBED_BODY_CHARS`). Embeddings are best effort: if the provider
fails, the note is still saved with NULL embeddings and remains reachable through the full-text branch.

Deletion is soft: `deleted_at` is set, the row stays, and `restoreNote` (the `note_restore` tool, the
`POST /api/notes/:id/restore` route, and the "undo" button of the widget) clears it.

## [NOTES-3] Hybrid Search

A search query runs two branches and fuses them with Reciprocal Rank Fusion:

- **vector branch** — cosine distance (`<=>`, HNSW indexes) between the query embedding and
  `LEAST(title_embedding <=> q, body_embedding <=> q)`, cut off at `config.notes.search.vectorThreshold`;
- **full-text branch** — `search_tsv @@ plainto_tsquery('russian', q)` ranked by `ts_rank`; the tsvector weights
  the title higher (`A`) than the body (`B`).

RRF: `score = wV/(K + rankV) + wF/(K + rankF)` with `K = config.notes.search.rrfK`, weights
`vectorWeight`/`fulltextWeight`. A note found by both branches outranks single-branch hits. The browse feed
(no query) uses keyset pagination over `(pinned DESC, updated_at DESC, id DESC)`; search results use offset
pagination inside the fused set.

## [NOTES-4] Notes MCP Server and MCP Apps

The note tools are exposed to the agent through the project's own MCP server (recommended module
`src/notes-mcp/server.js`), mounted as a stateless Streamable HTTP endpoint (`config.notes.mcpPath`) on the same
process as the HTTP server and registered in the MCP client configuration under the `notes` alias, so the model
sees `notes__note_create`, `notes__note_update`, `notes__note_delete`, `notes__note_restore`,
`notes__notes_search`, and `notes__notes_show_widget`.

The endpoint is reserved for the co-located agent. A request is treated as external when it carries an
`X-Forwarded-For` header (it arrived through a reverse proxy) or its socket address is not a loopback one
(`127.0.0.1`, `::1`). An external request is accepted only when it presents `config.notes.mcpSecret` in the
`X-Notes-Mcp-Secret` header; with no secret configured every external request is rejected with HTTP 403. The
local agent connects to `localhost` directly — no proxy, no header — and therefore needs no configuration.

Two MCP-client extensions make this safe and universally available:

- **`forwardUserContext`** (per-server flag in the MCP configuration) — the client forwards
  `userId`/`conversationId` of the current turn in the `_meta` of every `tools/call`. The server takes the
  caller identity from `_meta` only; it is never a model-controlled argument, so the model cannot address
  another user's notes.
- **`baseTools`** (per-server flag) — the server's tools are treated as base tools, available under any active
  skill, exactly like the built-in memory and scheduler tools. Without it MCP tools are domain tools visible
  only when the active skill lists them.

`notes_show_widget` is an MCP Apps tool: its definition carries `_meta.ui.resourceUri = "ui://notes/widget.html"`,
and the server registers that UI resource (`mimeType: text/html;profile=mcp-app`). The project's own surfaces
render the widget natively and do not use the resource; it exists so spec-compliant external MCP Apps hosts can
render the widget their own way.

The text result of `notes_show_widget` is deliberately meta-only ("the widget was shown, N notes total") — that is
what enters the LLM history. The widget descriptor travels in `structuredContent.widget`:

```json
{ "type": "notes", "dataUrl": "/api/notes", "token": "<widget token>", "query": "", "total": 2,
  "miniAppUrl": "<public widget page URL or null>" }
```

The agent stores descriptors of the turn in the assistant message metadata (`metadata.widgets`), and each delivery
channel decides how to materialise them (an inline component, a button opening a separate page, etc.).

## [NOTES-5] Widget REST API and Authorization

The widget works through its own REST API (recommended module `src/server/notes-api.js`, mounted at `/api/notes`):

| Route | Action |
| --- | --- |
| `GET /api/notes?cursor=&limit=&q=&tag=` | feed / hybrid search with lazy pagination (`{items, nextCursor, total}`) |
| `GET /api/notes/:id` | one note |
| `POST /api/notes` | create (`{title, body, tags}`) |
| `PATCH /api/notes/:id` | partial update (`{title?, body?, tags?, pinned?}`) |
| `DELETE /api/notes/:id` | soft delete |
| `POST /api/notes/:id/restore` | undo a soft delete |

Authorization (every request, two equal mechanisms):

1. **Widget token** — `Authorization: Bearer <token>`. `notes_show_widget` issues a short-lived self-contained
   HMAC token (`src/notes/widget-token.js`): base64url payload `{userId, conversationId, exp}` plus an
   HMAC-SHA256 signature with `config.notes.widgetSecret` (falling back to `config.authSecret`); TTL is
   `config.notes.widgetTokenTtlHours`. No session table is needed.
2. **Channel-native identity proof** — a delivery channel may authenticate its embedded widget page with its own
   signed payload mapped onto `mem.users.external_id` (for example, a messenger's signed init data). The concrete
   mechanism is described in the channel's documentation.

## [NOTES-6] Widget Meta-Events in the Dialogue History

Every successful mutation through the widget REST API writes one system message into
`mem.conversation_messages` (recommended module `src/notes/events.js`), e.g.
`[notes] Пользователь отредактировал заметку #12 «Покупки» через виджет: изменено — текст, теги.` with
`metadata = {source: 'notes_widget', action, note_id, changed}`. The conversation is the one carried by the
widget token; without it the user's active conversation is used. The agent therefore learns what the user did in
the widget on the next turn without the note data itself ever flooding the context. A failed meta-event write
never breaks the CRUD operation it describes.

## [NOTES-7] Configuration

```yaml
notes:
  enabled: true            # master switch of the whole subsystem
  mcpPath: '/mcp/notes'    # MCP endpoint path on the HTTP server
  mcpSecret: ''            # X-Notes-Mcp-Secret for external MCP callers (empty = local-only access)
  publicUrl: ''            # public https URL for channel-embedded widget pages (empty = none)
  search:
    vectorThreshold: 0.72  # max cosine distance counted as a semantic match
    rrfK: 60
    vectorWeight: 0.7
    fulltextWeight: 0.3
  widgetSecret: ''         # HMAC secret of widget tokens (falls back to authSecret)
  widgetTokenTtlHours: 24
```

## [NOTES-8] Test Layer

Three deterministic suites cover the subsystem against a real database with a stubbed embedding provider:

- `tests/notes-store.test.mjs` — validation, CRUD, user isolation, soft delete with undo, keyset pagination,
  hybrid search with RRF ranking, embedding-failure tolerance;
- `tests/notes-api.test.mjs` — both authorization mechanisms (token and signed channel payload), the full REST
  cycle, 401/404 isolation, meta-events in the history, the `notes.enabled` flag;
- `tests/notes-mcp.test.mjs` — a real MCP client over Streamable HTTP: tool listing with MCP Apps metadata,
  `_meta` identity forwarding, the CRUD cycle, widget token issuance, and the UI resource.
