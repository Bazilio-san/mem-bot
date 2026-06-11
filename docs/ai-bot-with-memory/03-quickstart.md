# 03. Quick Start and Project Structure

## [QS-1] Environment Requirements

- Node.js 22 or later, ESM module type (`"type": "module"` in `package.json`).
- PostgreSQL 16 with the `pgvector` extension (semantic search over embeddings) and `pgcrypto` (UUID generation and
  hashing).
- A populated `config/local.yaml`: database connection parameters (`config.db.postgres.dbs.main.*`), the model access
  key `config.llm.apiKey`, and the encryption secret `config.authSecret`. `config.llm.baseURL` is set only when an
  OpenAI-compatible proxy is needed; without it the direct OpenAI API is used. The separate logs database
  (`config.db.postgres.dbs.logs`, default name `mem_bot_logs`) normally needs no credentials of its own: empty
  host/port/user/password are inherited from the `main` connection, and explicit values are required only when the
  journals live on a different server. Optionally, you can override models and
  database parameters. Configuration is built by the `node-config` package from the `config/` directory:
  `config/default.yaml` sets defaults, the environment file (selected by `NODE_ENV`) overrides them, and local secrets
  live in `config/local.yaml`; any value can also be overridden by an environment variable of the same name.

---

## [QS-2] Commands

```bash
npm install            # install dependencies: openai, pg, config, af-db-ts, dotenv
npm run migrate        # creates both databases (memory and logs), pgcrypto and vector extensions, all tables and indexes (idempotent)
npm run chat           # interactive terminal chat
npm run scheduler      # reminders and proactivity scheduler worker
npm test               # full test suite
npm run check:llm      # verify models via the selected OpenAI-compatible endpoint
npm run check:streaming # verify streaming output from the endpoint (text chunks and tool-call deltas)
```

Streaming model responses are enabled by default: the core delivers the final text in chunks and emits abstract
progress events via the `onEvent` callback (see [ARCH-7] in [04-architecture.md](04-architecture.md)). The toggle is
`config.streaming.enabled` (default `true`); when set to `false` the core runs the same pipeline without streaming
feedback.

Skills management (see [11-per-domain-schema.md](11-per-domain-schema.md)): a new domain is added by creating a
`skills/<name>/` directory containing a `SKILL.md` file. The command
`npm run skills:validate` validates all skills; `npm run skills:list` shows their domains and tools;
`npm run skills:sync` creates `domain_key` → `domain_id` mapping rows for new domains in the
`mem.agent_domains` reference table. In addition to manual file editing, skills can be created and updated by an
administrator directly in conversation via the skill-authoring toolset, which is enabled by the flag
`config.skills.authoring.enabled` and is available to administrators only.

The interactive chat supports the following commands: `/domain <key>` — switch the specialization domain. The
base domain is `general`; domains such as `flight_search` and `math_tutor` are illustrative examples of
specializations only — the actual set of skills is defined by the project itself and is not a mandatory
requirement. Additional commands: `/tick` — run the scheduler manually; `/exit` — quit.
Administrators have access to global-memory commands: `/fact-add <text>`, `/fact-list`, `/fact-del <id>` for
global facts, and `/kb-add <text>`, `/kb-find <query>`, `/kb-del <id>` for the shared knowledge base
(`/kb-find` is available to all users).

Enabling proactivity for a user and choosing triggers is done through the programmatic API
(`setUserProactivity`, `setTrigger`, `getProactivityState`), which the consuming project maps to commands and
menus in its own delivery channel.

---

## [QS-3] Proactivity and Companion Mode Flags

