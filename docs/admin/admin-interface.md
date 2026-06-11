# Admin Interface: Combined Web Server and Vue Front-End

This documentation for the administrative interface is bound by the rules in
[00-documentation-principles.md](00-documentation-principles.md). It covers the combined web server
(`src/server/`) and the Vue front-end (`web/`), and how they surface the AI bot's data and programmatic API to an
operator. Business logic of the bot core itself lives in the specification (`docs/ai-bot-with-memory/`); the
Telegram channel lives in `docs/telegram/`.

## Process Model

The admin interface and the Telegram channel run as **one Node.js process on a single event loop**. The combined
entry point `src/server/index.js` first starts the HTTP server, then brings the Telegram channel up by calling
`startTelegram()` from `src/telegram/bot.js`. Both services are I/O-bound — the web server handles requests, the
channel runs long polling and the background worker — so they share the event loop without interfering, and no
CPU-bound work blocks either of them. The same process therefore serves the operator UI, answers the admin JSON
API, polls Telegram for incoming messages, and runs the scheduler, proactivity, and delivery-queue loops.

The Telegram adapter can also run on its own with `npm run telegram`; that standalone mode and the channel's own
transport details are described in `docs/telegram/telegram-bot.md`. This document describes the combined server
started with `npm run server`.

## Startup and Shutdown

The combined server starts with `npm run server`. It binds to `config.admin.host` and `config.admin.port`
(defaults `localhost` and `9019`), prints the listening address, then starts the Telegram channel and reports the
bot username. Because the channel is started, the process requires `config.telegram.apiKey`; without the token the
startup aborts, exactly as in standalone Telegram mode. After the channel is up, the server starts two background
maintenance loops: the age-based cleanup of the journals in the logs database (`startLogRetention` from
`src/pipeline/log-retention.js`): one pass immediately and then once a day, with thresholds from
`config.llmLog.retention`; and the recompute of missing knowledge-base embeddings (`startEmbeddingRepair` from
`src/pipeline/embedding-repair.js`): one pass immediately and then on the
`config.globalMemory.embeddingRepairIntervalMs` interval, gated by `config.globalMemory.embeddingRepairEnabled`
and `ragEnabled` (the repair semantics are specified in `docs/ai-bot-with-memory/14-global-memory.md`,
section [GLOB-4]).

On a stop signal (`SIGINT` or `SIGTERM`) the server shuts down gracefully and in a fixed order so that the shared
database connection pool is closed exactly once. It first stops the retention and embedding-repair timers, then
stops accepting HTTP requests (`server.close`), then calls `stopTelegram()` to halt the polling and
background-worker loops and release the delivery-queue listener, and only then closes the database connection
pool. A second stop signal received while shutdown is already in progress is ignored.

## Backend: Express Server

The HTTP layer is built on Express in `src/server/index.js`:

- **JSON body parsing** is enabled for request bodies up to 1 MB.
- **The admin JSON API** is mounted under the `/api` prefix from the router built by `createAdminApi()` in
  `src/server/admin-api.js`.
- **Static assets** of the built front-end are served from `web/dist`.
- **Single-page-application fallback**: any non-API `GET` request that does not match a static file returns
  `web/dist/index.html`, so the Vue router handles in-app navigation on the client and a reload of a nested page
  does not produce a 404. If the front-end has not been built yet, the fallback returns HTTP 503 with a plain-text
  message that points to `npm run web:build` (production build) or `npm run web:dev` (Vite dev server). Requests
  whose path starts with `/api` are excluded from the fallback so that an unknown API route is not shadowed by the
  SPA page.

### Admin JSON API

The API router is a thin layer over data-access functions: the memory pages reuse `src/sandbox/data.js` (the same
code that backs the memory sandbox), and the log-viewer pages are served by `src/server/llm-log-data.js` and
`src/server/log-analysis.js`. The router itself carries no business logic. Every handler is wrapped so that a
thrown error becomes a JSON response with HTTP status 500 and an `error` field carrying a human-readable message,
and the failure is logged on the server.

