# 13. Dialogue History Compression

## Terms

| Term | Meaning |
|------|---------|
| Hot window | The last `N` messages passed to the model verbatim. Default `N = 8`. |
| Cold zone | Everything older than the hot window. This is the part that gets compressed. |
| Digest | A compressed summary of the cold zone. Stored in `conversation_summaries`. |
| Gradient compression | The rule that recent messages are kept in more detail while older ones are compressed more aggressively. |
| Hysteresis | The gap between the compression trigger threshold and the target size, to avoid re-compressing on every message. |
| Token | The unit a model uses to measure the size of its input and output; cost and speed are driven by token count. |

---

## [HIST-1] Block order in the request

The compressed history is placed between long-term memory and the hot window, preserving the
"stable prompt at the top, dynamic content at the bottom" layout (see [04-architecture.md](04-architecture.md)):

```text
MAIN_SYSTEM            -- stable system prompt (convenient for caching)
MEMORY_CONTEXT         -- long-term memory: profile, domain, tasks, protected references
HISTORY_CONTEXT        -- compressed history of the current conversation
CURRENT_DATETIME       -- date, time, timezone; always present, but in the dynamic zone (changes every minute)
last N messages         -- hot window, verbatim
new user message
```

The core idea in brief: the last eight messages are left entirely untouched; everything older is turned into a
short digest; content closer to the present is kept in more detail while older content is compressed more
aggressively; facts already in long-term memory are not repeated in the history.

---

## [HIST-2] Recommended parameters and profiles

The default is a conservative, safe mode: the history should not outweigh long-term memory.

| Parameter | Value | Meaning |
|-----------|------:|---------|
| `historyCompression.hotWindow` | `8` | the last eight messages are not compressed at all |
| `historyCompression.maxTokens` | `2000` | if the cold zone exceeds this size, trigger compression |
| `historyCompression.shrinkTokens` | `800` | after compression the digest must be no larger than this |
| `historyCompression.zoneWeights` | `0.55, 0.30, 0.15` | share of the digest budget for the near, middle, and far zones |

Ready-to-use profiles: conservative (`6 / 1400 / 500`) for short conversations where speed and cost matter most;
balanced (`8 / 2000 / 800`) — the default; coherent (`10 / 3200 / 1300`) for tutoring, sales, consulting, and
long-running tasks. The `8 / 9000 / 2500` profile is **not recommended as a default**: a 2500-token digest
becomes heavier than the `MEMORY_CONTEXT` block itself (700–2000 tokens) and violates the main principle — the
history must not outweigh memory or inflate the request. Enable it deliberately and only after measuring cost
and latency.

---

## [HIST-3] How gradient compression works

The cold zone is split into three parts by age, and the digest budget is distributed unevenly — the portion
closest to the present gets the largest share:

| Zone | Share of the cold zone | Share of the digest budget | What to preserve |
|------|----------------------:|--------------------------:|-----------------|
| Near | last 40% | 55% | details, chosen options, recent constraints, user's exact wording |
| Middle | previous 35% | 30% | decisions, reasons, important turning points |
| Far | first 25% | 15% | only the overall meaning and key initial agreements |

This approach (zoning) rebuilds the entire digest from scratch on every trigger and is used by default.
An alternative for very long conversations is **layered re-compression** (summarising the summary): freshly cooled
messages become the top layer `layer = 'near'`, while the previous digest is compressed further and moves down to
`'middle'`, then `'far'`. This achieves the same gradient at lower cost (fewer summariser calls), but the quality
of the far layer degrades more over time. The `layer` field in the schema supports both approaches: with zoning a
single `full` row is active; with layered re-compression there are multiple `near` / `middle` / `far` rows that
are assembled into the final `HISTORY_CONTEXT`.

---

## [HIST-4] Memory vs. history: separation of roles

The roles of the three data sources are strictly separated to prevent duplication. Long-term memory answers
"what do we durably know about the user, domain, and tasks" and lives in `mem.user_facts`. Compressed history
answers "what happened in this specific conversation and where did we leave off" and lives in
`conversation_summaries`. Topic tracking (`topic_mentions`, criterion 13, see [09-proactivity.md](09-proactivity.md))
answers "which topics were discussed and how actively" — so the digest **does not need to re-list topics** if
that layer is enabled.

The main rule against duplication: before summarisation, the currently selected memory (`active_memory`) is
passed to the model, and the summariser receives a strict instruction not to repeat in `summary_text` any facts
already present in `active_memory`. Only the flow of the conversation remains in the history: decisions, open
questions, chosen options, and reasons for changes.