| `config` path | Purpose | Default |
|---------------|---------|---------|
| `companion.enabled` | stable live-companion prompt, moment tone, topic context, topic and companion-memory extraction; date/time/timezone are always passed regardless of this flag | `true` |
| `proactive.enabled` | global switch for the proactive pipeline (triggers, anti-spam, delivery); on top of this each user enables proactivity individually via the programmatic API (`setUserProactivity`) | `true` |
| `proactive.events.enabled` | external events pipeline (requires `proactive.enabled`) | `false` |
| `proactive.intervalMs` | how often the worker checks triggers | `300000` (5 minutes) |
| `proactive.inactivityMinutes` | silence threshold for the `inactivity` trigger | `1440` |
| `proactive.checkinHour` | hour of the daily greeting | `10` |
| `proactive.goalIntervalMinutes` | goal-reminder interval | `2880` |
| `proactive.welcomeBackGapMinutes` | gap after which the user is considered to have returned | `60` |
| `proactive.events.relevanceThreshold` | relevance threshold for an external event | `0.6` |

The companion mode `companion.enabled` and the proactive pipeline `proactive.enabled` are on by default
(`config/default.yaml`). To override them for a specific environment — for example, to disable them — use
`config/development.yaml`, `config/local.yaml`, or the corresponding environment variables when starting the
scheduler worker. The external events pipeline `proactive.events.enabled` is off by default and must be
enabled separately:

```bash
# disable companion mode and proactivity for this run
COMPANION_MODE=false PROACTIVE_ENABLED=false npm run scheduler
# enable the external events pipeline
PROACTIVE_EVENTS_ENABLED=true npm run scheduler
```

---

## [QS-4] History Compression Flags (enabled by default)

| `config` path | Purpose | Default |
|---------------|---------|---------|
| `historyCompression.enabled` | compressed history layer (`HISTORY_CONTEXT` on top of the hot window) | `true` |
| `historyCompression.hotWindow` | number of recent messages sent verbatim in the request | `8` |
| `historyCompression.maxTokens` | cold-zone size threshold above which compression is triggered | `2000` |
| `historyCompression.shrinkTokens` | target digest size after compression (must be less than `historyCompression.maxTokens`) | `800` |
| `historyCompression.zoneWeights` | digest budget shares for the near, middle, and far zones | `[0.55, 0.30, 0.15]` |
| `historyCompression.model` | history summarizer model (defaults to `config.llm.auxModel`) | `gpt-5.4-nano` |
| `historyCompression.minCompressGain` | minimum compression gain below which re-compression is skipped | `0.35` |


---

## [QS-4a] Global Memory Flags (enabled by default)

| `config` path | Purpose | Default |
|---------------|---------|---------|
| `globalMemory.factsEnabled` | always-on global facts (`GLOBAL_FACTS` block) and their tools | `true` |
| `globalMemory.factsLimit` | number of global facts injected into each request | `5` |
| `globalMemory.ragEnabled` | shared knowledge base (`GLOBAL_KNOWLEDGE` block) and its tools | `true` |
| `globalMemory.ragLimit` | number of knowledge-base fragments injected by relevance | `5` |
| `globalMemory.ragMinRelevance` | relevance threshold: fragments below this value are not included in context | `0.3` |

The flags are independent: you can enable only permanent facts, only the knowledge base, both, or neither.
Writing to the global memory is described in [14-global-memory.md](14-global-memory.md).

---

## [QS-4b] LLM Request Log Flags (enabled by default)

| `config` path | Purpose | Default |
|---------------|---------|---------|
| `llmLog.enabled` | write the journals (model requests and agent events) to the logs database; when `false` both emitters become no-ops | `true` |
| `llmLog.batchSize` | background buffer-flush batch size (number of records per `INSERT`) | `200` |
| `llmLog.flushIntervalMs` | background buffer-flush interval (milliseconds) | `1000` |
| `llmLog.maxPayloadChars` | maximum serialized length of `payload`, `response`, and event `data`; beyond it the value is truncated and the matching flag is set | `100000` |
| `llmLog.retention.llmRequestDays` | age threshold (days) of the daily cleanup of `log.llm_request`; `0` keeps rows forever | `90` |
| `llmLog.retention.agentEventDays` | age threshold (days) of the daily cleanup of `log.agent_event`; `0` keeps rows forever | `90` |
| `llmLog.retention.llmUsageDays` | age threshold (days) of the daily cleanup of `log.llm_usage`; `0` keeps rows forever | `0` |

