# Compliance Checklist: Memory Chatbot Implementation

This is the single artifact that knows about the specific project. The specification in the `docs/ai-bot-with-memory/`
directory describes how the system is designed to work and contains no information about implementation status. This
document, by contrast, captures the current state: what is done, what is partially done, and what is not yet done,
with references to real code and to numbered specification requirements.

---

## Header

- **Project:** `mem-bot` — an agentic application with long-term memory and proactivity, built on Node.js and PostgreSQL.
- **Specification reference:** document set `docs/ai-bot-with-memory/`, version `doc-v4` (commit `d8279fd`).
- **Snapshot date:** 2026-06-07.
- **How to read statuses:** "done" means the requirement is fulfilled and confirmed by code; "partial" means a basic
  version exists but part of the requirement has been simplified; "no" means the requirement is described in the
  specification as an extension and has not yet been implemented.
- **How to reference requirements:** by stable IDs from specification headings, e.g. `HIST-3`, `DATA-5`, `CRIT-7`.

---

## Summary by Layer

- **Reactive core** (response loop, five memory kinds, retrieval, write, privacy, scheduler, tools) — implemented;
  the `npm test` run passes fully.
- **Proactivity and companion mode** (`COMPANION_MODE`, `PROACTIVE_ENABLED`, `PROACTIVE_EVENTS_ENABLED`) —
  implemented; the proactivity check layer is enabled by a separate flag.
- **History compression** (`HISTORY_COMPRESSION_ENABLED`) — implemented; the `layerHistory` check layer is enabled
  by a separate flag.
- **Global memory** (`GLOBAL_MEMORY_ENABLED`, `GLOBAL_RAG_ENABLED`) — implemented: global facts (always-on) and a
  shared knowledge base (RAG), writes restricted to admin; the `layerGlobalMemory` check layer is enabled by flags.
- **External notification delivery** — partial: Telegram channel added (`src/telegram/bot.js`); email and push
  notification channels are not implemented.
- **Domain specificity of memory** (`DOMAIN-1`…`DOMAIN-3`) — implemented through two mechanisms: the
  `## Fact Extraction Prompt` block of the active skill (mixed into fact extraction) and the `domain_key`
  coordinate of the flat `mem.user_facts` table with per-type retention and source-rank policies. There is no
  separate structured entity layer.

---

## Requirements Compliance Table

### Overview — `OVR`

| Requirement ID | Short description | Status | Code reference / note |
|----------------|-------------------|--------|------------------------|
| `OVR-1` | Three processing loops (response, triggers, events) | done | `src/agent.js`, `src/pipeline/proactive.js`, `src/pipeline/events.js` |
| `OVR-2` | Genre: reactive agent plus companion | done | reactive core in `src/agent.js`, companion under flags |
| `OVR-3` | Core behavior is stable when flags are off | done | `src/config.js` — flags off by default |

### Readiness Criteria — `CRIT`