| Method and path | Purpose | Backing function |
|-----------------|---------|------------------|
| `GET /api/health` | liveness probe for the front-end and monitoring | — |
| `GET /api/users` | list all users for the sidebar | `listUsers()` |
| `GET /api/users/:id/memory` | all active memory of a user, grouped by category | `getUserMemory(id)` |
| `GET /api/users/:id/proactivity` | a user's proactivity state (master flag and triggers) | `getProactivity(id)` |
| `GET /api/users/search?q=` | user suggestions for the log page (name, external id, exact UUID) | `searchUsers(q)` |
| `GET /api/users/:id/timeline` | chat timeline: messages merged with service-call badges (`?before`, `?limit`) | `getTimeline()` |
| `GET /api/llm-log/cycle/:requestId` | journal of one dialog cycle: header with totals plus display rows | `getCycle()` |
| `GET /api/llm-log/request/:llmRequestId` | journal of a single service record (a badge without `request_id`) | `getSingleRequest()` |
| `POST /api/users/:id/chat-message` | send a message on behalf of the user through the full agent pipeline | `handleMessage()` |
| `GET /api/llm-log/analysis-config` | allowed analysis models and CLI preset names (commands are not exposed) | `analysisConfigPublic()` |
| `POST /api/llm-log/analyze` | AI analysis of a logged request, streamed as Server-Sent Events | `runAnalysis()` |
| `GET /api/domains` | agent domains (key and title) — options for the domain select of the knowledge form | `listDomains()` |
| `GET /api/knowledge` | knowledge-base records with `hasEmbedding` (`?status=` comma list, `deleted`, or `all`; default active+archived) | `listGlobalKnowledge()` |
| `POST /api/knowledge` | create a knowledge record; the embedding is computed immediately | `addGlobalKnowledge()` |
| `PUT /api/knowledge/:id` | update a record; a text change resets and recomputes the embedding; restoring from the bin is `status: 'active'` | `updateGlobalKnowledge()` |
| `DELETE /api/knowledge/:id` | soft delete (`status = 'deleted'`), the record moves to the recycle bin | `deleteGlobalKnowledge()` |
| `POST /api/knowledge/:id/embed` | manual embedding recompute; 503 when the embedding service is unavailable | `reembedGlobalKnowledge()` |

The `:id` parameter is the user's internal database identifier (the `id` field returned by `GET /api/users`), not
the external chat identifier. The memory response is grouped into the categories `profile`, `domain`, `dialog`,
`reminder`, and `secure`; the secure category carries only redacted summaries, never full protected values.

A knowledge-base record in API responses carries `id`, `title`, `content`, `domainKey` (`null` = all domains),
`tags`, `importance`, `status`, `source`, `hasEmbedding`, `createdAt`, and `updatedAt`. The embedding vector
itself is never sent to the client — the front-end only needs the `hasEmbedding` flag for the indicator and the
recompute button. Write requests validate the body (`content` is required, `importance` is a number from 0 to 1,
`status` is one of `active`/`archived`/`deleted`, an unknown `domainKey` is rejected) and answer 400 with a
human-readable message on violations.

## Frontend: Vue 3 + Vite

The operator UI lives in `web/` and is a Vue 3 single-page application built and served by Vite. The build is fast
enough that the development server starts almost instantly with hot module replacement, while the production build
emits static assets in well under a second, so functionality can be developed quickly.

The component library is PrimeVue 4 with the Aura theme in styled mode (dark mode is disabled); icons come from
`primeicons`. Markdown rendering uses `marked`, and every piece of untrusted content rendered as HTML or Markdown
passes through `DOMPurify` first.

Project layout:

| File | Role |
|------|------|
| `web/index.html` | HTML entry point that mounts the app into `#app` |
| `web/src/main.js` | creates the root Vue application, installs PrimeVue with the Aura preset, and mounts it |
| `web/src/App.vue` | root component with the section tabs: "Память" (user list plus selected user's memory), "Логи LLM", and "База знаний" |
| `web/src/api.js` | thin `fetch` wrapper over the `/api` endpoints with a readable error contract and the SSE client of the analysis stream |
| `web/src/styles.css` | base layout styles and the section tabs |
| `web/src/components/llm-log/` | the LLM log viewer page (components listed in the section below) |
| `web/src/components/knowledge/` | the knowledge-base page: the table (`KnowledgePage.vue`) and the record form dialog (`KnowledgeDialog.vue`) |
| `web/vite.config.js` | Vite configuration: the Vue plugin, the dev proxy, and the build output |
| `web/package.json` | front-end dependencies (`vue`, `primevue`, `@primeuix/themes`, `primeicons`, `marked`, `dompurify`) and dev tooling (`vite`, `@vitejs/plugin-vue`) |

The front-end talks to the backend through the relative path `/api`, which works in both run modes. In development
the Vite dev server (port 5173) proxies `/api` to the backend so the browser sees one origin without CORS setup;
the proxy target is `config.admin.port` (default `http://localhost:9019`) and is overridable with the
`VITE_API_TARGET` environment variable. In production the same Express server serves both the built front-end and
the API from one origin, so the relative path needs no change.

## LLM Log Viewer

The "LLM Logs" tab is the operator's window into the journals of the separate logs database (the data model is
specified in `docs/ai-bot-with-memory/05-data-schema.md`, section [DATA-12]; journaling behaviour and retention
in `10-operations.md`, section [OPS-5]). The page is split by a draggable splitter into a Telegram-style chat
pane on the left and the journal pane on the right, with a user search box on top. The guiding principle of the
whole page is **progressive disclosure**: every level shows a compact summary first and reveals detail on demand.