The log is structured and operates as described in [10-operations.md](10-operations.md), section [OPS-5]; the
table schema is in [05-data-schema.md](05-data-schema.md), section [DATA-12].

---

## [QS-5] Directory Structure

```text
migrations/001_init.sql      single initialization of the memory database: mem schema, all tables, types, indexes, triggers, base domains
migrations-log/001_log_init.sql  single initialization of the logs database: log schema, journal tables, billing trigger
skills/                      skills registry: one directory per domain (SKILL.md, references/)
config/                      node-config configuration tree: default.yaml, environment files, local.yaml, env-var map
src/config.js                snapshot of the config tree (node-config): model selection, flags, and DB connection parameters
src/db.js                    PostgreSQL access via af-db-ts: the memory connection (query) and the logs connection (queryLog)
src/llm.js                   LLM client: chat, strict JSON (chatJSON), embeddings
src/migrate.js               database bootstrap and migration runner
src/repo.js                  users, domains, conversations, messages, tool log, proactivity helpers
src/agent.js                 main response pipeline (handleMessage) with companion branches gated by flags
src/cli.js                   interactive terminal chat
src/scheduler-run.js         scheduler and proactivity worker
src/utils/temporal.js        temporal context (criterion 14)
src/pipeline/classify.js     stage 1: request classification (skill selection)
src/pipeline/skills/parse.js     parse SKILL.md into front-matter and markdown blocks
src/pipeline/skills/registry.js  skills registry: loading, validation, access to prompts and references
src/pipeline/skills/cli.js       skill management commands: validate, list, sync
src/pipeline/skills/author.js    model-driven generators for skill parts (draft, prompt blocks)
src/pipeline/skills/writer.js    assemble SKILL.md, validate, atomic write, and hot-reload the skill
src/pipeline/skills/authoring-support.js  helpers for skill-authoring tools
src/pipeline/agent-tools/skill-authoring/  admin tools for creating and editing skills (skill_author_*)
src/pipeline/retrieve.js     memory retrieval, ranking, minimization, MEMORY_CONTEXT assembly
src/pipeline/facts.js        fact extraction, assistant-reply summary, write with semantic dedupe, dedupe sweep
src/pipeline/secure.js       protected memory: encryption, consent, masking
src/pipeline/scheduler.js    task creation, worker, retries, rescheduling
src/pipeline/tools.js        tool registry: build definitions, permissions, logging, call handler, initTools
src/pipeline/agent-tools/    one module per tool: title, definition, and handler
src/mcp/config.js            read and parse .mcp.json (list of external MCP servers in MCP-client format)
src/mcp/client.js            connect to MCP servers, wrap their tools for the registry, reconnect
.mcp.json                    external MCP server configuration (not version-controlled; may be absent)
src/pipeline/admin.js        user memory view and deletion, administrator permission check (isAdmin)
src/pipeline/global-memory.js  global memory: facts (always-on) and shared knowledge base (RAG) (criteria 19–21)
src/pipeline/topics.js       dialog topic extraction (extractTopics) and topic tracking (criterion 13)
src/pipeline/proactive.js    proactivity triggers and anti-spam (criteria 15, 16)
src/pipeline/proactiveMessage.js  proactive message generator
src/pipeline/events.js       external events and relevance filter (criterion 17)
src/pipeline/history-context.js   HISTORY_CONTEXT reference block assembly (criterion 18)
src/pipeline/history-compress.js  compression decision and cold-zone summarizer invocation
src/pipeline/token-counter.js     conservative token count estimation (estimateTokens)
src/pipeline/log-writer.js   shared buffered batch writer for the journal tables in the logs database
src/pipeline/llm-log.js      model request log: record builder (payload, response, cost), request types
src/pipeline/agent-event-log.js   agent event journal: stages, tool calls with arguments/results, MCP connections
src/pipeline/log-retention.js     daily age-based cleanup of the journals (config.llmLog.retention)
src/pipeline/llm-pricing.js  request cost calculation from the model price list
src/pipeline/llm-usage-stats.js   cost aggregates over the narrow log.llm_usage log
scripts/migrate-llm-log-db.js     one-time transfer of historical journals into the logs database
tests/run.js                 layered test suite (base layer plus proactivity, history compression, and global memory layers)
tests/memory_cases.json      fact-extraction test cases
tests/skills.test.mjs        skills registry and tool-filtering tests (npm run test:skills)
tests/skill-authoring.test.mjs  skill-authoring toolset tests (npm run test:skill-authoring)
tests/llm-log-*.test.mjs, tests/log-*.test.mjs, tests/agent-event-log.test.mjs  journal unit and integration suites (npm run test:llm-log, test:llm-log-db)
tests/check-llm.js           model availability and capability check via the selected endpoint
scripts/memory-dedupe.js     CLI dry-run/apply for retroactive memory deduplication
```

