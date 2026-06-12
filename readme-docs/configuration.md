# Configuration

The project configuration is built by `node-config` from the `config/` directory. The package assembles a single
settings tree by merging several YAML files in strict priority order — each subsequent layer overrides values from
the previous one:

1. `config/default.yaml` — complete configuration structure and default values (with explanatory comments). This file
   defines the shape of the entire tree: all available keys are declared here.
2. `config/development.yaml`, `config/production.yaml`, `config/test.yaml` — environment-specific overrides.
   The file to load is selected by the `NODE_ENV` environment variable (an environment variable is a named value
   that a process receives from the operating system): when `NODE_ENV=production` the file `production.yaml` is
   picked up; for any other value (or when the variable is not set) `development.yaml` is used; the test suite
   runs with `NODE_ENV=test` and reads `test.yaml`.
3. `config/local.yaml` — local secrets and personal developer overrides. This file is listed in `.gitignore` and
   never enters version control. Use `config/local.example.yaml` as a template.
4. `config/custom-environment-variables.yaml` — a mapping of the form "config-tree path corresponds to an
   environment variable name". Any set environment variable overrides the value from the YAML files. The `.env`
   file is still supported as a compatibility bridge: the `dotenv` package loads its contents into the process
   environment, after which the variable map substitutes those values into the configuration tree (use `.env.example`
   as a template).

In code, settings are accessed through the `src/config.js` module. It exposes a `config` object — a ready snapshot
of the assembled tree — whose branches are accessed by path, for example `config.llm.mainModel` (main model),
`config.proactive.enabled` (whether proactivity is on), `config.db.postgres.dbs.main.host` (address of the
production database server). Secrets (API keys, passwords) are stored in `config/local.yaml` or passed via
environment variables, and are never written to files that enter version control.

The tables below list for each setting: the path in the `config` tree, the environment variable that can override it,
its purpose, and the default value. Wherever a value is a boolean flag it takes the form `true` (enabled) or
`false` (disabled).

## Models and the Language Model (LLM)

LLM (large language model) is the model that generates responses and calls tools. The client is compatible with the
OpenAI API and can work either directly or through an OpenAI-compatible proxy (an intermediate server that forwards
requests to the models).

| `config` path      | Environment variable | Purpose                                                                               | Default                  |
|--------------------|----------------------|---------------------------------------------------------------------------------------|--------------------------|
| `llm.apiKey`       | `OPENAI_API_KEY`     | Access key for the language model.                                                    | —                        |
| `llm.baseURL`      | `OPENAI_BASE_URL`    | Address of an OpenAI-compatible proxy (e.g. LiteLLM); if empty — direct OpenAI API.  | empty                    |
| `llm.mainModel`    | `MAIN_MODEL`         | Main agent: responds to the user and calls tools.                                     | `gpt-5.4-mini`           |
| `llm.auxModel`     | `AUX_MODEL`          | Fast auxiliary model: classifies incoming messages.                                   | `gpt-5.4-nano`           |
| `llm.extractModel` | `EXTRACT_MODEL`      | Model for extracting facts into memory.                                               | `gpt-5.4-mini`           |
| `llm.embedModel`   | `EMBED_MODEL`        | Embeddings model for semantic search.                                                 | `text-embedding-3-small` |

The embedding dimensionality `config.llm.embedDim` is `1536` and is defined as a constant: it is not an environment
variable and cannot be changed. Models are verified by the `npm run check:llm` script against an OpenAI-compatible
proxy. The `gpt-5.4-*` family responds in approximately 5–10 seconds; if you need the fastest possible response,
set `config.llm.mainModel`, `config.llm.auxModel`, and `config.llm.extractModel` to `gpt-4o-mini`.

## Database

PostgreSQL access goes through the `af-db-ts` package, which reads connection parameters from the configuration
tree at `config.db.postgres.dbs.<identifier>`. The production database is available under the alias (short
connection name) `main`. The service connection under the alias `bootstrap` points to the system database
`postgres` and is used only for the `CREATE DATABASE` command during initial setup in `src/migrate.js`.

| `config` path                     | Environment variable | Purpose                                                          | Default     |
|-----------------------------------|----------------------|------------------------------------------------------------------|-------------|
| `db.postgres.dbs.main.host`       | `DB_HOST`            | Address of the production database server. An empty value disables the DB. | `localhost` |
| `db.postgres.dbs.main.port`       | `DB_PORT`            | Port of the database server.                                     | `5432`      |
| `db.postgres.dbs.main.database`   | `DB_NAME`            | Name of the production memory database.                          | `mem_bot`   |
| `db.postgres.dbs.main.user`       | `DB_USER`            | Database user name (secret).                                     | —           |
| `db.postgres.dbs.main.password`   | `DB_PASSWORD`        | Database user password (secret).                                 | —           |