Components (`web/src/components/llm-log/`):

| Component | Role |
|-----------|------|
| `LlmLogPage.vue` | page frame: search on top, splitter with the two panes, the analysis dialog |
| `UserSearch.vue` | autocomplete over `GET /api/users/search` (by name, external id, or exact internal UUID) |
| `ChatPane.vue` | chat timeline with lazy upward loading and the send box |
| `LogPane.vue` | journal header (totals, expand/collapse all, "Ask AI") and the row list |
| `LogRow.vue` | one journal row: pastel colour by kind, icon with indent hierarchy, metrics, expansion |
| `PayloadView.vue` | progressive disclosure of a request body: parameter chips, `messages`, `tools` |
| `ContentViewer.vue` | content block with the JSON/MD/HTML/RAW format switch and auto-detection |
| `AnalyzeDialog.vue` | the AI-analysis dialog: engine choice, model or CLI preset, streamed result |

**Chat pane.** The timeline (`GET /api/users/:id/timeline`) merges two sources by time: dialog messages from the
memory database (bubbles with timestamps, user on the right, assistant on the left, day separators) and
**service badges** — compact pills between the bubbles for journal call groups whose `request_id` is not
referenced by any user message (history compression, proactivity, detached embeddings, and historical cycles
recorded before message metadata carried a `request_id`). Scrolling up lazily loads older pages (keyset
pagination by `?before`). Every user message whose metadata carries a `request_id` has a journal button; clicking
it — or a badge — loads the corresponding journal into the right pane. The input box at the bottom sends a
message on behalf of the user through the full agent pipeline (`POST /api/users/:id/chat-message`, channel
`admin`, plain-text replies); after the reply arrives, the timeline reloads and the fresh cycle's journal opens
automatically.

**Journal pane.** The header shows the cycle title, total tokens and cost, the models used, the overall
duration, an error marker, expand-all/collapse-all buttons, and the "Ask AI" button. The rows are assembled on
the server (`buildCycleRows` in `src/server/llm-log-data.js`) by merging `log.llm_request` records with
`log.agent_event` events by time: stage events become collapsible group headers ("intent classification", "model
answer — iteration N", a synthetic "post-processing" group for fact and topic extraction), each journal record
becomes a request/response row pair (the request row is placed at the call's start time — record time minus
duration), and tool calls appear with their arguments, results, and durations from the events. For historical
cycles recorded without agent events, the tool chain degrades gracefully to synthesis from the stored payloads
and replies. Each row carries a pastel background by its kind, an indent expressing hierarchy, per-row tokens,
cost, model, and duration; error rows are pink and show the error text. A truncation notice appears when the
stored payload or reply was clipped at `config.llmLog.maxPayloadChars`.

**Progressive disclosure of a request body.** An expanded request row shows three zones: scalar parameters as
chips (model, temperature, and the like); the `messages` array as one line per message (role chip, first
characters of the content, length), where a click expands short content inline and opens a full-screen dialog
for content over two thousand characters; and the `tools` array as one line per tool (name plus the first words
of the description), where the first click reveals the full description and a separate button shows the JSON
Schema of the parameters. Every content block is a `ContentViewer`: a floating format switch in its corner
offers JSON (pretty-printed with highlighting), MD, HTML, and RAW, with the initial format auto-detected from
the content; RAW is always available, and a copy button sits beside the switch.

**AI analysis.** The "Ask AI" button opens a dialog whose context is the cycle's last main-answer request (its
stored body and reply). Two engines are available. The *project LLM* engine calls the bot's own model through
the standard client with a model chosen from the allow-list `config.admin.logAnalysis.llm.models`; the analysis
call is itself journaled under its own `request_id` with the kind `log_analysis`, so it never mixes into the
cycle being analysed. The *CLI tool* engine spawns a preset command from `config.admin.logAnalysis.cli.presets`
(for example, `claude -p`) in the project root, feeding the prompt through stdin — this gives the analyser
visibility of the project code. The command comes exclusively from the configuration; the client only names a
preset. Because this engine executes a command on the server, it is accepted **only when
`config.admin.host` is `localhost`** — otherwise the server answers 403 and the front-end shows the engine as
unavailable. In both engines the result streams into the dialog as Server-Sent Events and renders as Markdown.

## Knowledge Base Tab

The "База знаний" tab is a full CRUD interface over the shared knowledge base (`mem.global_knowledge` — the
business rules of the layer live in `docs/ai-bot-with-memory/14-global-memory.md`). The page is full-width, with
a toolbar above the table: the "Добавить запись" button, the record counter, and a clickable "⚠ без эмбеддинга:
N" indicator that toggles a filter showing only records without a vector.

