# 03. Quick Start and Project Shape

This document gives the mental model for running the project. Exact commands, package versions, and script names are
owned by `../../../package.json`.

## Runtime Requirements

The project is a Node.js application with PostgreSQL and pgvector. The main service, Telegram adapter, scheduler, and
admin web server are separate entry points that share the same source modules and configuration.

Configuration owners:

- Defaults and comments: `../../../config/default.yaml`
- Environment variable mapping: `../../../config/custom-environment-variables.yaml`
- Local override example: `../../../config/local.example.yaml`
- Migration entry point: `../../../src/migrate.js`
- Database connection validation: `../../../src/db.js`

## Main Entry Points

- Core CLI chat: `../../../src/cli.js`
- Combined server and admin UI: `../../../src/server/index.js`
- Telegram bot process: `../../../src/telegram/bot.js`
- Scheduler process: `../../../src/scheduler-run.js`
- Migrations: `../../../src/migrate.js`
- Skills CLI: `../../../src/pipeline/skills/cli.js`

## Directory Map

- `../../../src/pipeline/` contains the agent's reusable behavior layers.
- `../../../src/pipeline/agent-tools/` contains model-callable tools.
- `../../../src/telegram/` contains the Telegram adapter.
- `../../../src/server/` contains the admin and notes HTTP APIs.
- `../../../src/notes/` and `../../../src/notes-mcp/` contain the user notes subsystem.
- `../../../web/src/` contains the Vue admin UI and notes widget.
- `../../../migrations/` owns SQL schema changes.
- `../../../tests/` owns executable behavior checks.

## Build Order

For development or review, follow the dependency order: configuration, migrations, core pipeline, adapters, UI, tests.
Do not copy command lists into this document; use `../../../package.json` as the script index.