| Requirement ID | Short description | Status | Code reference / note |
|----------------|-------------------|--------|------------------------|
| `CRIT-1` | Five memory kinds, each with its own logic | done | `migrations/001_init.sql`, `mem.*` tables |
| `CRIT-2` | Does not save noise (auto-save threshold) | done | `facts.minConfidence` threshold in `saveFact` (`src/pipeline/facts.js`) |
| `CRIT-3` | Does not bloat the prompt (10–30 facts) | done | `LIMITS` in `src/pipeline/retrieve.js` |
| `CRIT-4` | New message takes priority over old memory | done | rule in `MAIN_SYSTEM`, `src/agent.js` |
| `CRIT-5` | Updates a fact without duplicates | done | write-time semantic dedupe in `saveFact` (`src/pipeline/facts.js`) |
| `CRIT-6` | Distinguishes fact, intention, and task | done | `fact_type` coordinate (`goal`, `open_loop`, …) plus scheduler |
| `CRIT-7` | Sensitive data only with confirmation | done | `src/pipeline/secure.js` |
| `CRIT-8` | Does not expose excess data (only `redacted_summary`) | done | `src/pipeline/secure.js`, `src/pipeline/retrieve.js` |
| `CRIT-9` | Calls tools | done | `src/pipeline/tools.js`, tool loop in `src/agent.js` |
| `CRIT-10` | Works with the scheduler | done | `src/pipeline/scheduler.js` |
| `CRIT-11` | Resilient to harmful instructions in memory | done | `MEMORY_CONTEXT` is provided as reference material, `src/pipeline/retrieve.js` |
| `CRIT-12` | Fast (cheap classification, fast retrieval, async write) | done | `src/agent.js`, `src/pipeline/classify.js`, `src/pipeline/retrieve.js` |
| `CRIT-13` | Topic tracking (no fixation) | done | `mem.topic_mentions`, `src/pipeline/topics.js` (`COMPANION_MODE`) |
| `CRIT-14` | Temporal context | done | `src/utils/temporal.js` (`COMPANION_MODE`) |
| `CRIT-15` | Proactivity triggers and anti-spam | done | `mem.proactive_triggers`, `src/pipeline/proactive.js` (`PROACTIVE_ENABLED`) |
| `CRIT-16` | Warm return welcome and consistent style | partial | `src/pipeline/proactiveMessage.js`; return detected by pause, no web-client signal |
| `CRIT-17` | External events as personal occasions | partial | `src/pipeline/events.js`; event source is a built-in news stub |
| `CRIT-18` | Compressed history: hot window, digest, deduplication | done | `src/pipeline/history-context.js`, `history-compress.js` (`HISTORY_COMPRESSION_ENABLED`) |
| `CRIT-19` | Global facts always injected, capped by count | done | `mem.global_facts`, `buildGlobalFactsBlock` in `src/pipeline/global-memory.js` (`GLOBAL_MEMORY_ENABLED`) |
| `CRIT-20` | Shared knowledge base (RAG): search by relevance, delete by id | done | `mem.global_knowledge`, `src/pipeline/global-memory.js` (`GLOBAL_RAG_ENABLED`) |
| `CRIT-21` | Writing to global memory — admin only | done | `isAdmin` in `src/pipeline/admin.js`, checked in `executeTool` (`src/pipeline/tools.js`) |

### Quick Start and Structure — `QS`

| Requirement ID | Short description | Status | Code reference / note |
|----------------|-------------------|--------|------------------------|
| `QS-1` | Environment requirements (Node.js 22, PostgreSQL 16, extensions) | done | `package.json`, `migrations/001_init.sql` |
| `QS-2` | Commands (`migrate`, `chat`, `scheduler`, `test`, `check:llm`, `skills:*`) | done | `package.json`, `src/cli.js`, `src/scheduler-run.js`, `src/pipeline/skills/cli.js` |
| `QS-3` | Proactivity flags | done | `src/config.js`, `proactive` block |
| `QS-4` | History compression flags | done | `src/config.js`, `historyCompression` block |
| `QS-4a` | Global memory flags | done | `src/config.js`, `globalMemory` block |
| `QS-5` | Directory structure | done | `src/`, `migrations/`, `skills/`, `tests/` match the specification |
| `QS-6` | From-scratch build order | done | confirmed by repository contents |

### Response Loop Architecture — `ARCH`

| Requirement ID | Short description | Status | Code reference / note |
|----------------|-------------------|--------|------------------------|
| `ARCH-1` | Stable agent system prompt | done | `MAIN_SYSTEM` in `src/agent.js` |
| `ARCH-2` | `handleMessage` pipeline step by step | done | `handleMessage` in `src/agent.js` |
| `ARCH-3` | Five stages (classify, retrieve, respond, save, write) | done | `src/agent.js` plus `src/pipeline/*` modules |
| `ARCH-4` | Additive proactivity branches under flags | done | `COMPANION_MODE` and `PROACTIVE_ENABLED` branches in `src/agent.js` |
| `ARCH-5` | Additive history compression branch under flag | done | `HISTORY_COMPRESSION_ENABLED` branch in `src/agent.js` |
| `ARCH-6` | Additive global memory blocks under flags | done | `GLOBAL_FACTS` and `GLOBAL_KNOWLEDGE` blocks plus `buildToolDefs(ctx)` in `src/agent.js` |

