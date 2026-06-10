# MEM BOT

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](#license)
[![Node.js ≥ 20](https://img.shields.io/badge/node-%E2%89%A520-339933.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PostgreSQL + pgvector](https://img.shields.io/badge/PostgreSQL-pgvector-336791.svg?logo=postgresql&logoColor=white)](https://github.com/pgvector/pgvector)
[![Version 1.0.5](https://img.shields.io/badge/version-1.0.5-blue.svg)](package.json)

## Quick links

- [What the bot can do](#what-the-bot-can-do)
- [Installation and quick start](#installation-and-quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [Voice input and output](#voice-input-and-output)
- [Skills and domains](#skills-and-domains)
- [Memory and proactivity](#memory-and-proactivity)
- [MCP tools](#mcp-tools)
- [Development](#development)
- [Architecture and documentation](#architecture-and-documentation)

## Overview

MEM BOT is an agentic system: a language model, multi-level memory, and a set of tools.  
It calls tools, manages memory, sets reminders, and reads protected records — until it solves the task; the tool set is
extended by external MCP servers, and the skill set by custom skills.

The bot remembers context between conversations (profile, domain facts, protected data, reminders), but into each
request it injects only a small, relevant, and safe slice of memory. The base core is reactive; an optional proactive
mode lets it message first without turning into spam.  

The bot treats its interlocutor as a person: it remembers who you are and how you prefer to communicate, adapts its
style, and safeguards your personal data.

## What the bot can do

### 🧠 Memory — how it works

The main principle of memory: **the database can store a lot, but into each request to the model only a small,
relevant, and safe slice is injected** (typically between 10 and 30 facts). This way the bot remembers context between
sessions, yet does not read out the entire history or overflow the model's context window. Memory is divided into
global (shared by everyone) and personal (tied to the interlocutor):

| Memory type | Scope | What it stores |
|------------|---------|------------|
| **Global facts** | shared | Always-current facts for everyone, mixed into every request to the model. |
| **Knowledge base (RAG)** | shared | Documents; searched by meaning (embeddings), only relevant fragments enter the request. |
| **Profile** | personal | Stable facts about the interlocutor and their communication style. |
| **Dialog** | personal | Facts of the current conversation. |
| **Domain facts** | personal | Information on the topic of the active skill (domain). |
| **Protected data** | personal | Passwords, keys, personal info — encrypted (AES-256-GCM), only with explicit consent. |
| **Reminders** | personal | Future tasks that the bot will deliver on schedule. |

A few clarifications to the table:

- **Protected data** appears in the model's reasoning only as a de-identified summary, without revealing the full value.
- **Global memory** is filled and cleaned only by the administrator; both of its mechanisms are disabled by default and
  independent. Global facts are the always-on minimum for everyone, while the knowledge base (RAG) is pulled in
  selectively for the question, so it can be arbitrarily large without bloating every request.
- **Dialog history** is automatically collapsed into a short digest so as not to bloat the context.

### 🧩 Configurable skills — behavior tuned to the task

The bot's behavior is defined by **skills** — directories `skills/<name>/`. A single skill is a complete domain: its own
memory namespace, response prompt, fact-extraction rules, closed schema of domain data, and a set of tools. The bot
itself decides from the message which skill to activate. Included out of the box:

| Skill | Purpose |
|-------|------------|
| `general` | Default general-purpose assistant. |
| `flight-search` | Flight ticket search. |
| `math-tutor` | Math tutor. |
| `skill-author` | Creating and editing skills directly from the dialog (administrator only). |

The `skill-author` skill makes the system self-configuring: new domains can be added to the bot right from the dialog,
without touching code. For now, creating and editing skills is available only to the administrator — a limitation of the
current version.

### 💬 Talks across two channels

You can talk to the bot from the terminal (the quick way to check everything) or through a full-fledged bot in Telegram.
In Telegram the reply is typed out before your eyes as it is generated, and you can see which tools the bot is currently
using. To solve tasks, the model itself calls the needed tools — memory management, reminders, protected records,
settings, and working with skills.

### 🎙️ Understands voice and replies with voice

The bot recognizes voice messages and, if desired, replies with spoken speech with a choice of voice. Both directions
are disabled by default and are enabled via settings.

### ⏰ Reminds you and writes first in a friendly way

You can ask the bot to remind you about a task — once or on a recurring basis; delivery is handled by a separate
scheduler that survives restarts. In companion mode the bot may write first on a suitable occasion: after a prolonged
silence, with a morning greeting, on progress toward a goal, or on an external event. So that this does not turn into
spam, configurable thresholds and daily limits apply; the mode is disabled by default.

### 🔌 External tools

The bot can connect external tools via the Model Context Protocol (MCP), extending the set of actions available to the
model without changing its own code. Enabled via configuration flags.

## Installation and quick start

### Requirements

- Node.js version 20 or newer.
- PostgreSQL 16 with the `pgvector` (vector search) and `pgcrypto` (encryption of protected data) extensions.
- A filled-in configuration: database connection parameters (`config.db.postgres.dbs.main.*`) and the language model
  access key (`config.llm.apiKey`). Secrets are set in `config/local.yaml` (use `config/local.example.yaml` as a
  template) or via environment variables. The `config.llm.baseURL` address is needed only when working through an
  OpenAI-compatible proxy.

### Steps

```bash
npm install                                  # install dependencies
cp config/local.example.yaml config/local.yaml  # then fill in the DB connection parameters and the model key
npm run migrate                              # creates the database, the mem schema, and applies all migrations from migrations/
npm run chat                                 # interactive chat in the terminal — the fastest way to check the bot
```

For scheduled reminders, start a separate scheduler worker with `npm run scheduler`, and for working in Telegram — the
command `npm run telegram` (a filled-in `config.telegram.apiKey` token is required).

## Usage

### Chat in the terminal

The `npm run chat` command opens an interactive dialog. The following service commands are available:

| Command | Purpose |
|---------|------------|
| `/domain <key>` | Switch the active skill-domain (`general`, `flight-search`, `math-tutor`, `skill-author`). |
| `/fact <text>` | Force-save a fact into memory. |
| `/kb <text>` | Add an entry to the shared knowledge base (RAG). |
| `/tick` | Run the reminder scheduler manually, without waiting for the worker. |
| `/exit` | Exit the chat. |

### Bot in Telegram

The `npm run telegram` command starts the bot. It supports streaming the draft reply as it is generated, shows the
status of the tools being called, accepts voice messages, and — when voice output is enabled — replies with a spoken
message. The full procedure for launching, testing, and debugging is described in
[docs/telegram/telegram-bot.md](docs/telegram/telegram-bot.md). You can stop a running bot with the command
`npm run telegram:stop`.

### Admin web panel

The `npm run server` command starts the web panel (`src/server/index.js`): the LLM-log viewer, an admin chat that runs
the full agent pipeline, and the notes widget (build the frontend once with `npm run web:build`). Operators sign in
through the official Telegram Login Widget as the bot's own admin users. The setup checklist for a public domain
(`/setdomain` in BotFather, `config.telegram.botUsername`, `config.admin.auth.enabled`, `config.notes.mcpSecret`) is in
[readme-docs/configuration.md](./readme-docs/configuration.md#admin-web-panel); the sign-in mechanics are in
[docs/telegram/telegram-bot.md](docs/telegram/telegram-bot.md).

## Configuration

The main configuration mechanism is a hierarchy of YAML files in the `config/` directory (the `node-config` package):
`config/default.yaml` sets the defaults, the environment file (`development.yaml` or `production.yaml`, selected by
`NODE_ENV`) overrides them, and `config/local.yaml` holds local secrets. The `.env` file is supported as a compatible
bridge: environment variables loaded from it override the values from the YAML files. The minimum needed to run is the
database connection parameters (`config.db.postgres.dbs.main.*`) and the language model access key (`config.llm.apiKey`);
for the Telegram channel — also the `config.telegram.apiKey` token. A full reference of all settings by group, with
paths in the `config` tree, environment variable names, and default values, is moved to a separate document
[readme-docs/configuration.md](./readme-docs/configuration.md).

## Voice input and output

The bot can recognize voice messages and reply with synthesized speech. Voice input is disabled by default
(`config.voiceInput.enabled` is `false`); the recognition provider can be AssemblyAI or Groq Whisper. Voice output is
also disabled by default (`config.voiceOutput.enabled` is `false`); when enabled, a choice of voice is available
(`config.voiceOutput.voice`, for example `alloy` or `nova`), and long replies are shortened before being spoken. The
corresponding code is located in the `src/voice/` directory (recognition in `transcribe.js`, synthesis in `tts.js`, the
list of voices in `voices.js`).

## Skills and domains

How skills are organized is briefly described in the section [“What the bot can do”](#what-the-bot-can-do): each skill is
a complete domain with its own memory slice, prompts, data schema, and tools. The skill management commands
(`skills:list`, `skills:validate`, `skills:sync`) are collected in
[readme-docs/development.md](./readme-docs/development.md), and a full description of how skills and domain schemas are
organized is in
[docs/ai-bot-with-memory/11-per-domain-schema.md](docs/ai-bot-with-memory/11-per-domain-schema.md).

## Memory and proactivity

The memory principle and its five types are described in the section [“What the bot can do”](#what-the-bot-can-do). A
detailed breakdown of selection, writing, and deduplication is in
[docs/ai-bot-with-memory/06-memory.md](docs/ai-bot-with-memory/06-memory.md), and the structure of protected memory is in
[docs/ai-bot-with-memory/07-secure-privacy.md](docs/ai-bot-with-memory/07-secure-privacy.md).

The proactive extension lets the bot start a conversation itself on a suitable occasion: a prolonged silence, a morning
greeting, progress toward a goal, the interlocutor's return, or an external event. All thresholds and daily limits are
configurable, and by default the mode is disabled (`config.companion.enabled` is `false`). Details are in
[docs/ai-bot-with-memory/09-proactivity.md](docs/ai-bot-with-memory/09-proactivity.md).

## MCP tools

The bot can connect external tools via the Model Context Protocol (MCP). The client and configuration are located in
`src/mcp/` (`client.js`, `config.js`), and the list of servers is set in the `.mcp.json` file (template — `.mcp.json.example`).
This makes it possible to extend the set of tools available to the model without changing the bot's own code.

## Development

The tests use Node.js's built-in test runner and work with a real database and models, so they require a filled-in
configuration (`config/local.yaml` or environment variables) and applied migrations.

```bash
npm test          # multi-layered set of core checks (DB structure, memory, privacy, dialog)
npm run check:llm # checks the availability and speed of the selected model
```

For the full list of checks by subsystem, service scripts, and the source code layout, see
[readme-docs/development.md](./readme-docs/development.md).

## Architecture and documentation

The full technical documentation is collected in the [docs/ai-bot-with-memory/](docs/ai-bot-with-memory/README.md)
directory and is organized on the principle of progressive disclosure: from overview to the deep technical part. The
directory is portable and not tied to a specific project — it describes how the system should be organized. Key
documents:

- [04-architecture.md](docs/ai-bot-with-memory/04-architecture.md) — a step-by-step breakdown of the message processing
  pipeline;
- [05-data-schema.md](docs/ai-bot-with-memory/05-data-schema.md) — the full DDL of all tables of the memory schema;
- [08-prompts-and-models.md](docs/ai-bot-with-memory/08-prompts-and-models.md) — the prompts of all stages, model
  selection, and working through an LLM proxy;
- [13-history-compression.md](docs/ai-bot-with-memory/13-history-compression.md) — compression of the dialog history;
- [14-global-memory.md](docs/ai-bot-with-memory/14-global-memory.md) — global memory and the knowledge base.

The source code layout in brief: `src/agent.js` — the main response pipeline, `src/pipeline/` — the processing stages
(classification, selection, extraction, merging, protected memory, scheduler, proactivity), `src/telegram/` — the
Telegram channel, `src/voice/` — voice, `src/mcp/` — the MCP client, `src/schema/` — domain schemas, `migrations/` —
database migrations.

## License

The project is distributed under the MIT license. Author — Viacheslav Makarov.