## Memory Limits

Controls how many facts from each domain are included in the model request. The list is ranked by relevance and
truncated to these values.

| `config` path           | Environment variable  | Purpose                                                        | Default |
|-------------------------|-----------------------|----------------------------------------------------------------|---------|
| `memoryLimits.total`    | `MEMORY_LIMIT_TOTAL`  | Overall cap on the number of facts in the prompt.              | `30`    |
| `memoryLimits.profile`  | `PROFILE`             | Persistent facts about the user and their communication style. | `7`     |
| `memoryLimits.dialog`   | `DIALOG`              | Facts from the current dialogue.                               | `5`     |
| `memoryLimits.domain`   | `DOMAIN`              | Domain-area facts.                                             | `12`    |
| `memoryLimits.reminder` | `REMINDER`            | Active reminders.                                              | `3`     |
| `memoryLimits.secure`   | `SECURE`              | Anonymised summaries of protected data.                        | `3`     |

## Security and Timezone

| `config` path | Environment variable | Purpose                                                                             | Default                         |
|---------------|----------------------|-------------------------------------------------------------------------------------|----------------------------------|
| `authSecret`  | `AUTH_SECRET`        | Encryption key for secure memory (AES-256-GCM). Must be changed in production.     | `dev-insecure-secret-change-me` |
| `timezone`    | `TZ_DEFAULT`         | Default timezone for date and time logic.                                           | `Europe/Moscow`                 |
| `debug`       | `DEBUG`              | Comma-separated list of debug output categories (`*` enables all categories).       | empty                           |

## Voice Input (Speech Recognition)

| `config` path            | Environment variable      | Purpose                                                          | Default                        |
|--------------------------|---------------------------|------------------------------------------------------------------|--------------------------------|
| `voiceInput.enabled`     | `VOICE_INPUT_ENABLED`     | Recognition of voice messages.                                   | `false`                        |
| `voiceInput.provider`    | `VOICE_INPUT_PROVIDER`    | Speech recogniser from the `src/voice/transcribe.js` registry.  | `groq-whisper-large-v3-turbo`  |
| `voiceInput.language`    | `VOICE_INPUT_LANG`        | Language hint code for the recogniser.                           | `ru`                           |
| `voiceInput.maxSeconds`  | `VOICE_INPUT_MAX_SECONDS` | Maximum duration of incoming audio (seconds).                    | `300`                          |
| `voiceInput.maxBytes`    | `VOICE_INPUT_MAX_BYTES`   | Size limit when duration is unknown (bytes).                     | `25000000`                     |

## Voice Output (Text-to-Speech)

| `config` path                  | Environment variable             | Purpose                                                               | Default           |
|--------------------------------|----------------------------------|-----------------------------------------------------------------------|-------------------|
| `voiceOutput.enabled`          | `VOICE_OUTPUT_ENABLED`           | Synthesis of a voice response.                                        | `false`           |
| `voiceOutput.model`            | `VOICE_OUTPUT_MODEL`             | Text-to-speech (TTS) model for the configured API address.            | `gpt-4o-mini-tts` |
| `voiceOutput.voice`            | `VOICE_OUTPUT_VOICE`             | Voice timbre (e.g. `ash`, `nova`).                                    | `ash`             |
| `voiceOutput.format`           | `VOICE_OUTPUT_FORMAT`            | Audio format (`opus` — send directly to Telegram).                   | `opus`            |
| `voiceOutput.maxChars`         | `VOICE_OUTPUT_MAX_CHARS`         | Hard limit on the length of text to be spoken (characters); longer responses are summarised. | `500` |
| `voiceOutput.summaryMaxChars`  | `VOICE_OUTPUT_SUMMARY_MAX_CHARS` | Length limit for the summary itself.                                  | `500`             |
| `voiceOutput.summaryModel`     | `VOICE_OUTPUT_SUMMARY_MODEL`     | Model used to build summaries of long responses.                      | `gpt-5.4-nano`    |

## Skills and Domain Schemas