### Data Schema — `DATA`

| Requirement ID | Short description | Status | Code reference / note |
|----------------|-------------------|--------|------------------------|
| `DATA-1` | Extensions, `mem` schema, ENUM types | done | `migrations/001_init.sql` |
| `DATA-2` | Users and domains | done | `migrations/001_init.sql` (`users`, `agent_domains`) |
| `DATA-3` | Conversations, messages, summaries | done | `migrations/001_init.sql` |
| `DATA-4` | Main memory table `user_facts` | done | `migrations/001_init.sql` (`user_facts`) |
| `DATA-5` | Secure memory (`secure_records`) | done | self-contained table; only `redacted_summary` reaches the prompt |
| `DATA-6` | Scheduler: tasks, runs, outgoing notifications | done | tables present; `cron_expr` and `rrule` are evaluated with timezone support |
| `DATA-7` | Tool call log | done | `tool_calls`; memory writes happen as a non-blocking promise during the response |
| `DATA-8` | Three proactivity tables | done | `migrations/001_init.sql` |
| `DATA-9` | Two global memory tables and `is_admin` column | done | `migrations/001_init.sql` (`global_facts`, `global_knowledge`) |
| `DATA-10` | Domain specificity without extra tables | done | `domain_key` coordinate of `mem.user_facts`; `## Fact Extraction Prompt` block |

### Memory: Kinds, Retrieval, Write — `MEM`

| Requirement ID | Short description | Status | Code reference / note |
|----------------|-------------------|--------|------------------------|
| `MEM-1` | Five memory kinds | done | `src/pipeline/retrieve.js`, `migrations/001_init.sql` |
| `MEM-2` | Retrieval and three relevance signals | done | `src/pipeline/retrieve.js` (`scoreItem`, structural filter) |
| `MEM-3` | Building `MEMORY_CONTEXT` | done | `buildMemoryContext` in `src/pipeline/retrieve.js` |
| `MEM-4` | Write loop (extraction, filter, deduplication) | done | `extractFacts`/`saveFacts` in `src/pipeline/facts.js` |
| `MEM-5` | Auto-save threshold, fact sources, and privacy | done | `facts.minConfidence`, `SOURCE_RANK` in `src/pipeline/facts.js` |
| `MEM-6` | Deduplication and update instead of duplicates | done | confirm/replace thresholds in `saveFact` (`src/pipeline/facts.js`) |
| `MEM-7` | User-initiated memory deletion | done | `src/pipeline/admin.js`; in conversation — `memory_list`, `memory_forget_entity`, `memory_forget_all` in `src/pipeline/tools.js` |

### Secure Memory — `SEC`

| Requirement ID | Short description | Status | Code reference / note |
|----------------|-------------------|--------|------------------------|
| `SEC-1` | Encryption (AES-256-GCM) and redaction | done | `encrypt` / `redact` in `src/pipeline/secure.js` |
| `SEC-2` | Consent and access to full value | done | `getSecureValue` in `src/pipeline/secure.js` |
| `SEC-3` | Privacy checks (four branches) | done | privacy layer in `tests/run.js` |
| `SEC-4` | Secret detection during extraction | done | extraction prompt in `src/pipeline/facts.js` |
| `SEC-5` | Proactivity does not expose secured data | done | `src/pipeline/proactiveMessage.js` uses only safe summaries |

### Prompts, Proxy, Models — `PROMPT`

Full runtime prompt coordinates, tool definitions, and test and historical templates are documented in
[`prompt-inventory.md`](prompt-inventory.md).

