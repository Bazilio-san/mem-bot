# 10. Operations: Scheduler, Tools, Logging, Tests

## [OPS-1] Reminder and Background Task Scheduler

The scheduler (`src/pipeline/scheduler.js`) can create tasks, safely claim overdue tasks across multiple workers,
execute a one-time task exactly once, reschedule recurring tasks, and never lose errors. Tasks themselves are created
by the main dialogue model via the `scheduler_create_task` tool; there is no separate step for extracting a task from
a message.

### [OPS-2] Safe Task Claiming

Multiple workers will never pick up the same task, thanks to the `FOR UPDATE SKIP LOCKED` technique combined with a
temporary `locked_until` lock.

```sql
WITH due AS (
  SELECT id FROM mem.scheduled_tasks
  WHERE status = 'active' AND next_run_at <= now()
    AND (locked_until IS NULL OR locked_until < now())
  ORDER BY priority ASC, next_run_at ASC
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
UPDATE mem.scheduled_tasks t
SET locked_by = $2, locked_until = now() + interval '2 minutes', updated_at = now()
FROM due WHERE t.id = due.id
RETURNING t.*;
```

### [OPS-3] Execution, Rescheduling, and Error Resilience

A reminder task places a message into `notification_outbox` and creates an execution record. The message text is the
task's `instruction` field, delivered to the user verbatim without any rephrasing. Therefore, when creating a task
with the `scheduler_create_task` tool, the model must write `instruction` as natural, first-person speech addressed
directly to the user — for example "Reminder: you wanted to call your mom", not a third-person service instruction
like "Remind the user to call their mom". A one-time task transitions to `completed` after success; a recurring task
receives a new `next_run_at` and becomes active again (the attempt counter resets). If execution fails, the error is
not lost: the attempt counter increments, the run is marked `failed`, a retry is scheduled in thirty seconds, and
once `max_attempts` is exhausted the task transitions to `failed`.

The worker runs as a separate process `src/scheduler-run.js` (`npm run scheduler`). It does not poll the database on
a fixed interval; instead it sleeps precisely until the next scheduled task is due (adaptive sleep) and wakes up
immediately whenever a new task is created. This instant wake-up is built on PostgreSQL's native asynchronous
notification mechanism: after inserting a task, the `createTask` function sends a notification on the
`scheduler_wake` channel (the `NOTIFY` command), and the worker listens on that channel via a dedicated connection
(the `LISTEN` command). The time until the next due task is computed by the `msUntilDueTask` function: it reads the
minimum `next_run_at` among free active tasks using the `idx_tasks_due` index and is therefore nearly free. Sleep
duration is clamped between two bounds, `config.scheduler.minSleepMs` and `config.scheduler.maxSleepMs` (defaults
250 and 30 000 milliseconds): the lower bound prevents the worker from spinning when tasks arrive back-to-back, and
the upper bound guarantees periodic database re-checks and adherence to the proactivity interval even when there are
no tasks at all. As a result, firing latency approaches zero, and the database and CPU are barely loaded during
idle periods — there are no empty polls while there is no work to do. This same worker, when the relevant flags are
enabled, runs the proactivity loops — see [09-proactivity.md](09-proactivity.md).

Precise next-run calculation is supported for all schedule types. `one_time` uses an absolute `run_at` and completes
the task after successful execution. `interval` calculates the next run from the moment of rescheduling, not from
the old `next_run_at`. `cron` uses `cron_expr` via `cron-parser` and respects `timezone`: the expression
`0 9 * * 1-5` means 09:00 in the user's local time on weekdays. `rrule` uses real iCalendar RRULE strings via the
`rrule` library; for rules without `DTSTART`, the code explicitly sets an anchor start so the result does not depend
on the library's default.

An invalid or empty IANA timezone does not crash the worker: the scheduler normalises it via `Intl.DateTimeFormat`
and falls back to `config.timezone` or `Europe/Moscow`. Invalid `cron_expr` and `rrule` values are not replaced with
a daily fallback: creating such a task is rejected with a clear error, and a rescheduling error on an already
existing task transitions it to `failed` and writes the reason to `mem.scheduled_task_runs.error_text`.

