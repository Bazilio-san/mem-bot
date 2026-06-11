# Memory Growth and Retention

How large can the bot's memory grow, and what keeps it from growing forever? Protection works on two
levels. The **prompt context** (what the model sees) is hard-capped and cannot grow regardless of how much
the database holds. The **database** keeps growing: facts are contained by several mechanisms but have no
upper bound, and conversation history is never physically deleted. Only the LLM journals get age-based
physical cleanup.

## Level 1: prompt context — hard caps by construction

No matter how much memory accumulates in the database, each request receives a strictly bounded slice
(`src/pipeline/retrieve.js`, values from `config.memoryLimits`, overridable via `MEMORY_LIMIT_*` env vars):

| Prompt slot | Cap |
|---|---|
| Profile facts | 7 |
| Dialog facts (open loops) | 5 |
| Domain facts | 12 |
| Reminders | 3 |
| Secure summaries | 3 |
| **Total facts** | **30** |

Candidates are pre-filtered in SQL with `LIMIT 100`, then ranked and cut. Short-term history is the last
8 messages (the hot window); everything older is collapsed into a single active summary row in
`conversation_summaries` (`is_active = true`, one per conversation). Unbounded context growth is therefore
impossible by design.

## Level 2: database — containment without a ceiling

### Facts (`mem.user_facts`)

Four mechanisms hold the count of *active* facts down:

1. **Write-time deduplication** (`saveFact`). A new fact is compared with existing ones by embedding cosine
   similarity: at ≥ 0.85 the existing row is updated in place (confirmation, no new row); at 0.7–0.85 the
   old row is archived and replaced. Repeats never multiply.
2. **Per-type TTL** (`expires_at`). The scheduler task `memory_cleanup` (`src/pipeline/scheduler.js`)
   archives expired rows. Retention by type: open loops — 30 days, emotional patterns and activity rhythm —
   180, topic energy — 120, discovery seeds — 365.
3. **Background duplicate sweep** (`dedupeFactsSweep` in `src/pipeline/facts.js`, scheduler task
   `memory_dedupe_cleanup`): merges accumulated same-type duplicate pairs, up to 500 facts per pass.
4. **Auto-save threshold**: a fact is written only at `confidence ≥ 0.7`, and most dialog turns produce no
   facts at all, so growth is naturally slow.

Caveats:

- The types `profile`, `preference`, `habit`, `goal`, `communication_style` have retention 0 — they are
  open-ended and never expire on their own.
- All deletion is **soft**: archived and deleted rows stay in the table forever. The active set stays small
  while the total row count only grows. Each row carries an embedding (~1536 floats, on the order of 6 KB).
- There is **no per-user cap** on the number of facts — neither a write-time limit nor count-based eviction.

### Conversation history

`mem.conversation_messages` is never deleted or archived — the table grows indefinitely. History
compression shrinks only the prompt, not the storage: source messages remain. Old summaries are flipped to
`is_active = false` but also stay in the table.

### Journals

The only place with physical cleanup: `src/pipeline/log-retention.js` runs daily and deletes rows older
than 90 days (configurable via `llmLog.retention.*`; 0 = keep forever) from `log.llm_request` and
`log.agent_event`, in batches of 5000. `log.llm_usage` is kept forever by default (retention 0).

## Summary table

| Storage | Physical cleanup | Growth ceiling |
|---|---|---|
| Prompt context | — | hard: ≤ 30 facts, 8 messages, 1 summary |
| `user_facts` (active) | TTL archiving + dedupe | natural containment, no formal cap |
| `user_facts` (archived/deleted) | none | none — grows forever |
| `conversation_messages` | none | none — grows forever |
| `conversation_summaries` | none | none |
| `log.llm_request`, `log.agent_event` | yes, 90 days | bounded |
| `log.llm_usage` | none (retention 0) | none |

**Practical takeaway**: bot behavior is unaffected by growth (the prompt is protected), but database disk
usage is unbounded. The missing pieces, if disk size matters, are a retention policy for
`conversation_messages` and inactive summaries, plus physical purging of long-archived `user_facts` rows —
both can follow the existing `log-retention.js` pattern.