| Requirement ID | Short description | Status | Code reference / note |
|----------------|-------------------|--------|------------------------|
| `PROMPT-1` | LLM client and strict JSON (`chatJSON`) | done | `src/llm.js` |
| `PROMPT-2` | Request classifier prompt | done | `src/pipeline/classify.js` |
| `PROMPT-3` | Fact extraction prompt (single pass, flat facts) | done | `EXTRACT_SYSTEM` in `src/pipeline/facts.js` |
| `PROMPT-4` | Task creation via tool definition `scheduler_create_task` | done | `src/pipeline/agent-tools/scheduler/scheduler_create_task.js` |
| `PROMPT-5` | Conversation topic extraction prompt | done | `extractTopics` in `src/pipeline/topics.js` |
| `PROMPT-6` | History summarizer prompt | done | `src/pipeline/history-compress.js` |
| `PROMPT-7` | Optional merge decision schema (`MergeDecision`) | no | conflicts resolved deterministically by similarity thresholds and source ranks |
| `PROMPT-8` | Configuration from the `config/` YAML hierarchy (`node-config` package) | done | `src/config.js` |
| `PROMPT-9` | Model selection per pipeline stage | done | `src/config.js`; actual values listed in the "Project Config" section below |

### Proactivity — `PROACT`

| Requirement ID | Short description | Status | Code reference / note |
|----------------|-------------------|--------|------------------------|
| `PROACT-1` | Three pillars (triggers, context, delivery) | partial | delivery implemented in Telegram (`src/telegram/bot.js`); email/push not done |
| `PROACT-2` | Topic tracking | partial | `src/pipeline/topics.js` works; engagement scoring is a rough metric |
| `PROACT-3` | Temporal context | done | `src/utils/temporal.js` |
| `PROACT-4` | Triggers, contact policy, and anti-spam | done | `src/pipeline/proactive.js`, `src/pipeline/proactiveContactPolicy.js`, `mem.proactive_contact_state` |
| `PROACT-5` | Return welcome and communicator style | done | `welcome_back` determined by incoming turn in `src/agent.js`; background return push not used |
| `PROACT-6` | External event relevance filter | partial | `src/pipeline/events.js`; source is a built-in news stub; contact policy applied before LLM relevance |
| `PROACT-7` | Proactivity run by a worker | partial | merged with `src/scheduler-run.js`; no separate process |

### Operations: Scheduler, Tools, Tests — `OPS`

| Requirement ID | Short description | Status | Code reference / note |
|----------------|-------------------|--------|------------------------|
| `OPS-1` | Reminder and background task scheduler | done | `src/pipeline/scheduler.js`; cron/rrule evaluated via `cron-parser` and `rrule` |
| `OPS-2` | Safe task acquisition (`FOR UPDATE SKIP LOCKED`) | done | `src/pipeline/scheduler.js` |
| `OPS-3` | Execution, rescheduling, error resilience | done | one-time, interval, cron, and rrule tasks all reschedule; schedule errors diagnosed |
| `OPS-4` | Agent tools and log | done | `src/pipeline/tools.js` (`executeTool`), `tool_calls` table |
| `OPS-5` | Logging | partial | `DEBUG`-level tracing and table logs present; no unified JSON logger |
| `OPS-6` | Tests against a real database and real models | done | `tests/run.js`, `npm test` — 36 of 36 |
| `OPS-7` | Check layers | done | `tests/run.js` (structure, extraction, mandatory tests, privacy, scenario, layers 6/7/8) |
| `OPS-8` | Twelve mandatory tests | done | `tests/run.js` |
| `OPS-9` | Testing rules (no mocks, real database) | done | `tests/run.js`, `tests/memory_cases.json` |

### Domain Specificity of Memory — `DOMAIN`

| Requirement ID | Short description | Status | Code reference / note |
|----------------|-------------------|--------|------------------------|
| `DOMAIN-1` | Domain tuning of fact extraction | done | `## Fact Extraction Prompt` block, mixed in by `extractFacts` (`src/pipeline/facts.js`) |
| `DOMAIN-2` | Domain addressing of facts | done | `domain_key` coordinate of `mem.user_facts`; retrieval covers the domain plus `general` |
| `DOMAIN-3` | Storage policies per fact row | done | per-type retention, source ranks, pinning (`src/pipeline/facts.js`, `config.facts`) |

### History Compression — `HIST`