The result of `scheduler_create_task` preserves the machine-readable `next_run_at` field in UTC and additionally
returns `timezone`, `next_run_at_local`, `schedule_kind`, `cron_expr`, and `rrule`. This allows the model to confirm
a recurring schedule to the user in the task's local time without computing it from UTC manually.

Background memory tasks run on the same scheduler. `memory_cleanup` archives active records whose `expires_at` has
passed; `memory_dedupe_cleanup` runs semantic deduplication for a user, selects canonical rows, archives duplicates,
and writes an audit entry to `metadata.dedupe`. Both tasks are idempotent: a repeated run does not touch already
archived rows.

---

## [OPS-4] Agent Tools

Each agent tool lives in its own module inside the `src/pipeline/agent-tools/` directory. A single tool file
contains four parts of its contract: the technical `name`, a short human-readable `title`, the OpenAI function
definition `definition`, and the actual `handler`. The central module `src/pipeline/tools.js` contains no per-tool
logic: it imports the registry, assembles definitions for the model, returns `toolTitle(name)`, checks permissions,
invokes the appropriate `handler`, and logs the result.

Related tools are grouped into thematic subdirectories within `agent-tools/` to keep the directory navigable:
`global-fact/` — three global facts tools (`global_fact_add`, `global_fact_delete`, `global_fact_list`);
`global-knowledge/` — three shared knowledge base tools (`global_knowledge_add`, `global_knowledge_delete`,
`global_knowledge_search`); `memory/` — four personal memory tools (`memory_search`, `memory_list`,
`memory_forget_entity`, `memory_forget_all`); `voice/` — two voice output tools (`voice_or_text`,
`voice_set_preference`). Singular tools that do not form a group (`scheduler_create_task`, `secure_record_get`)
remain as files in the root of the directory. The `index.js` registry collects all modules regardless of location,
so subdirectories have no effect on tool set assembly or on tool names.

Descriptions for the model are written in English: this applies to `function.description` and to all `description`
fields within the JSON Schema parameters. `title` is not passed to the model as an instruction; it is a safe short
name for client-side statuses, observability logs, and UI events of the form "tool is being called". It is
`toolTitle(name)` that is substituted into the `toolTitle` field of the `tool.started` and `tool.completed` events
that the core emits around each tool call (see [ARCH-7] in [04-architecture.md](04-architecture.md)). Tool arguments
and results are not exposed in user-facing statuses or events. Coverage is mandatory: every name that appears in
`buildToolDefs(ctx)` under any combination of permissions and flags must have a non-empty `title` (i.e.
`toolTitle(name)` must not equal the name itself); this is verified by the tool registry test.

Every call either genuinely mutates database state or reads from a real source, and is recorded in the `tool_calls`
log with input, output, status, and latency.

| Tool | Title | Purpose |
|------|-------|---------|
| `memory_search` | Searching personal memory... | search for relevant facts in memory (vector or full-text) |
| `scheduler_create_task` | Creating reminder... | create a reminder, recurring task, or follow-up check |
| `secure_record_get` | Fetching secure record... | retrieve a full protected value strictly by purpose and consent |
| `memory_list` | Showing personal memory... | show the user their saved personal memory facts |
| `memory_forget_entity` | Deleting fact from personal memory... | soft-delete a specific personal memory entity |
| `memory_forget_all` | Performing full personal memory deletion... | delete all active personal memory after explicit confirmation |
| `global_fact_add` | Adding global fact... | add a global fact (admin only, flag `config.globalMemory.factsEnabled`) |
| `global_fact_delete` | Deleting global fact... | delete a global fact (admin only, flag `config.globalMemory.factsEnabled`) |
| `global_fact_list` | Showing global facts... | show global facts (admin only, flag `config.globalMemory.factsEnabled`) |
| `global_knowledge_search` | Searching knowledge base... | search the shared knowledge base (all users; flag `config.globalMemory.ragEnabled`) |
| `global_knowledge_add` | Adding to knowledge base... | add text to the shared knowledge base (admin only, flag `config.globalMemory.ragEnabled`) |
| `global_knowledge_delete` | Deleting from knowledge base... | delete text from the shared knowledge base (admin only, flag `config.globalMemory.ragEnabled`) |
| `voice_or_text` | Configuring reply format... | toggle reply format between text and voice (flag `VOICE_OUTPUT_ENABLED`) |
| `voice_set_preference` | Configuring reply voice... | save the user's preferred voice output timbre (flag `VOICE_OUTPUT_ENABLED`) |