---

## [HIST-5] Source priority on conflict

When sources contradict each other, the following order applies (higher means more authoritative), and this rule
is explicitly stated in the `HISTORY_CONTEXT` service header:

```text
1. New user message
2. Last eight raw messages
3. Compressed conversation history
4. Long-term memory
5. Old far summaries
```

Example: if an old summary shows the user chose option A, but the recent messages indicate they switched to
option B, option B is considered current.

---

## [HIST-6] Storage schema and migration

The `mem.conversation_summaries` table and its service columns are defined in the single initialisation script
`001_init.sql` (see [05-data-schema.md](05-data-schema.md)). The set of service columns is idempotent — on an
existing database they are added via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`:

```sql
ALTER TABLE mem.conversation_summaries
ADD COLUMN IF NOT EXISTS layer text NOT NULL DEFAULT 'full'
  CHECK (layer IN ('near','middle','far','full')),
ADD COLUMN IF NOT EXISTS covered_from_message_id uuid,
ADD COLUMN IF NOT EXISTS covered_to_message_id   uuid,
ADD COLUMN IF NOT EXISTS covered_until           timestamptz,
ADD COLUMN IF NOT EXISTS source_message_count    integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS source_token_count      integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS summary_token_count     integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS memory_dedupe           jsonb   NOT NULL DEFAULT '{}'::jsonb,
ADD COLUMN IF NOT EXISTS summary_version         integer NOT NULL DEFAULT 1,
ADD COLUMN IF NOT EXISTS is_active               boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_summaries_active_conversation
ON mem.conversation_summaries (conversation_id, created_at DESC) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_summaries_covered_until
ON mem.conversation_summaries (conversation_id, covered_until DESC);
```

When a new active summary is created, all previous active summaries are deactivated (`is_active = false`), so
exactly one summary is active per conversation at any time. The service fields are stored as explicit columns
rather than inside `state_json`, which simplifies SQL queries and per-field lookups.

---

## [HIST-7] Configuration

The `config.historyCompression` branch is one of the fields of the `config` object, following the same style as
the `config.companion` and `config.proactive` branches. Default values are defined in `config/default.yaml`,
and boolean flags take the form `true` or `false`:

```yaml
# config/default.yaml
historyCompression:
  enabled: true           # compress the old portion of the conversation history; enabled by default
  hotWindow: 8
  maxTokens: 2000
  shrinkTokens: 800
  zoneWeights: [0.55, 0.30, 0.15]
  model: <AUX_MODEL>      # defaults to config.llm.auxModel
  minCompressGain: 0.35
```

At application startup, a hysteresis invariant is checked: `config.historyCompression.shrinkTokens` must be
strictly less than `config.historyCompression.maxTokens`; otherwise compression would trigger on almost every
message. The full list of settings is in [03-quickstart.md](03-quickstart.md); the overall configuration object
is described in [08-prompts-and-models.md](08-prompts-and-models.md).

---

## [HIST-8] Context assembly algorithm

Context assembly in `src/agent.js` works as follows: retrieve the hot window and the active summary; find
messages older than the hot window that are not yet covered by the summary (`coldPending`); calculate the
combined size of the summary and the uncovered tail; if it exceeds `config.historyCompression.maxTokens` —
invoke the summariser, passing it the active memory, and save the new summary; assemble `HISTORY_CONTEXT` and
pass it to the model together with the hot window and the new message.

```js
const memory = await retrieveMemory({ userId: user.id, domainKey: effectiveDomain, query: userMessage,
  scopes: intent.needed_memory_scopes || ['profile', 'dialog', 'domain'],
  entityKeys }); // entity values from the classifier — see MEM-2 in 06-memory.md
const memoryContext = buildMemoryContext(memory, effectiveDomain);

const historyContext = await buildHistoryContext({
  userId: user.id, conversationId: conversation.id, domainKey: effectiveDomain, memory });

const hotMessages = await getRecentMessages(conversation.id, config.historyCompression.hotWindow);