| Requirement ID | Short description | Status | Code reference / note |
|----------------|-------------------|--------|------------------------|
| `HIST-1` | Block order in the request | done | `src/agent.js` (`messages` assembly) |
| `HIST-2` | Recommended parameters and profiles | done | `src/config.js`, `historyCompression` block |
| `HIST-3` | Gradient compression by zones | done | `summarizeColdHistory` in `src/pipeline/history-compress.js` |
| `HIST-4` | Memory vs history: separation of concerns | done | passing `active_memory` to the summarizer in `src/pipeline/history-compress.js` |
| `HIST-5` | Source priority on conflict | done | service header in `formatHistoryContext`, `src/pipeline/history-context.js` |
| `HIST-6` | Storage schema | done | `migrations/001_init.sql` |
| `HIST-7` | Configuration and hysteresis invariant | done | `src/config.js` (check `shrinkTokens < maxTokens`) |
| `HIST-8` | Context assembly algorithm | done | `buildHistoryContext` in `src/pipeline/history-context.js` |
| `HIST-9` | New pipeline modules | done | `history-context.js`, `history-compress.js`, `token-counter.js` |
| `HIST-10` | Token counting | partial | heuristic `estimateTokens` in `src/pipeline/token-counter.js`; no exact tokenizer (`tiktoken`) |
| `HIST-11` | Summarizer: prompt and response schema | done | `src/pipeline/history-compress.js` |
| `HIST-12` | Protection against leaks and harmful instructions | done | `formatHistoryContext` in `src/pipeline/history-context.js` |
| `HIST-13` | When to trigger compression (threshold, `compressSync`) | done | `maybeCompressHistory` in `src/pipeline/history-compress.js` |
| `HIST-14` | `layerHistory` check layer | done | `tests/run.js` (12 checks when `HISTORY_COMPRESSION_ENABLED`) |
| `HIST-15` | Acceptance criteria | done | confirmed by `layerHistory` layer |
| `HIST-16` | Implementation plan and metrics | partial | phased assembly complete; layered re-compression not implemented |

### Global Memory — `GLOB`

| Requirement ID | Short description | Status | Code reference / note |
|----------------|-------------------|--------|------------------------|
| `GLOB-1` | Boundary with always-on date/time block | done | `CURRENT_DATETIME` stays in the dynamic zone in `src/agent.js` |
| `GLOB-2` | Layer quality criterion | done | confirmed by `layerGlobalMemory` layer |
| `GLOB-3` | Two tables and `is_admin` flag | done | `migrations/001_init.sql`, seed of base facts |
| `GLOB-4` | `src/pipeline/global-memory.js` module | done | facts and knowledge base: retrieval, search, write, delete |
| `GLOB-5` | Admin permission check | done | `isAdmin` in `src/pipeline/admin.js`, `ctx.isAdmin` in `src/agent.js` |
| `GLOB-6` | Injecting `GLOBAL_FACTS` and `GLOBAL_KNOWLEDGE` blocks | done | `messages` assembly in `src/agent.js` |
| `GLOB-7` | Tools: knowledge base readable by all, writable by admin only | done | `buildToolDefs` and `executeTool` in `src/pipeline/tools.js` |
| `GLOB-8` | Minimization: `GLOBAL_FACTS_LIMIT` / `GLOBAL_RAG_LIMIT` limits | done | `src/config.js`, `globalMemory` block |
| `GLOB-9` | Configuration, flags, and CLI commands | done | `src/config.js`, `/fact-*` and `/kb-*` commands in `src/cli.js` |
| `GLOB-10` | Criteria `CRIT-19`…`CRIT-21` | done | see criteria section above |
| `GLOB-11` | `layerGlobalMemory` check layer | done | `tests/run.js` (16 checks when flags are enabled) |
| `GLOB-12` | Implementation order | done | confirmed by repository contents |

---

## Planned Improvements

This section replaces the "Simplifications and follow-ups" table that was previously in `12-appendix.md`. It records
areas where the current implementation of the described architecture is simplified. The listed simplifications do not
break the baseline 36 checks or the proactivity layer, but are important for an honest status picture.