| `config` path               | Environment variable          | Purpose                                                                            | Default  |
|-----------------------------|-------------------------------|------------------------------------------------------------------------------------|----------|
| `skills.dir`                | `SKILLS_DIR`                  | Directory containing skills.                                                       | `skills` |
| `skills.switchThreshold`    | `SKILLS_SWITCH_THRESHOLD`     | Classifier confidence threshold for switching to a different skill.                | `0.65`   |
| `skills.referenceMaxBytes`  | `SKILL_REFERENCE_MAX_BYTES`   | Maximum size of a single skill reference file (bytes).                             | `50000`  |
| `skills.authoring.enabled`  | `SKILL_AUTHORING_ENABLED`     | Tooling for the model to create and edit skills (admin only).                      | `false`  |
| `skills.authoring.model`    | `SKILL_AUTHORING_MODEL`       | Model used for skill editing; empty (`null`) falls back to `config.llm.mainModel`. | `null`   |
| `schema.keyEmbedThreshold`  | `SCHEMA_KEY_EMBED_THRESHOLD`  | Cosine similarity threshold for canonicalising a domain entity key.                | `0.82`   |

## Global Memory and Knowledge Base

| `config` path                 | Environment variable       | Purpose                                                           | Default |
|-------------------------------|----------------------------|-------------------------------------------------------------------|---------|
| `globalMemory.factsEnabled`   | `GLOBAL_MEMORY_ENABLED`    | Facts shared across all users, together with their tools.         | `false` |
| `globalMemory.factsLimit`     | `GLOBAL_FACTS_LIMIT`       | Number of global facts to inject into each request.               | `5`     |
| `globalMemory.ragEnabled`     | `GLOBAL_RAG_ENABLED`       | Shared knowledge base (RAG) and its tools.                        | `false` |
| `globalMemory.ragLimit`       | `GLOBAL_RAG_LIMIT`         | Number of knowledge-base chunks to inject by relevance.           | `5`     |
| `globalMemory.ragMinRelevance`| `GLOBAL_RAG_MIN_RELEVANCE` | Cutoff threshold for weak knowledge-base matches.                 | `0.3`   |

## Companion Mode and Proactivity

| `config` path                                   | Environment variable                           | Purpose                                                                   | Default |
|-------------------------------------------------|------------------------------------------------|---------------------------------------------------------------------------|---------|
| `companion.enabled`                             | `COMPANION_MODE`                               | Companion mode: temporal and thematic context plus topic extraction.      | `false` |
| `proactive.enabled`                             | `PROACTIVE_ENABLED`                            | Proactive loop: the bot initiates messages based on triggers.             | `false` |
| `proactive.events.enabled`                      | `PROACTIVE_EVENTS_ENABLED`                     | External-events loop (requires `config.proactive.enabled`).               | `false` |
| `proactive.events.relevanceThreshold`           | `NEWS_RELEVANCE_THRESHOLD`                     | Relevance threshold for notifying the user about an external event.       | `0.6`   |
| `proactive.intervalMs`                          | `PROACTIVE_INTERVAL_MS`                        | How often the worker checks for triggers (milliseconds).                  | `300000`|
| `proactive.inactivityMinutes`                   | `PROACTIVE_INACTIVITY_MIN`                     | Silence threshold before a check-in message is sent (minutes).            | `1440`  |
| `proactive.checkinHour`                         | `PROACTIVE_CHECKIN_HOUR`                       | Hour of the morning greeting.                                             | `10`    |
| `proactive.goalIntervalMinutes`                 | `PROACTIVE_GOAL_INTERVAL_MIN`                  | Interval between goal-progress messages (minutes).                        | `2880`  |
| `proactive.welcomeBackGapMinutes`               | `PROACTIVE_WELCOME_GAP_MIN`                    | Pause before greeting a returning user (minutes).                         | `60`    |
| `proactive.contactPolicy.softDailyLimit`        | `PROACTIVE_SOFT_DAILY_LIMIT`                   | Daily limit for bot-initiated messages.                                   | `1`     |
| `proactive.contactPolicy.softWeeklyLimit`       | `PROACTIVE_SOFT_WEEKLY_LIMIT`                  | Weekly limit for bot-initiated messages.                                  | `3`     |
| `proactive.contactPolicy.requestedReminderDailyLimit` | `PROACTIVE_REQUESTED_REMINDER_DAILY_LIMIT` | Daily limit for user-requested reminders.                           | `2`     |
| `proactive.contactPolicy.minSoftPauseMinutes`   | `PROACTIVE_MIN_SOFT_PAUSE_MIN`                 | Minimum pause between bot-initiated messages (minutes).                   | `360`   |
| `proactive.contactPolicy.quietAfterUnanswered`  | `PROACTIVE_QUIET_AFTER_UNANSWERED`             | Number of unanswered messages that put the bot into silence mode.         | `2`     |
| `proactive.contactPolicy.quietHoursAfterIgnores`| `PROACTIVE_QUIET_HOURS_AFTER_IGNORES`          | How many hours to stay silent after being ignored (hours).                | `24`    |