The tool set is assembled per-request by `buildToolDefs(ctx)`: global memory tools are included only when their
flags are enabled, and administrative tools only for administrators. The permission check is duplicated in the
`executeTool` wrapper: a call to an administrative tool by a non-administrator is rejected and logged.

The tool registry is the authoritative source of actions that the model can promise and perform. The skills registry
is not such a source on its own: a skill selects context, memory, and domain schema, and restricts the available
domain tools via its `tools.allowed` list, but it does not become a public capability without a corresponding tool.
In responses about capabilities, the list of domains is not passed to the model; the bot derives actions from tool
definitions and the RAG editorial article.

A separate group is the skill-editing tools (`skill_author_*`): creating a skill from a description, reading and
validating it, editing fields, prompt blocks, domain schema and lookup tables, enabling, disabling, deleting, and
reloading the registry. They are available only to administrators and only when the `SKILL_AUTHORING_ENABLED` flag is
enabled; the model manages them through the `skill-author` editor skill (see
[11-per-domain-schema.md](11-per-domain-schema.md)). Generative tools return a preview by default and write to disk
only after confirmation; writes and deletions are restricted to the skills directory. Every operation passes through
`executeTool` and is therefore logged in `tool_calls`.

Logging and error handling live in a single `executeTool` wrapper: both success and failure are recorded in
`tool_calls`, and the return value is either the result or an object with an `error` field.

```js
export async function executeTool(ctx, name, args) {
  const started = Date.now();
  const tool = getTool(name);
  if (!tool) return { error: `Неизвестный инструмент: ${name}` };
  if (tool.requiresAdmin && !ctx.isAdmin) {
    await logToolCall({ conversationId: ctx.conversationId, userId: ctx.userId, toolName: name,
                        input: args, status: 'blocked', latencyMs: Date.now() - started,
                        error: 'Требуются права администратора' });
    return { error: 'Это действие доступно только администратору.' };
  }
  try {
    const output = await tool.handler(ctx, args);
    await logToolCall({ conversationId: ctx.conversationId, userId: ctx.userId, toolName: name,
                        input: args, output, status: 'success', latencyMs: Date.now() - started });
    return output;
  } catch (err) {
    await logToolCall({ conversationId: ctx.conversationId, userId: ctx.userId, toolName: name,
                        input: args, status: 'failed', latencyMs: Date.now() - started,
                        error: String(err.message || err) });
    return { error: String(err.message || err) };
  }
}
```

A deliberate design decision: the memory write tool is not given directly to the main agent — writes happen through
a separate loop after the response (see [06-memory.md](06-memory.md)).

---

## [OPS-4a] External Tool Sources (MCP)

In addition to the built-in `agent-tools/*` modules, tools are also provided to the agent by external servers
running the **MCP (Model Context Protocol — an open standard by which a separate process exposes a set of tools to a
language model)**. Their tools are added to the same registry and are visible to the model on equal footing with
built-in tools, so the tool loop from [04-architecture.md](04-architecture.md) makes no distinction between them.

The list of servers to connect is read from the `.mcp.json` file in the MCP-client format: an `mcpServers` object
where the key is the server's short name (its `alias`) and the value is the server description. This file is kept
out of version control: each environment has its own copy and it may contain secrets. The path to the file can be
overridden with the `MCP_CONFIG_PATH` environment variable. The recommended implementation modules are
`src/mcp/config.js` (reading and parsing the file) and `src/mcp/client.js` (connecting, wrapping tools,
reconnecting).

Server record fields:

| Field | Purpose |
|-------|---------|
| `type` | transport: `http` and `sse` (streaming HTTP) are supported |
| `url` | server address; required |
| `headers` | transport headers — the place for an authorization token (optional) |
| `title` | human-readable server name for logs and statuses (optional) |
| `requiresAdmin` | if `true`, the server's tools are available to administrators only (optional) |
| `disabled` | if `true`, the server is skipped without removing the record (optional) |

Each server tool is registered under the name `<alias>__<original_name>`: the prefix exists only on the model side,
while the call to the server itself uses the original name. The description and JSON Schema for parameters are taken
from the server's response, so the wrapper does not duplicate the tool contract. The human-readable name for
statuses and the log is built as `<server title>: <tool name>`, so that `toolTitle(name)` does not return the
technical `<alias>__…` form.

The connection is **lazy and one-time**: the registry is augmented with MCP tools on the first message and reused
afterwards (the `initTools` initialisation function, see [04-architecture.md](04-architecture.md)). The
`requiresAdmin` and `disabled` attributes from the server configuration require no separate access-control code —
they are forwarded to the tool wrapper and handled by the same `requiresAdmin`/`isEnabled` mechanisms as built-in
tools, while permission checking, logging, and error handling are inherited from the shared `executeTool` wrapper.

Fault tolerance is required at two levels. A missing `.mcp.json` file, malformed JSON, or an invalid structure do
not crash the process: the server list becomes empty, the reason is written to the log, and the agent operates on
built-in tools. A server that is unavailable at startup is logged and skipped without blocking the others. A tool
call carries a 90-second timeout so that a hung server cannot block the reasoning chain; on an error that looks like
a connection drop, one reconnection attempt is made followed by a retry.

For debugging server interactions, every MCP tool call is traced: the request (tool name and arguments) and the
response (content and error flag) are printed to `stderr`, as is any reconnection event. Tracing is enabled by the
`mcp:tool` category in the `DEBUG` environment variable (e.g. `DEBUG=mcp:tool` or `DEBUG=*`) and is off by default;
the general debug-category mechanism is described in section [OPS-5].

---

## [OPS-5] Logging

- **Tool audit.** Every call is recorded in `mem.tool_calls` with arguments, result, status, latency, and error. A
  tool that mutates state without a log entry is considered a defect.
- **Model request log.** Every call to the language model and to related services (embeddings, speech recognition
  and synthesis) is recorded in the `log` schema of the separate logs database (tables `log.llm_request` and
  `log.llm_usage`, see [05-data-schema.md](05-data-schema.md), section [DATA-12]; the connection is
  `config.db.postgres.dbs.logs`, with empty host/port/user/password inherited from the memory-database
  connection, so a single-server install needs no extra credentials). Recording is designed to not delay the user
  response and to never crash the main flow: a single emitter (`src/pipeline/llm-log.js`) accumulates records in
  a buffer, and a background timer every `config.llmLog.flushIntervalMs` picks up a batch of up to
  `config.llmLog.batchSize` entries and writes them to `log.llm_request` with a single multi-row `INSERT`; a
  database trigger then populates the narrow `log.llm_usage` table. Any preparation or insertion error is
  suppressed inside the emitter. The request body is stored in `payload` and the model's reply in `response`,
  each truncated to `config.llmLog.maxPayloadChars` (in which case `payload_truncated` or `response_truncated`
  is set); when a streaming call fails midway, the part of the reply assembled so far is still stored with
  `status='error'`. For binary data (audio), only file metadata is stored; for embeddings, only the vector
  shape. The type of each call is set by the `request_kind` field: for embeddings, speech recognition, and
  synthesis it is derived from the endpoint, while for `chat.completions` it must be passed explicitly by the
  calling code — an omission is marked with the type `untyped` and emits a warning to the log. On graceful
  process shutdown, the remaining buffers are flushed (`flushLlmLog`, `flushAgentEventLog`) so that no tail of
  the journals is lost. Call cost is computed from a model price list (`src/pipeline/llm-pricing.js`): the model
  name is normalised to a price-list key, input and output tokens are billed at their respective per-million
  rates, and cached input tokens are billed at half price; if a model is not found in the price list the cost is
  left empty and a one-time warning is emitted. Fast cost aggregates (total for a period, breakdown by request
  type and by user) are computed on top of the narrow table by `src/pipeline/llm-usage-stats.js`. Logging is
  enabled by the `config.llmLog.enabled` flag; when set to `false`, both journal emitters become no-ops and
  write nothing.