| What | Current status | Related IDs | Where to continue |
|------|----------------|-------------|-------------------|
| Exact history tokenizer | character-based heuristic; no exact tokenizer | `HIST-10` | integrate `tiktoken` for the target model |
| Layered history re-compression | zone-based compression used; no layered re-compression | `HIST-16` | re-compress summaries across `near`/`middle`/`far` layers |
| External notification delivery | Telegram implemented; email and push not done | `PROACT-1`, `DATA-6` | transport-worker for remaining channels |
| Complex fact merging | conflict resolved by rules, no `MergeDecision` model | `PROMPT-7`, `MEM-6` | model-based conflict resolution |
| External event source | built-in news stub | `PROACT-6`, `CRIT-17` | external events API |
| Event test | smoke pass and deduplication, no deterministic relevance | `PROACT-6` | manual scenario or fixtures |
| Return trigger | incoming signal after pause in `handleMessage` | `PROACT-5`, `CRIT-16` | additional channel-side hints |
| Proactivity worker | merged with `src/scheduler-run.js` | `PROACT-7` | separate process at scale |
| Engagement scoring | rough metric (model plus smoothing) | `PROACT-2` | additional heuristics |
| Response streaming | standard response, no streaming | `ARCH-2` | streaming in `src/agent.js` and `src/llm.js` |
| System prompt caching | stable prompt is separated; cache not wired up | `ARCH-1` | cache the immutable part of the prompt |
| JSON logging | `DEBUG`-level tracing and table logs; no unified logger | `OPS-5` | configurable log level, correlation id |
| Scheduled memory cleanup | no `memory_cleanup` task | `DATA-4`, `OPS-1` | recurring `memory_cleanup` task in `scheduler.js` |

---

## Project Config

Concrete infrastructure values that are placeholders in the specification. The specification uses `<MAIN_MODEL>`,
`<AUX_MODEL>`, `<EMBED_MODEL>`, and `<LLM_PROXY_BASE_URL>`; the table below shows their actual values for this
project.

| Specification placeholder | Purpose | Project value | Path in `config` | Environment variable |
|---------------------------|---------|---------------|------------------|----------------------|
| `<OPENAI_BASE_URL>` | address of the OpenAI-compatible endpoint | `https://litellm.my-proxy.com/v1` or empty | `llm.baseURL` | `OPENAI_BASE_URL` |
| `<MAIN_MODEL>` | primary agent response model | `gpt-5.4-mini` | `llm.mainModel` | `MAIN_MODEL` |
| `<AUX_MODEL>` | cheap auxiliary model (classification, topics, summarizer) | `gpt-5.4-nano` | `llm.auxModel` | `AUX_MODEL` |
| `<MAIN_MODEL>` (fact extraction) | fact extraction into memory | `gpt-5.4-mini` | `llm.extractModel` | `EXTRACT_MODEL` |
| `<EMBED_MODEL>` | embeddings model (1536 dimensions) | `text-embedding-3-small` | `llm.embedModel` | `EMBED_MODEL` |

When `OPENAI_BASE_URL` is set, the OpenAI SDK routes requests to the proxy at that address; when unset, the direct
OpenAI API is used. A note on proxy speed: `gpt-5.4-*` family models on this proxy respond in roughly 5–10 seconds,
while `gpt-4o-mini` responds in roughly 1.2 seconds. For the fastest response times, set `MAIN_MODEL=gpt-4o-mini`.
All models are verified against the chosen endpoint by `tests/check-llm.js` (`npm run check:llm`): chat, strict JSON,
tool calling, and embeddings are all confirmed.

---

## Related Documents

- Specification entry point — [`docs/ai-bot-with-memory/README.md`](../docs/ai-bot-with-memory/README.md)
- Readiness criteria — [`docs/ai-bot-with-memory/02-criteria.md`](../docs/ai-bot-with-memory/02-criteria.md)
- Tests and check layers — [`docs/ai-bot-with-memory/10-operations.md`](../docs/ai-bot-with-memory/10-operations.md)
- History compression — [`docs/ai-bot-with-memory/13-history-compression.md`](../docs/ai-bot-with-memory/13-history-compression.md)
- Global memory — [`docs/ai-bot-with-memory/14-global-memory.md`](../docs/ai-bot-with-memory/14-global-memory.md)