---

## [QS-6] Building from Scratch (order)

1. **Foundation.** Set up Node.js 22 and PostgreSQL 16 with the required extensions. Create `package.json` (ESM,
   dependencies `openai`, `pg`, `config`, `af-db-ts`, `dotenv`) and the `config/` configuration directory.
2. **Memory schema.** Write `migrations/001_init.sql` (see [05-data-schema.md](05-data-schema.md)), make the
   migration idempotent, and implement `src/migrate.js`. Verify the structure before writing business logic.
3. **Infrastructure.** `src/db.js`, `src/config.js`, `src/llm.js`, `src/repo.js`.
4. **Memory retrieval.** `src/pipeline/retrieve.js` — see [06-memory.md](06-memory.md).
5. **Write pipeline.** `src/pipeline/facts.js` — see [06-memory.md](06-memory.md).
6. **Privacy.** `src/pipeline/secure.js` — see [07-secure-privacy.md](07-secure-privacy.md).
7. **Scheduler.** `src/pipeline/scheduler.js` and the worker — see [10-operations.md](10-operations.md).
8. **Tools and agent.** The `src/pipeline/agent-tools/*` modules, the `src/pipeline/tools.js` registry, and
   `src/agent.js` — see [04-architecture.md](04-architecture.md). Users can manage their own memory directly in
   conversation via the `memory_list`, `memory_forget_entity`, and `memory_forget_all` tools (backed by
   `src/pipeline/admin.js`) — see [06-memory.md](06-memory.md). External tool sources over the MCP protocol
   (`src/mcp/*` modules, `.mcp.json` file, lazy `initTools` initialization) — see
   [10-operations.md](10-operations.md), section `OPS-4a`.
9. **Tests.** `tests/run.js` in layers — see [10-operations.md](10-operations.md).
10. **Proactivity and companion mode.** Proactivity tables and companion `fact_type` values from the single
    initialization, the `topics`, `temporal`, `proactive`, and `events` modules, and flag-gated branches in
    `agent.js` — see [09-proactivity.md](09-proactivity.md). Code lives in the `src/` directory.
11. **History compression.** The `conversation_summaries` service columns, the `token-counter`, `history-compress`,
    and `history-context` modules, populating `token_count` in `saveMessage`, and assembling `HISTORY_CONTEXT` in
    `agent.js` under the flag — see [13-history-compression.md](13-history-compression.md).
12. **Global memory.** Global memory tables and the `is_admin` column from the single initialization, the
    `global-memory` module, the `isAdmin` function in `admin.js`, tool modules and permission checks in `tools.js`,
    and assembly of the `GLOBAL_FACTS` and `GLOBAL_KNOWLEDGE` blocks in `agent.js` under the flags — see
    [14-global-memory.md](14-global-memory.md).

---