- **Agent event journal.** Alongside the model calls, the agent journals the events of every conversation turn
  into `log.agent_event` (see [DATA-12]): the turn start, pipeline stages, tool calls with full arguments and
  results and their durations, connections to external MCP tool servers, the final answer, and failures. The
  writer (`src/pipeline/agent-event-log.js`) is a separate emitter built on the same buffered batch machinery
  (`src/pipeline/log-writer.js`) and the same correlation context as the model-call log, so all events of a turn
  share its `request_id`. It is deliberately independent of the display-channel event callback: journaling works
  with no delivery adapter attached, and — unlike display events — it stores tool arguments and results, because
  the journal is read only by operator tooling. The turn's `request_id` is also written into the `metadata` of
  the saved dialog messages, which lets operator tooling open the full journal of the cycle behind any message.
- **Log retention.** Journal tables are cleaned by age: a background pass right after startup and then once a
  day deletes rows older than the configured thresholds (`config.llmLog.retention`: `llmRequestDays` and
  `agentEventDays` default to 90, `llmUsageDays` defaults to 0 — the narrow cost table is kept forever, as it
  is small and feeds all-time cost statistics; 0 disables cleanup for a table). Deletion runs in primary-key
  batches so the pass never holds long locks (`src/pipeline/log-retention.js`); a cleanup failure is logged and
  never affects the application. Because the journals live in their own database, backup policy is independent
  of user data.
- **Scheduler runs.** Every execution is recorded in `mem.scheduled_task_runs`. Task errors are never lost.
- **Debug tracing.** Enabled by the `DEBUG` environment variable with a comma-separated list of categories: the
  `llm` category prints the model request, its response, and tool calls to `stderr`; the `mcp:tool` category prints
  requests to external MCP-server tools and their responses (see [OPS-4a]); `*` enables all categories. Tracing
  goes to `stderr` to avoid mixing with user output, and is off by default.
- **Privacy in logs.** The full value of protected data never appears in logs — only the record type and the fact
  of access with its stated purpose.

---

## [OPS-6] Tests and Verification Scheme

The core requirement is that the model must not "look at the code and say everything is fine". Verification proceeds
in layers against a real PostgreSQL instance and real models via a proxy (`tests/run.js`, `npm test`) and exits with
a non-zero code on any failure. The base layer provides a fixed set of checks; when `config.proactive.enabled` is
set, a proactivity check layer is added.

### [OPS-7] Verification Layers

1. **Database structure.** Base tables are created; indexes exist on `user_id`, `status`, `expires_at`, a vector
   HNSW index, and a full-text GIN index; foreign keys are present; sensitive data lives in a separate encrypted
   table; a minimal CRUD cycle passes.
2. **Fact extraction** against the `tests/memory_cases.json` dataset: stable preferences are saved, noise is not,
   passport and phone number are recognised as sensitive. Threshold — 80% correct cases (permissible model
   variability).
3. **Twelve mandatory tests** (see below).
4. **Protected data privacy**: summary without the full value; refusal without consent; success with consent and
   purpose; refusal without a stated purpose.
5. **Full tutor dialogue scenario**: topic and style are saved, a reminder is created, memory is retrieved by
   selection on return.
6. **Proactivity and companion mode** (only when `config.proactive.enabled`): a separate layer that does not
   affect the base run.
7. **Dialogue history compression** (only when `config.historyCompression.enabled`): the `layerHistory` layer,
   which does not affect the base run. Verifies the threshold, hot window, digest size, gradient, deduplication
   against memory, conflicts, secrets, hysteresis, flag disabling, and the `facts_to_memory` loop — see
   [13-history-compression.md](13-history-compression.md).
8. **Global memory** (only when `config.globalMemory.factsEnabled` or `config.globalMemory.ragEnabled`): the
   `layerGlobalMemory` layer, which does not affect the base run. Verifies structure, always-on facts, knowledge
   base search, administrator permissions, and privacy — see [14-global-memory.md](14-global-memory.md).