const messages = [
  { role: 'system', content: MAIN_SYSTEM },
  { role: 'system', content: memoryContext },
  ...(historyContext ? [{ role: 'system', content: historyContext }] : []),
  dateTimeSystem, // CURRENT_DATETIME — date, time, timezone; always present, in the dynamic zone
  ...hotMessages.map(toChatMessage),
  { role: 'user', content: userMessage },
];
```

The variables `intent`, `effectiveDomain`, `user`, `conversation`, and `userMessage` are context names from
`agent.js`. The target digest size is read from `config.historyCompression.shrinkTokens` inside
`maybeCompressHistory`, so the separate `maxTokens` parameter of `buildHistoryContext` does not affect the
threshold.

---

## [HIST-9] Pipeline modules

This layer consists of three files in `src/pipeline/`:

- **`history-context.js`** — `buildHistoryContext(...)`. Returns an empty string when the flag is disabled.
  Otherwise calls `maybeCompressHistory`, retrieves the active summary, and formats `HISTORY_CONTEXT` using
  `formatHistoryContext` — a system block with a service header (usage rules and priorities), the summary text,
  and the operational state.
- **`history-compress.js`** — `maybeCompressHistory(...)` checks the threshold to decide whether compression is
  needed, and if so calls `summarizeColdHistory(...)`, which splits the cold zone into `near` / `middle` / `far`,
  allocates the budget according to `config.historyCompression.zoneWeights`, passes `active_memory` to the
  summariser, and returns a structured result.
- **`token-counter.js`** — `estimateTokens(text)`: a conservative token-count estimate (see below).

```js
export async function maybeCompressHistory({ userId, conversationId, domainKey, memory }) {
  const hotWindow = config.historyCompression.hotWindow;
  const activeSummary = await getActiveConversationSummary(conversationId);
  const hotMessages = await getRecentMessages(conversationId, hotWindow);
  const boundaryCreatedAt = hotMessages.length ? hotMessages[0].created_at : new Date();
  const coldPending = await getColdPendingMessages({ conversationId, beforeCreatedAt: boundaryCreatedAt,
    afterMessageId: activeSummary?.covered_to_message_id || null });

  const coldSize = estimateSummaryTokens(activeSummary) + sumMessageTokens(coldPending);
  if (coldSize <= config.historyCompression.maxTokens) return { compressed: false, reason: 'below_threshold' };

  const result = await summarizeColdHistory({ activeSummary, coldPending, memory,
    targetTokens: config.historyCompression.shrinkTokens, zoneWeights: config.historyCompression.zoneWeights, domainKey });
  await saveConversationSummary({ conversationId, userId, result, coldPending });
  return { compressed: true, coldSize, summaryTokens: result.summary_token_count };
}
```

Access to summaries in `src/repo.js` is provided by the functions `getActiveConversationSummary`,
`saveConversationSummary`, `getColdPendingMessages`, and `markOldSummariesInactive`.

---

## [HIST-10] Token counting

Important: sizes are calculated **by our own code**, not by the model. `source_token_count` and
`summary_token_count` are computed from the `token_count` field of messages and summaries rather than being
queried from the summariser, because a language model counts its own tokens unreliably — which would cause the
threshold to drift.

The familiar rule of thumb "4 characters per token" is based on English text and **significantly underestimates**
the size for Cyrillic: Russian characters are encoded more densely. An underestimate is dangerous because it
means compression will trigger later than it should, allowing the cold zone to grow beyond the threshold.
Therefore a more conservative divisor is used for Cyrillic — approximately three characters per token:

```js
export function estimateTokens(text) {
  if (!text) return 0;
  const chars = String(text).length;
  const hasCyrillic = /[Ѐ-ӿ]/.test(text);
  const charsPerToken = hasCyrillic ? 3 : 4;
  return Math.ceil(chars / charsPerToken);
}
```

For threshold detection it is safer to overestimate than to underestimate; the heuristic divisor is preferred
over a model-specific tokeniser (such as `tiktoken`) to avoid pulling in an extra dependency just for a
threshold check. The `token_count` field in the `conversation_messages` table is populated when a message is
saved: the `saveMessage` function (`src/repo.js`) computes `token_count` alongside the `tool_name`,
`tool_call_id` fields and the `updated_at` update on the conversation.

---

## [HIST-11] Summariser: prompt and response schema

The summariser compresses only the cold zone (the most recent messages are not passed to it — they will be
added separately), does not duplicate facts from `active_memory`, describes near context in more detail than
far context, moves durable facts into `facts_to_memory`, does not store secrets in plain text, and does not
invent anything that did not occur. It returns strict JSON according to a schema (using the same `json_object`
plus schema text in the system message as described in [08-prompts-and-models.md](08-prompts-and-models.md)).

The response schema contains only semantic fields; token counts are **intentionally excluded** — they are
computed by the code:

```json
{
  "type": "object", "additionalProperties": false,
  "required": ["summary_text", "state_json", "facts_to_memory",
               "dropped_because_in_memory", "sensitive_mentions_redacted"],
  "properties": {
    "summary_text": { "type": "string" },
    "state_json": { "type": "object", "additionalProperties": true, "properties": {
      "current_goal": { "type": ["string","null"] }, "current_task": { "type": ["string","null"] },
      "decisions": { "type": "array", "items": { "type": "string" } },
      "rejected_options": { "type": "array", "items": { "type": "string" } },
      "open_questions": { "type": "array", "items": { "type": "string" } },
      "constraints": { "type": "array", "items": { "type": "string" } },
      "next_steps": { "type": "array", "items": { "type": "string" } } } },
    "facts_to_memory": { "type": "array", "items": { "type": "object", "additionalProperties": true } },
    "dropped_because_in_memory": { "type": "array", "items": { "type": "string" } },
    "sensitive_mentions_redacted": { "type": "array", "items": { "type": "string" } }
  }
}
```

### Candidates for long-term memory

The `facts_to_memory` field contains durable facts that are better stored in long-term memory rather than in
the history, in the same flat `{type, fact_text, confidence}` form that fact extraction produces. They cannot
be written directly: they go through the same `saveFacts` flow as ordinary fact extraction (see
[06-memory.md](06-memory.md)) with `source = 'history_summary'` — the lowest-ranked source, so a
summarizer fact never overwrites a fact stated directly by the user. This preserves the unified logic of
"confidence threshold → write-time semantic deduplication → confirm or replace instead of duplicating" and
does not bypass the auto-save rules.

---

## [HIST-12] Protection against leaks and harmful instructions

`HISTORY_CONTEXT`, like `MEMORY_CONTEXT`, is treated as reference material rather than commands (the same
protection against harmful instructions embedded in data as in criterion 11, see
[02-criteria.md](02-criteria.md)). The service header that declares the block as reference material, places the
current request and the last raw messages above the history, and forbids disclosing sensitive data is set
exactly once — in `formatHistoryContext`. Secrets are never written to the plain-text summary; instead the
value is replaced with a note such as "user mentioned protected data; the full value is hidden and will not
be disclosed without explicit consent".

---

## [HIST-13] When to trigger compression

The size check runs after every response, but the summariser itself is called only when the threshold is
exceeded: save the user and assistant messages, calculate the cold zone size, and do nothing if the threshold
has not been crossed. This way the main response is not slowed down by an extra model call, and by the time the
next message arrives `HISTORY_CONTEXT` is already ready. A `compressSync: true` mode is provided for tests,
which waits for summarisation to complete so that assertions can be made immediately. The stable block order
(stable prompt at the top, dynamic content at the bottom) preserves compatibility with caching of the initial
portion of the request.

---

## [HIST-14] Tests

The checks are organised as a `layerHistory` layer in `tests/run.js` (not in a separate file) and are executed
only when `config.historyCompression.enabled` is `true`; the layer is skipped when the flag is off. The layer
verifies twelve points:

| # | Test | What it checks |
|--:|------|----------------|
| 1 | Threshold not reached | the summariser is not called |
| 2 | Threshold reached | a new record is created in `conversation_summaries` |
| 3 | Size after compression | `summary_token_count <= config.historyCompression.shrinkTokens` |
| 4 | Hot window | the last eight messages are included in the request verbatim |
| 5 | Old messages | are not passed as a raw large block |
| 6 | Gradient | the near portion is more detailed than the far portion |
| 7 | Deduplication with memory | a fact from `user_facts` is not repeated in `summary_text` |
| 8 | Conflict | recent messages take precedence over the old summary |
| 9 | Secrets | protected data does not appear in the plain-text summary |
| 10 | Hysteresis | a couple of new messages after compression do not trigger re-compression |
| 11 | Feature disabled | when `config.historyCompression.enabled` is `false`, only the last eight messages are sent |
| 12 | Memory candidates | `facts_to_memory` goes through the normal memory-write pipeline |

---

## [HIST-15] Acceptance criteria

The feature is complete when: the last `N` messages are always passed verbatim; old history is not lost but
included in `HISTORY_CONTEXT`; `HISTORY_CONTEXT` does not exceed the configured size; recent old context is
preserved in more detail than older context; the history does not repeat facts from `MEMORY_CONTEXT`; secrets
do not appear in the plain-text summary; on conflict, recent messages take precedence over old history; when
the flag is disabled, only the last `N` messages are sent; and all layer checks pass automatically.

---
