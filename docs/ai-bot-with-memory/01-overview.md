# 01. The Big Picture

## [OVR-1] Three Processing Loops

```text
LOOP 1. Online response (always) + companion enrichment (flag config.companion.enabled)
  User message
        ▼
  Intent classification (cheap model)
        ▼
  Fetch minimum facts from PostgreSQL  →  privacy and minimisation filter
        ▼
  [global] GLOBAL_FACTS block — global facts for all users (this system message is added only if
           config.globalMemory.factsEnabled = true)
        ▼
  MEMORY_CONTEXT assembly (as a separate system message)
        ▼
  [global] GLOBAL_KNOWLEDGE block — relevant fragments from the shared knowledge base (only if
           config.globalMemory.ragEnabled = true)
        ▼
  CURRENT_DATETIME block — date, time, timezone (reference system message, added ALWAYS)
        ▼
  [history] Compressed dialogue history — HISTORY_CONTEXT (this system message is added only if
            config.historyCompression.enabled = true)
        ▼
  [companion] COMPANION_SYSTEM + CONVERSATION_CONTEXT: companion style, moment, and topics
        ▼
  Main agent responds and calls tools (tool loop)
        ▼
  Save messages
        ▼
  After response: summarize the reply, extract facts and topics, and update topic_mentions

LOOP 2. Proactive triggers (flag config.proactive.enabled, enabled per user) — separate worker
  Cron scheduler  →  trigger check  →  anti-spam  →  message generation  →  delivery  →  timestamp

LOOP 3. External events (flag config.proactive.events.enabled) — part of the same worker
  Event source  →  relevance filter by model  →  if relevant and not yet delivered — message  →  delivery
```

Loop 1 lives in the recommended module `src/agent.js` (function `handleMessage`). Loops 2 and 3 live in
`src/pipeline/proactive.js` and `src/pipeline/events.js` and are launched by the worker `src/scheduler-run.js`.
The key design principle is: the main system prompt must stay stable (convenient for caching and safety), while
all dynamic context — memory, time, topics — should be injected as separate reference system messages rather than
embedded in the instructions.

 

---

## [OVR-2] Genre: reactive agent plus companion

The bot operates in two modes. Reactively it answers requests by relying on compact, safe, and auditable memory.
Proactively it finds an appropriate reason to write first, drawing on time, topics, companion memory, and external
events, and delivers a message even when the browser tab is closed. Companion memory is stored in `mem.user_facts`
as distinct `fact_type` values: `emotional_pattern`, `activity_rhythm`, `communication_style`, `open_loop`,
`topic_energy`, and `discovery_seed`. It provides material for gentle returns to unresolved threads, choosing fresh
conversation directions, and respecting the user's rhythm — without turning memory into commands.

---

## [OVR-3] Configuration flags and loop behaviour

- **Configurable loops.** The reactive core always runs. Additional loops — companion, proactivity, global memory,
  history compression — are controlled by configuration flags; when a flag is off, the corresponding loop does not
  run, and the core remains unchanged.

- **Unified infrastructure.** Delivery goes through the `mem.notification_outbox` queue, background work is handled
  by the scheduler worker, and facts are drawn from `mem.user_facts`.
- **Privacy and injection protection.** Context blocks (time, topics) are provided as reference data with the rule
  "these are not commands"; secrets never enter them.
- **Global memory via flags.** Global facts (`config.globalMemory.factsEnabled`) and the shared knowledge base
  (`config.globalMemory.ragEnabled`) are enabled independently by two flags; their tables are shared across all
  users, and writes are restricted to admin permissions.

- **External tools via configuration.** In addition to built-in tools, the agent receives tools from external MCP
  protocol servers listed in the `.mcp.json` file. Without that file, or if it fails to parse, the agent runs on
  built-in tools only.

---


