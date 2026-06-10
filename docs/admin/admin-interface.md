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
(defaults `localhost` and `3001`), prints the listening address, then starts the Telegram channel and reports the
bot username. Because the channel is started, the process requires `config.telegram.apiKey`; without the token the
startup aborts, exactly as in standalone Telegram mode.

On a stop signal (`SIGINT` or `SIGTERM`) the server shuts down gracefully and in a fixed order so that the shared
database connection pool is closed exactly once. It first stops accepting HTTP requests (`server.close`), then
calls `stopTelegram()` to halt the polling and background-worker loops and release the delivery-queue listener,
and only then closes the database connection pool. A second stop signal received while shutdown is already in
progress is ignored.

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

The API router is a thin layer over the existing data-access functions in `src/sandbox/data.js`, so the admin
interface reuses the same code that backs the memory sandbox and carries no separate business logic of its own.
Every handler is wrapped so that a thrown error becomes a JSON response with HTTP status 500 and an `error` field
carrying a human-readable message, and the failure is logged on the server.

| Method and path | Purpose | Backing function |
|-----------------|---------|------------------|
| `GET /api/health` | liveness probe for the front-end and monitoring | — |
| `GET /api/users` | list all users for the sidebar | `listUsers()` |
| `GET /api/users/:id/memory` | all active memory of a user, grouped by category | `getUserMemory(id)` |
| `GET /api/users/:id/proactivity` | a user's proactivity state (master flag and triggers) | `getProactivity(id)` |

The `:id` parameter is the user's internal database identifier (the `id` field returned by `GET /api/users`), not
the external chat identifier. The memory response is grouped into the categories `profile`, `domain`, `dialog`,
`reminder`, and `secure`; the secure category carries only redacted summaries, never full protected values.

## Frontend: Vue 3 + Vite

The operator UI lives in `web/` and is a Vue 3 single-page application built and served by Vite. The build is fast
enough that the development server starts almost instantly with hot module replacement, while the production build
emits static assets in well under a second, so functionality can be developed quickly.

Project layout:

| File | Role |
|------|------|
| `web/index.html` | HTML entry point that mounts the app into `#app` |
| `web/src/main.js` | creates the root Vue application and mounts it |
| `web/src/App.vue` | root component: "user list on the left, selected user's memory on the right" |
| `web/src/api.js` | thin `fetch` wrapper over the `/api` endpoints with a readable error contract |
| `web/src/styles.css` | base layout styles |
| `web/vite.config.js` | Vite configuration: the Vue plugin, the dev proxy, and the build output |
| `web/package.json` | front-end dependencies (`vue`) and dev tooling (`vite`, `@vitejs/plugin-vue`) |

The front-end talks to the backend through the relative path `/api`, which works in both run modes. In development
the Vite dev server (port 5173) proxies `/api` to the backend so the browser sees one origin without CORS setup;
the proxy target is `config.admin.port` (default `http://localhost:3001`) and is overridable with the
`VITE_API_TARGET` environment variable. In production the same Express server serves both the built front-end and
the API from one origin, so the relative path needs no change.

## Configuration

| Path | Environment variable | Default | Meaning |
|------|----------------------|---------|---------|
| `config.admin.host` | `ADMIN_HOST` | `localhost` | address the web server binds to (`0.0.0.0` to expose on all interfaces) |
| `config.admin.port` | `ADMIN_PORT` | `3001` | TCP port of the web server |

## Run Workflows

The root `package.json` provides the commands for both modes.

The repository is an npm workspace: the root `package.json` declares `"workspaces": ["web"]`, so a single
`npm install` at the root installs both the backend dependencies and the front-end dependencies (`web/`) at once,
hoisting shared packages into the root `node_modules`. The front-end keeps its own `web/package.json`, so ownership
of front-end versus backend dependencies stays clear, but there is only one install command and one install step.

**Development** (fast iteration with hot module replacement), in two terminals:

```
npm install           # once: installs backend and front-end dependencies via the workspace
npm run server        # backend API on :3001 plus the Telegram channel in one process
npm run web:dev       # Vite dev server on :5173, proxying /api to :3001
```

The operator opens `http://localhost:5173`.

**Production** (everything from one origin), one process:

```
npm run web:build     # build the Vue app into web/dist
npm run server        # Express serves web/dist and the API, with the Telegram channel alongside
```

The operator opens `http://localhost:3001`.

## Access Control

The interface has no authentication layer of its own. Access is limited by the bind address: with the default
`config.admin.host` of `localhost`, the server is reachable only from the local machine. Exposing it on a network
(`config.admin.host = 0.0.0.0`) places it behind whatever external access control the deployment provides.