9. **Tool human-name coverage.** All combinations of user permissions and global-memory and voice-output flags are
   iterated; for every name appearing in `buildToolDefs(ctx)`, it is verified that `toolTitle(name)` does not equal
   the name itself, meaning a human-readable name has been defined.
10. **Streaming response assembly.** Standalone unit tests without network (`tests/streaming.test.mjs`) verify the
    pure accumulator functions: text accumulation, assembling a single tool call from fragments, assembling two
    calls with different indexes, and the absence of a `tool_calls` field when no tools were used. Real streaming
    output from the proxy (text in chunks and streaming tool-call deltas) is verified by
    `tests/check-streaming.js` (`npm run check:streaming`).
11. **Skill registry and authoring tooling.** Unit tests without network: `tests/skills.test.mjs` verifies skill
    file parsing, selection by domain key, and tool filtering; `tests/skill-authoring.test.mjs` verifies building
    `SKILL.md` from parts and reverse parsing, skill validation rules before writing, and the restriction of writes
    and deletions to the skills directory.
12. **Call and event journals.** Three tiers. Unit tests without a database (`npm run test:llm-log`) verify the
    shared buffered writer (batching, early flush, returning a failed batch, buffer overflow, JSON truncation
    edge cases), the record builders of both journals (including storing and truncating the model reply, and the
    correlation context), the assembly of a cycle's display timeline from journal records merged with agent
    events (with graceful degradation to synthesis from payloads when no events exist), age-based retention
    batching, and the analysis-engine plumbing (model allow-list, prompt composition, CLI subprocess streaming,
    timeout, and output cap). Integration tests against the real databases (`npm run test:llm-log-db`) verify
    the user timeline (messages merged with service-call groups, keyset pagination), the cycle journal, retention
    on live tables, the idempotency of the historical-transfer script, and the HTTP layer of the operator API
    including the analysis stream. The end-to-end layer inside the main run (`tests/run.js`, layer 10) verifies
    that after a real `handleMessage` the logs database contains the turn's records with the stored reply, the
    agent events, and the `request_id` in the metadata of both saved dialog messages.

### [OPS-8] Twelve Mandatory Tests

```text
1.  Saves a stable preference.
2.  Does not save a throwaway phrase.
3.  Sensitive data requires confirmation and is not saved as a regular fact.
4.  Updates an old fact (Moscow → Kazan) rather than creating duplicates.
4b. Semantic style deduplication leaves no active duplicates across different `scope` values.
4c. A feature request is not duplicated across `goal`, `reminder`, and `constraint`.
4d. A single-trip context is not duplicated across `dialog open_loop`, `domain goal`, and `progress`.
4e. Maintenance-dedup in dry-run changes nothing, while apply archives duplicates with `metadata.dedupe`.
5.  Retrieves only relevant subject-matter memory from another domain and does not expose secrets.
6.  Does not bloat the prompt: profile ≤ 7, domain ≤ 12, total ≤ 30, no full passport number.
7.  The current request (Kazan) takes priority over older memory (Moscow).
8.  Creates a reminder as a real row in scheduled_tasks; at the same time the event contract is verified via
    `onEvent`: `agent.started` comes first, `tool.started` comes before the tool call and before
    `assistant.completed`, the tool call event has a human-readable tool name, and `agent.completed` is present at
    the end.
9.  The scheduler executes a one-time task exactly once; 9b — a recurring task is rescheduled; 9c — an error is
    recorded; 9d/9e — cron/RRULE, timezone, schedule errors, and saving a cron task via the tool.
10. The tool is actually called, not simulated with text.
11. A harmful entry in memory is not executed as an instruction (passport not disclosed).
12. The user can delete a single record and forget everything.
```

### Layer 6: Proactivity Checks

Runs only when `config.proactive.enabled` is set (`layerProactivity` in `tests/run.js`) and adds the following
proactivity checks:

- **Structure.** The tables `topic_mentions`, `proactive_triggers`, `proactive_contact_state`, and
  `event_deliveries` are created and have indexes.