## History Compression

The most recent `config.historyCompression.hotWindow` messages are always passed verbatim; everything older is
compressed into a digest (a concise coherent summary).

| `config` path                       | Environment variable           | Purpose                                                                      | Default              |
|-------------------------------------|--------------------------------|------------------------------------------------------------------------------|----------------------|
| `historyCompression.enabled`        | `HISTORY_COMPRESSION_ENABLED`  | Compression of the older portion of the dialogue history.                    | `false`              |
| `historyCompression.hotWindow`      | `HISTORY_HOT_WINDOW`           | How many recent messages to leave uncompressed.                              | `8`                  |
| `historyCompression.maxTokens`      | `HISTORY_MAX_TOKENS`           | Token threshold that triggers compression of the cold zone.                  | `2000`               |
| `historyCompression.shrinkTokens`   | `HISTORY_SHRINK_TOKENS`        | Target maximum size of the digest (must be less than `config.historyCompression.maxTokens`). | `800` |
| `historyCompression.minCompressGain`| `HISTORY_MIN_COMPRESS_GAIN`    | Minimum compression gain required; otherwise the digest is not rewritten.   | `0.35`               |
| `historyCompression.model`          | `HISTORY_SUMMARY_MODEL`        | Model used to build the digest.                                              | `gpt-5.4-nano`       |
| `historyCompression.zoneWeights`    | `HISTORY_ZONE_WEIGHTS`         | Weights for the near, mid, and far history zones.                            | `[0.55, 0.30, 0.15]` |

In YAML files `config.historyCompression.zoneWeights` is written as an array, e.g. `[0.55, 0.30, 0.15]`. When
overriding via the environment variable `HISTORY_ZONE_WEIGHTS`, pass a JSON-array string, e.g. `[0.55,0.30,0.15]`.

## External Providers

| `config` path                 | Environment variable  | Purpose                                                              | Default |
|-------------------------------|-----------------------|----------------------------------------------------------------------|---------|
| `providers.assemblyaiApiKey`  | `ASSEMBLYAI_API_KEY`  | API key for AssemblyAI (alternative speech recogniser).              | —       |
| `providers.groqApiKey`        | `GROQ_API_KEY`        | API key for Groq (models and Whisper speech recognition).            | —       |
| `providers.groqBaseURL`       | `GROQ_BASE_URL`       | Groq API address; if empty — the default Groq endpoint is used.      | empty   |
| `providers.tavilyApiKey`      | `TAVILY_API_KEY`      | API key for Tavily search (source of external events).               | —       |

## Core Streaming

Streaming is the delivery of a model response in chunks as it is generated. The setting in this section is
channel-agnostic: it controls the streaming call to the model in the agent core and has nothing to do with how
responses are displayed in a particular messenger.

| `config` path       | Environment variable | Purpose                                       | Default |
|---------------------|----------------------|-----------------------------------------------|---------|
| `streaming.enabled` | `STREAMING_ENABLED`  | Streaming model call in the agent core.       | `true`  |

## Background Task Scheduler

| `config` path          | Environment variable      | Purpose                                                     | Default       |
|------------------------|---------------------------|-------------------------------------------------------------|---------------|
| `scheduler.minSleepMs` | `SCHEDULER_MIN_SLEEP_MS`  | Minimum pause in the scheduler loop (milliseconds).         | `250`         |
| `scheduler.maxSleepMs` | `SCHEDULER_MAX_SLEEP_MS`  | Maximum pause in the scheduler loop (milliseconds).         | `30000`       |
| `scheduler.workerId`   | `SCHEDULER_WORKER_ID`     | Scheduler worker identifier.                                | `scheduler-1` |

## MCP Protocol

MCP (Model Context Protocol) is the protocol for connecting external tools to the model.

| `config` path    | Environment variable | Purpose                                                                                    | Default     |
|------------------|----------------------|--------------------------------------------------------------------------------------------|-------------|
| `mcp.configPath` | `MCP_CONFIG_PATH`    | Path to the file listing MCP servers (resolved relative to the working directory).         | `.mcp.json` |

