# 02. Readiness Criteria

## Twelve Core Criteria

| ID | Criterion | Reference Module (recommendation) |
|--------|----------|-------------------------------|
| CRIT-1 | Five memory types, each with its own logic | `mem.*` schema tables in `migrations/001_init.sql` |
| CRIT-2 | Does not save noise (an important fact is not the same as a random phrase) | `confidence >= config.facts.minConfidence` threshold in `saveFacts` (`src/pipeline/facts.js`) |
| CRIT-3 | Does not bloat the prompt (10–30 facts) | hard `LIMITS` in `src/pipeline/retrieve.js` |
| CRIT-4 | A new message takes precedence over old memory | rule in the `MAIN_SYSTEM` system prompt (`src/agent.js`) |
| CRIT-5 | Updates a fact without duplicates | write-time semantic deduplication in `saveFact` (`src/pipeline/facts.js`): confirm and replace similarity thresholds |
| CRIT-6 | Distinguishes a fact, an intention, and a task | `fact_type` and `domain_key` fields plus a dedicated scheduler |
| CRIT-7 | Sensitive data — only with confirmation | `src/pipeline/secure.js` (encryption, consent) |
| CRIT-8 | Does not expose unnecessary data | only `redacted_summary` is included in the prompt |
| CRIT-9 | Calls tools (built-in and external via MCP) | `src/pipeline/agent-tools/*` modules, external MCP servers from `.mcp.json` (`src/mcp/*`), and the tool loop in `agent.js` |
| CRIT-10 | Works with the scheduler | `src/pipeline/scheduler.js` (capture, retries, rescheduling) |
| CRIT-11 | Resistant to harmful instructions in memory | the `MEMORY_CONTEXT` block is supplied as reference material, not as commands |
| CRIT-12 | Fast | classification, quick retrieval, response, asynchronous fact writing |

Additionally, the user must be able to delete their own memory: the reference module `src/pipeline/admin.js` must
provide soft deletion of a single record and full forgetting. Each of the twelve core criteria and memory deletion
MUST be covered by a mandatory test.

---

## Five New Proactivity Criteria

| ID | Criterion | Reference Module (recommendation) | Enable Flag |
|---------|----------|-------------------------------|----------------|
| CRIT-13 | The bot does not loop on topics (topic tracking) | `mem.topic_mentions` + `src/pipeline/topics.js` | `config.companion.enabled` |
| CRIT-14 | Responses are appropriate in time (temporal context) | `src/utils/temporal.js` | date/time/timezone — always; mood of the moment — `config.companion.enabled` |
| CRIT-15 | The bot initiates contact on an appropriate occasion, respecting the user's silence | `mem.proactive_triggers` + `mem.proactive_contact_state` + `src/pipeline/proactiveContactPolicy.js` | `config.proactive.enabled` |
| CRIT-16 | Warm return greeting and a consistent communicator style | incoming `welcome_back` signal in `src/agent.js` + `src/pipeline/proactiveMessage.js` | `config.proactive.enabled` |
| CRIT-17 | External events are turned into personal occasions | `src/pipeline/events.js` + `mem.event_deliveries` | `config.proactive.events.enabled` |

Details for all five are in [09-proactivity.md](09-proactivity.md).

---

## History Compression Criterion

| ID | Criterion | Reference Module (recommendation) | Enable Flag |
|---------|----------|-------------------------------|----------------|
| CRIT-18 | Compressed history: the hot window verbatim, the cold zone as a digest, no duplicates with memory | `mem.conversation_summaries` + `src/pipeline/history-context.js` and `history-compress.js` | `config.historyCompression.enabled` |

The criterion is considered met when the last `N` messages are always passed verbatim, older history is folded into a
`HISTORY_CONTEXT` of a defined size with a "recent is more detailed than distant" gradient, history does not repeat
facts from `MEMORY_CONTEXT`, secrets do not appear in the open summary, and when the flag is off behavior remains
baseline. Tests are in the `layerHistory` layer in [10-operations.md](10-operations.md).

---

## Three Global Memory Criteria

| ID | Criterion | Reference Module (recommendation) | Enable Flag |
|---------|----------|-------------------------------|----------------|
| CRIT-19 | Global facts are injected into every request, limited in count | `mem.global_facts` + `GLOBAL_FACTS` assembly in `src/agent.js` | `config.globalMemory.factsEnabled` |
| CRIT-20 | Shared knowledge base (RAG): texts are visible to all, injected by relevance, searched and deleted by identifier | `mem.global_knowledge` + `src/pipeline/global-memory.js` | `config.globalMemory.ragEnabled` |
| CRIT-21 | Only an administrator (flagged `is_admin`) can populate and clean global memory | check in `executeTool` + `isAdmin` in `src/pipeline/admin.js` | both flags |

Global memory is shared across all users: global facts are present in every response, knowledge-base fragments are
injected by relevance to the request, and writing is restricted by administrator permissions. Each criterion is
enabled by a flag, and tests are in the `layerGlobalMemory` layer in [10-operations.md](10-operations.md).

---

## Streaming Feedback Criterion

| ID | Criterion | Reference Module (recommendation) | Enable Flag |
|---------|----------|-------------------------------|----------------|
| CRIT-22 | Streaming delivery of the final text and abstract processing-progress events via `onEvent` | `chatStream` in `src/llm.js` + event loop in `src/agent.js` | `config.streaming.enabled` (default `true`) |

The criterion is considered met when `chatStream` assembles from streaming deltas the same final message object
(with `content` and `tool_calls` fields) as the non-streaming `chat` produces; the core emits `assistant.delta`,
`assistant.completed`, `tool.started`, `tool.completed`, `agent.completed`, and `agent.failed` events with the
ordering guarantees from [ARCH-7] in [04-architecture.md](04-architecture.md); the human-readable tool name in
events is taken from `toolTitle(name)` and contains no arguments; when the flag is off the final `answer`, history
saving, and `toolsUsed` match the streaming mode semantically. Tests are the unit tests for assembly and the name
coverage layer in [10-operations.md](10-operations.md).

---