- **Temporal context.** Correct time-of-day and day-type values; a three-hour pause is formatted in hours.
- **Topic tracking.** A repeated `upsertTopicMentions` increments the counter to two and smooths engagement;
  `getTopicContext` classifies the topic as highly engaged and recognises a burned-out topic after five mentions
  with low engagement.
- **Contact policy.** A clean check permits a soft initiative in active mode, blocks a new soft initiative without
  a reply, permits a high-importance follow-up after a long pause, transitions the user to silence after repeated
  non-response, and prohibits background social messages.
- **Contact state.** `recordProactiveSent` increments `unanswered_proactive_count`; a repeated soft initiative
  transitions state to `quiet`; an incoming message resets the counter and `quiet_until` and produces a
  `welcome_back` signal after a long pause.
- **Triggers and anti-spam.** `ensureDefaultTriggers` creates exactly four triggers idempotently and with all of
  them disabled by default; `welcome_back` does not fire from background silence; `inactivity` is ready to fire
  when the pause exceeds the threshold; after `fire`, a subsequent `shouldFire` check returns `false`.
- **Delivery.** Text is generated, placed into `notification_outbox` with `payload.kind = 'proactive'`, and appears
  in the dialogue history.
- **Duplicate event protection.** The uniqueness constraint on `event_deliveries` prevents double delivery; a
  `processEvents` pass completes without errors.

### Layer 8: Global Memory Checks

Runs when `config.globalMemory.factsEnabled` or `config.globalMemory.ragEnabled` is set (`layerGlobalMemory` in
`tests/run.js`). Facts and knowledge base checks are enabled independently by their respective flag:

- **Structure.** The tables `global_facts` and `global_knowledge` are created; the column `mem.users.is_admin`
  exists; there is an active-facts index, a full-text GIN index, and a vector HNSW index for the knowledge base;
  the global tables have no `user_id` column and no encrypted secrets.
- **Global facts** (when `config.globalMemory.factsEnabled`). A seeded creator fact appears in the `GLOBAL_FACTS`
  block; the fact count limit is respected; a disabled fact is not injected; a domain fact is visible in its own
  domain and not visible in another.
- **Shared knowledge base** (when `config.globalMemory.ragEnabled`). Text is found by a close query and not
  returned for an unrelated one; deleting by identifier removes the fragment from results; the fragment count limit
  is respected.
- **Administrator permissions.** A non-administrator receives a refusal on write (refusal is recorded as
  `blocked`); an administrator performs the same write successfully.

### Layer 9: Voice Output Checks

Runs when `VOICE_OUTPUT_ENABLED` is set (`layerVoiceOutput` in `tests/run.js`). Verifies the core of the voice
output contract:

- **Structure.** `mem.users` has a `reply_mode` column with a default value of `text` and a nullable
  `voice_output_voice` column; a new user is created without a selected voice timbre.
- **Reply format.** `voice_or_text` saves `voice` or `text`, marks `ctx.replyMode`, and returns the saved value.
- **Voice timbre.** `voice_set_preference` validates the selection, saves `voice_output_voice`, marks
  `ctx.voiceOutputVoice`, and returns an error for unknown values without writing.
- **Result contract.** `handleMessage` returns `replyMode` and `voiceOutputVoice` so that the delivery channel can
  make its decision without an additional database read.

### [OPS-9] Testing Rules

Tests use a real database and real models (no mocks), create a fresh user per case, check structure before
behaviour, allow limited model variability expressed as a fraction of correct cases, and exit with a non-zero code
on failure. Disabling, commenting out, or skipping failing tests to get a green run is prohibited: the root cause
must be found and fixed. When flags are disabled, the base check layer remains unchanged. The `layerHistory` layer
is activated by the separate `config.historyCompression.enabled` flag and likewise does not affect the base run;
before making changes, the current number of passing checks must be recorded and must not decrease afterwards. The
`layerGlobalMemory` layer is activated by the `config.globalMemory.factsEnabled` and
`config.globalMemory.ragEnabled` flags and likewise does not affect the base run.

---