## Admin Web Panel

The `npm run server` command starts the web panel (`src/server/index.js`): the LLM-log viewer, an admin chat that runs
the full agent pipeline, and the notes widget. Build the frontend once with `npm run web:build` before serving it.
Operators sign in through the official **Telegram Login Widget** — admins are the bot's own users with
`mem.users.is_admin = true`, so there is no separate password store. The sign-in mechanics (signature check, HMAC
session cookie, route protection, the notes MCP endpoint guard) are described in
[docs/proj/telegram/telegram-bot.md](../docs/proj/telegram/telegram-bot.md).

To put the panel on a public domain you need:

1. **Link the domain to the bot in BotFather** — `/setdomain` for the bot (for example `@tinter2_bot`) pointing at the
   panel's host (for example `mem-bot.time-gold.com`). Without this Telegram refuses to issue the Login Widget
   signature.
2. **Set the bot username** — `config.telegram.botUsername` (env `TELEGRAM_BOT_USERNAME`), e.g. `tinter2_bot` without
   the `@`. The login screen embeds the widget for exactly this bot; with no username the screen cannot render it.
3. **Require sign-in** — `config.admin.auth.enabled` (env `ADMIN_AUTH_ENABLED`): `true` always, `false` never, `null`
   (default) turns it on automatically as soon as `config.admin.host` is not a loopback address. A locally bound panel
   therefore needs no login, while a publicly bound one demands it.
4. **Optionally guard the notes MCP endpoint** — `config.notes.mcpSecret` (env `NOTES_MCP_SECRET`) is required only if
   an external client must reach the MCP endpoint; the co-located agent connects over `localhost` and needs no secret.

| `config` path                | Environment variable    | Purpose                                                                  | Default     |
|------------------------------|-------------------------|--------------------------------------------------------------------------|-------------|
| `admin.host`                 | `ADMIN_HOST`            | Bind address of the panel; a non-loopback value auto-enables sign-in.    | `localhost` |
| `admin.port`                 | `ADMIN_PORT`            | Port of the panel web server.                                            | `9019`      |
| `admin.auth.enabled`         | `ADMIN_AUTH_ENABLED`    | Require sign-in: `true`/`false`/`null` (auto when host is non-loopback). | `null`      |
| `admin.auth.sessionTtlHours` | —                       | Lifetime of the HMAC session cookie, in hours.                           | `168`       |
| `telegram.botUsername`       | `TELEGRAM_BOT_USERNAME` | Bot username for the Login Widget (without the `@`); required to sign in.| —           |
| `notes.mcpSecret`            | `NOTES_MCP_SECRET`      | `X-Notes-Mcp-Secret` for external MCP callers (empty = local-only).      | —           |

## Telegram Adapter

Telegram channel parameters. These are only needed when running the bot in Telegram and do not affect the core.

| `config` path                              | Environment variable                       | Purpose                                                              | Default |
|--------------------------------------------|--------------------------------------------|----------------------------------------------------------------------|---------|
| `telegram.apiKey`                          | `TELEGRAM_API_KEY`                         | Telegram bot token; required only for the Telegram channel.          | —       |
| `telegram.maxConcurrency`                  | `TELEGRAM_MAX_CONCURRENCY`                 | Maximum number of messages processed concurrently.                   | `5`     |
| `telegram.outboxSafetyIntervalMs`          | `TELEGRAM_OUTBOX_SAFETY_INTERVAL_MS`       | Interval for the outbox table control pass (milliseconds).           | `30000` |
| `telegram.streaming.enabled`               | `TELEGRAM_STREAMING_ENABLED`               | Editable streaming-response draft in Telegram.                       | `true`  |
| `telegram.streaming.editIntervalMs`        | `TELEGRAM_STREAMING_EDIT_INTERVAL_MS`      | Minimum time between draft edits (milliseconds).                     | `500`   |
| `telegram.streaming.minEditChars`          | `TELEGRAM_STREAMING_MIN_EDIT_CHARS`        | Minimum number of new characters accumulated before an edit.         | `20`    |
| `telegram.streaming.minFirstDraftChars`    | `TELEGRAM_STREAMING_MIN_FIRST_DRAFT_CHARS` | Text volume threshold before the first draft appears.                | `50`    |
| `telegram.streaming.toolStatuses`          | `TELEGRAM_STREAMING_TOOL_STATUSES`         | Whether to show tool-call status messages.                           | `true`  |