**Table.** A PrimeVue `DataTable` (`size="small"`, `removable-sort`, `striped-rows`, `filter-display="row"`, a
paginator from 50 rows). The base is small, so the whole list — including the recycle bin — is loaded at once
with `GET /api/knowledge?status=all`, and sorting, filtering, and pagination run on the client. Columns: the
embedding badge ("✓" or "⚠ нет" with a recompute button; select filter all/есть/нет), title and content (text
contains-filters; the content cell shows the first ~160 characters, the full text lives in the form dialog),
domain (multiselect over values present in the data; `null` is rendered as "все домены"), tags (chips;
multiselect with a custom array-intersection filter), importance, status (multiselect; **defaults to
active+archived**, so deleted records are hidden until the operator explicitly selects `deleted` — that selection
is the recycle bin), source (text filter), updated-at (default sort, descending), and the actions column
(edit, delete). Deleting asks for confirmation with the native `confirm()` and performs the soft delete; the row
stays in memory with `status = 'deleted'` and disappears from the default view by the status filter. Restoring a
record is done in the form dialog by switching the status back to `active`.

**Record form.** Creating and editing share `KnowledgeDialog.vue` — a custom dialog (teleported to `body`,
overlay, ESC to close) that is **resizable from all four sides and corners** by mouse, following the same
eight-handle pattern as the content dialog of the log viewer; the size persists in `localStorage` under
`knowledge.dialog.size` (minimum 520×360). The content textarea stretches with the dialog — the main reason it is
resizable. Fields: title, content (required), domain (select fed by `GET /api/domains` plus "все домены"), tags
(chips input), importance (number 0–1), source, status. The footer shows the embedding state — "будет пересчитан
после сохранения" when the text changed, "актуален" when it did not — and the save/cancel buttons. After saving,
the server answers with the fresh record: when the embedding service is up the row immediately shows "✓"; when
it is down the row shows "⚠ нет" with the manual recompute button, and the background repair pass fills the
vector in later.

## Configuration

| Path | Environment variable | Default | Meaning |
|------|----------------------|---------|---------|
| `config.admin.host` | `ADMIN_HOST` | `localhost` | address the web server binds to (`0.0.0.0` to expose on all interfaces) |
| `config.admin.port` | `ADMIN_PORT` | `9019` | TCP port of the web server |
| `config.admin.logAnalysis.llm.models` | — | `['gpt-5.4-mini', 'gpt-5.4']` | allow-list of models offered by the analysis dialog |
| `config.admin.logAnalysis.llm.defaultModel` | — | `gpt-5.4-mini` | model preselected in the analysis dialog |
| `config.admin.logAnalysis.cli.presets` | — | `claude -p` preset | CLI presets: `name`, `command`, `args`, `timeoutSec` |
| `config.admin.logAnalysis.cli.maxOutputChars` | — | `200000` | CLI output cap; the stream is cut with a notice beyond it |

The journals themselves (the logs database connection, buffer sizes, payload truncation, and retention
thresholds) are configured under `config.db.postgres.dbs.logs` and `config.llmLog`, which belong to the bot core
and are described in the specification ([OPS-5]). The knowledge-base layer and the background embedding repair
(`config.globalMemory.*`, including `embeddingRepairEnabled` and `embeddingRepairIntervalMs`) also belong to the
core and are specified in `docs/ai-bot-with-memory/14-global-memory.md`, section [GLOB-9].

## Run Workflows

The root `package.json` provides the commands for both modes.

The repository is an npm workspace: the root `package.json` declares `"workspaces": ["web"]`, so a single
`npm install` at the root installs both the backend dependencies and the front-end dependencies (`web/`) at once,
hoisting shared packages into the root `node_modules`. The front-end keeps its own `web/package.json`, so ownership
of front-end versus backend dependencies stays clear, but there is only one install command and one install step.

**Development** (fast iteration with hot module replacement), in two terminals:

```
npm install           # once: installs backend and front-end dependencies via the workspace
npm run server        # backend API on :9019 plus the Telegram channel in one process
npm run web:dev       # Vite dev server on :5173, proxying /api to :9019
```

The operator opens `http://localhost:5173`.

**Production** (everything from one origin), one process:

```
npm run web:build     # build the Vue app into web/dist
npm run server        # Express serves web/dist and the API, with the Telegram channel alongside
```

The operator opens `http://localhost:9019`.

## Access Control

The interface has no authentication layer of its own. Access is limited by the bind address: with the default
`config.admin.host` of `localhost`, the server is reachable only from the local machine. Exposing it on a network
(`config.admin.host = 0.0.0.0`) places it behind whatever external access control the deployment provides. The
CLI engine of the log analysis is the one feature that does not follow the bind address: it executes a command
on the server, so the endpoint rejects it with 403 whenever `config.admin.host` is anything other than
`localhost`, regardless of where the request came from.
