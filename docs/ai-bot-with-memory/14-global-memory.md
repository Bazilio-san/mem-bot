# 14. Global Memory Layer: Global Facts and Shared Knowledge Base

## [GLOB-1] Boundary with the Always-On Date/Time Block

The response pipeline already contains a dedicated always-on reference block, `CURRENT_DATETIME`, which holds the
current date, time, day of the week, and timezone (see [04-architecture.md](04-architecture.md) and
[09-proactivity.md](09-proactivity.md), criterion 14). It is also present in every request, but **it is not part of
this layer and stays in its own place**. The reason is caching: the content of `CURRENT_DATETIME` changes every
minute, so the block is intentionally placed in the dynamic zone of the prompt — as the last system message before
the dialogue — to avoid breaking the stable prefix cache. Global facts, by contrast, change infrequently and are
identical for all users, so it is more efficient to keep them closer to the stable beginning of the prompt (see
section `GLOB-6`). Both blocks are always-on, but they live in different prompt zones for different reasons, and
the two should not be mixed.

---

## [GLOB-3] Two Tables and the Admin Flag

The layer maintains two tables in the `mem` schema and one column in the users table. Everything is defined by the
single initialisation script `001_init.sql` using the same idempotent patterns as the rest of the schema:
`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. The existing type
`mem.memory_status` is reused for status values. The vector dimension `vector(1536)` matches personal memory, so
the vector layer is equally optional: when embeddings are unavailable, knowledge-base search falls back to
full-text search.

```sql
-- Manual admin flag. Only an admin can populate and clean global memory.
ALTER TABLE mem.users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;

-- Global facts (always-on): short entries mixed into every request.
CREATE TABLE IF NOT EXISTS mem.global_facts (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id   uuid REFERENCES mem.agent_domains(id),   -- NULL = fact applies to all domains
    fact_text   text NOT NULL,
    priority    integer NOT NULL DEFAULT 100,            -- lower number = higher in the list when trimming to limit
    enabled     boolean NOT NULL DEFAULT true,
    created_by  uuid REFERENCES mem.users(id) ON DELETE SET NULL,
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_global_facts_enabled ON mem.global_facts (enabled, priority) WHERE enabled = true;

-- Shared knowledge base (RAG): texts visible to all, mixed in by relevance to the request.
CREATE TABLE IF NOT EXISTS mem.global_knowledge (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    domain_id   uuid REFERENCES mem.agent_domains(id),   -- NULL = knowledge shared across all domains
    title       text,
    content     text NOT NULL,
    tags        text[] NOT NULL DEFAULT '{}',
    importance  numeric(3,2) NOT NULL DEFAULT 0.50 CHECK (importance >= 0 AND importance <= 1),
    status      mem.memory_status NOT NULL DEFAULT 'active',
    source      text,                                     -- where the text came from (document, URL, author)
    created_by  uuid REFERENCES mem.users(id) ON DELETE SET NULL,
    embedding   vector(1536),
    search_tsv  tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,''))
    ) STORED,
    metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_global_knowledge_domain_status ON mem.global_knowledge (domain_id, status);
CREATE INDEX IF NOT EXISTS idx_global_knowledge_search_tsv    ON mem.global_knowledge USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS idx_global_knowledge_embedding     ON mem.global_knowledge
                                                              USING hnsw (embedding vector_cosine_ops)
                                                              WHERE embedding IS NOT NULL;
```

The knowledge base additionally carries a **text-to-vector integrity trigger** (migration
`002_global_knowledge_embedding_trigger.sql`). Any `UPDATE` that changes `title` or `content` without supplying a
new vector in the same statement resets `embedding` to `NULL`: a stale vector no longer describes the content and
must not participate in semantic search. This guarantee holds **by construction** — even when a record is edited
bypassing the application (psql, a script, third-party code) — while the record stays discoverable through the
full-text fallback until the vector is recomputed. When the application writes the text and a fresh vector in one
`UPDATE`, no reset happens. The trigger also maintains `updated_at` on every update.

```sql
CREATE OR REPLACE FUNCTION mem.global_knowledge_reset_embedding()
RETURNS trigger AS $$
BEGIN
    IF (NEW.title IS DISTINCT FROM OLD.title OR NEW.content IS DISTINCT FROM OLD.content)
       AND NEW.embedding IS NOT DISTINCT FROM OLD.embedding THEN
        NEW.embedding := NULL;
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_global_knowledge_reset_embedding
    BEFORE UPDATE ON mem.global_knowledge
    FOR EACH ROW
    EXECUTE FUNCTION mem.global_knowledge_reset_embedding();
```

With these two tables the total number of tables in the schema is nineteen (including the domain directory
`mem.agent_domains` and the message external references table `mem.message_external_refs`, see
[05-data-schema.md](05-data-schema.md)). The `is_admin` column intentionally lives in `mem.users` rather than in a
separate roles table: the requirement calls for exactly one manual "admin" flag, and building a full role system for
a single boolean attribute would violate the "build only what was asked for" principle. Assigning an admin is done
manually in the database with a single query, for example
`UPDATE mem.users SET is_admin = true WHERE external_id = '<id>';`.

The same migration seeds a set of baseline global facts about the bot itself and general statements defined by the
creator. The seed is idempotent: each fact is inserted only when no record with the same text already exists
(`INSERT ... SELECT ... WHERE NOT EXISTS`), so running the migration again does not create duplicates. The specific
set of seeded facts is part of the project implementation, not a mandatory part of the specification: a portable
system only needs to provide a seeding mechanism; the content is defined per project.

---

## [GLOB-4] The `src/pipeline/global-memory.js` Module

All access to global memory is concentrated in a single module, analogous to `src/pipeline/admin.js` for personal
memory (see [06-memory.md](06-memory.md), section `MEM-7`). The module exposes read functions (fetching active
facts and searching the knowledge base) and write functions (adding, deleting, enabling/disabling). The write
functions do not check permissions themselves — permission checking is done by the calling layer (agent tools and
interactive commands) so that access control stays in one place.

```js
// --- Global facts (always-on) ---
// Currently active: enabled = true AND (domain_id matches current domain OR domain_id IS NULL). Sorted by priority, trimmed to limit.
export async function getActiveGlobalFacts({ domainKey, limit }) { /* ... */ }
export async function listGlobalFacts({ includeDisabled = true } = {}) { /* for admin commands: show id and text */ }
export async function addGlobalFact({ factText, domainKey, priority, createdBy }) { /* ... */ }
export async function deleteGlobalFact(id) { /* hard delete or enabled = false per project policy */ }
export async function setGlobalFactEnabled(id, enabled) { /* ... */ }

// --- Shared knowledge base (RAG) ---
// Semantic and full-text search: vector plus full-text, ranking, hard limit. Readable by everyone.
export async function searchGlobalKnowledge({ domainKey, query: userQuery, limit }) { /* ... */ }
export async function addGlobalKnowledge({ title, content, domainKey, tags, importance, source, createdBy }) { /* ... */ }
export async function deleteGlobalKnowledge(id) { /* soft delete: status = 'deleted' */ }

// --- Knowledge base CRUD for management interfaces ---
// The embedding vector never leaves the database: clients only see the hasEmbedding flag.
export async function listGlobalKnowledge({ statuses }) { /* full records with hasEmbedding, default active+archived */ }
export async function getGlobalKnowledgeById(id) { /* one record in the same shape, or null */ }
export async function updateGlobalKnowledge(id, fields) { /* update + immediate embedding recompute */ }
export async function reembedGlobalKnowledge(id, { force }) { /* fill a missing vector; force recomputes always */ }
export async function searchGlobalKnowledgeText({ q, statuses }) { /* fuzzy text search with a relevance score */ }
```

Both `getActiveGlobalFacts` and `searchGlobalKnowledge` always respect the domain: they return records for the
current domain and records without a domain (`domain_id IS NULL`), i.e. those shared across all specialisations.
Knowledge-base search works the same way as personal retrieval in `src/pipeline/retrieve.js`: first semantic
similarity via embeddings (when available), then full-text matching as a complementary and fallback signal, then
selection of the top results within the limit. Adding a knowledge entry computes the text embedding via the same
`embed` function from `src/llm.js`; if embeddings are unavailable the record is still created and remains
discoverable through full-text search.

**Embedding lifecycle on save.** Saving a record runs in two steps. First, one `UPDATE` writes the text and
attributes; if the text changed, the database trigger (see `GLOB-3`) resets `embedding` to `NULL`, so from this
moment a text-vector mismatch is impossible by construction. Second, `updateGlobalKnowledge` immediately computes
`embed(title + '. ' + content)` and writes the vector with a separate `UPDATE` that does not touch the text, so the
trigger leaves it alone. When the embedding service is unavailable, the second step quietly ends, the record stays
with `embedding = NULL` and `hasEmbedding: false`, and the vector is filled in later — by `reembedGlobalKnowledge`
on demand or by the background repair pass.

**Fuzzy text search for management interfaces.** Besides the semantic `searchGlobalKnowledge` used by the
response pipeline, the module exposes `searchGlobalKnowledgeText` — an inexact, embeddings-free search over
titles and contents for administrative tooling. It combines exact full-text matching by `search_tsv` with the
trigram `word_similarity` from the `pg_trgm` extension (installed by migration
`003_global_knowledge_text_search.sql`), so records are also found by misspelled words and other word forms that
full-text matching misses. The relevance of each hit is the best of the two signals, normalised to 0..1, and the
results come best first. No trigram index is created: the knowledge base is small (tens to hundreds of records),
so a sequential scan is cheaper than maintaining an index.

**Background embedding repair.** The module `src/pipeline/embedding-repair.js` exposes `runEmbeddingRepairOnce()`
plus `startEmbeddingRepair()`/`stopEmbeddingRepair()`. A pass selects active knowledge records with
`embedding IS NULL` (bounded batch, oldest first) and recomputes each vector; after the first failed computation
the pass stops early — the service is most likely down and the next pass will retry. The long-running server
process starts the repair on an interval (`config.globalMemory.embeddingRepairIntervalMs`, gated by
`config.globalMemory.embeddingRepairEnabled` and `ragEnabled`); this covers both embedding-service outages at save
time and edits made bypassing the application, where nobody triggers a recompute by hand.

---

## [GLOB-5] Admin Permission Check

The admin flag is read from the `mem.users.is_admin` column and placed on the processing context `ctx`. A small
check function lives alongside personal memory management, in `src/pipeline/admin.js`:

```js
// Returns true if the user is an admin (manual flag in the database).
export async function isAdmin(userId) {
  const { rows } = await query('SELECT is_admin FROM mem.users WHERE id = $1', [userId]);
  return rows[0]?.is_admin === true;
}
```

In the `handleMessage` pipeline (see [04-architecture.md](04-architecture.md)) the flag is populated once,
immediately after `ensureUser`, because the user object already contains the `is_admin` field, and is stored in
`ctx.isAdmin`. The tool execution wrapper then uses this flag to block write tools for non-admin users.

---

## [GLOB-6] Injection into the Response Pipeline

Message assembly in `handleMessage` includes two system blocks — `GLOBAL_FACTS` and `GLOBAL_KNOWLEDGE`. Unlike
`MEMORY_CONTEXT`, these do **not** need to be wrapped in prompt-injection protection: personal memory is populated
automatically from the dialogue and may therefore contain text injected by the user, whereas global memory (both
facts and the knowledge base) is managed only by an admin manually (see `GLOB-3`, `GLOB-7`). The source is
trusted, so global memory is provided as authoritative shared information and policy that the bot follows.

Global facts are assembled for every message, regardless of what the classifier decided about personal memory
(`needs_memory = false`). The block is placed close to the stable beginning of the prompt — immediately after the
stable `MAIN_SYSTEM`. This maximises the shared cacheable prefix across users: `MAIN_SYSTEM` is identical for
everyone, and global facts are also identical and change rarely. Knowledge-base fragments, on the other hand,
depend on the query, so they are selected during the memory retrieval stage and placed alongside `MEMORY_CONTEXT`,
below the cacheable prefix. The always-on `CURRENT_DATETIME` block remains at the very end, in the dynamic zone
(see `GLOB-1`).

```text
GLOBAL_FACTS (shared information and policy for all users)

- The company operates from 09:00 to 21:00 Moscow time
- When a complaint is raised, always offer to file a support ticket

GLOBAL_KNOWLEDGE (relevant excerpts from the shared knowledge base)

- Returns are accepted within 14 days provided the original packaging is intact
- City delivery takes one business day
```

Recommended order of system messages in the `messages` array:

```js
const messages = [
  { role: 'system', content: MAIN_SYSTEM },                       // stable prefix (cached)
  ...(globalFactsBlock ? [{ role: 'system', content: globalFactsBlock }] : []),     // config.globalMemory.factsEnabled
  { role: 'system', content: memoryContext },                     // user's personal memory
  ...(globalKnowledgeBlock ? [{ role: 'system', content: globalKnowledgeBlock }] : []), // config.globalMemory.ragEnabled
  ...(historyContext ? [{ role: 'system', content: historyContext }] : []),
  ...extraSystem,                                                  // companion block, if enabled
  dateTimeSystem,                                                  // CURRENT_DATETIME — dynamic zone, always last
  ...history.map(/* ... */),
  { role: 'user', content: userMessage },
];
```

When the corresponding flag is disabled, block assembly returns an empty string and behaviour matches the baseline.
Knowledge-base search is only performed when `config.globalMemory.ragEnabled` is set, to avoid unnecessary
database and embedding requests when RAG is turned off.

---

## [GLOB-7] Agent Tools: Knowledge-Base Search for Everyone, Writes for Admins Only

Each global-memory tool lives in its own module inside `src/pipeline/agent-tools/`: the module exposes `name`, a
user-facing `title`, an OpenAI function definition, and a `handler` (see [10-operations.md](10-operations.md),
section `OPS-4`). The knowledge-base search tool is available to any user; the write tools are restricted to
admins. Permission checking is done in the shared `executeTool` wrapper so that it cannot be bypassed by adding a
new tool outside the check. Which tools are registered depends on the flags: fact tools are registered when
`config.globalMemory.factsEnabled` is set, knowledge-base tools when `config.globalMemory.ragEnabled` is set.

| Tool | Purpose | Flag | Who can call it |
|------|---------|------|-----------------|
| `global_fact_add` | add a global fact (always-on) | `config.globalMemory.factsEnabled` | admin only |
| `global_fact_delete` | delete or disable a global fact by ID | `config.globalMemory.factsEnabled` | admin only |
| `global_fact_list` | list global facts with their IDs | `config.globalMemory.factsEnabled` | admin only |
| `global_knowledge_search` | search relevant texts in the shared knowledge base | `config.globalMemory.ragEnabled` | all users |
| `global_knowledge_add` | add a text to the shared knowledge base | `config.globalMemory.ragEnabled` | admin only |
| `global_knowledge_delete` | delete a text from the knowledge base by ID | `config.globalMemory.ragEnabled` | admin only |

Admin tools are marked in their modules with the `requiresAdmin` field, and the `executeTool` wrapper rejects
calls from non-admin users, recording the refusal in the `tool_calls` log with status `blocked` (this status is
already provided for in the log schema, see [05-data-schema.md](05-data-schema.md)):

```js
export async function executeTool(ctx, name, args) {
  const started = Date.now();
  const tool = getTool(name);
  if (tool.requiresAdmin && !ctx.isAdmin) {
    await logToolCall({ conversationId: ctx.conversationId, userId: ctx.userId, toolName: name,
                        input: args, status: 'blocked', latencyMs: Date.now() - started,
                        error: 'Admin privileges required' });
    return { error: 'This action is available to admins only.' };
  }
  const output = await tool.handler(ctx, args);
  // followed by unified success/error logging
}
```

Additionally, admin tool definitions can be omitted from the model entirely when the user is not an admin: the
`toolDefs` array is then assembled with `ctx.isAdmin` and the active flags in mind, and does not include
unnecessary tools. This reduces the model's temptation to call them and saves tokens, but the check in
`executeTool` remains mandatory as the last line of defence — in case a call arrives anyway.

---

## [GLOB-8] Minimisation: Limits and Share of the Overall Budget

Global memory follows the same minimisation rule as personal memory. There should be few global facts per request
(at most five by default, controlled by `config.globalMemory.factsLimit`), because they occupy space in every
request. The number of knowledge-base fragments is also small (at most five by default, controlled by
`config.globalMemory.ragLimit`), and they are selected by relevance. These limits add up to the personal memory
limits, so the total volume of reference context must be kept within the main guideline — roughly ten to thirty
facts and five hundred to fifteen hundred words. If in practice the global blocks start crowding out personal
memory, the global layer limits should be reduced first, because personal memory typically answers the user's
specific request more accurately.

---

## [GLOB-9] Configuration and Flags

The layer is controlled by two independent flags, both enabled by default. The `config.globalMemory` branch lives
in the shared `config` object (see [08-prompts-and-models.md](08-prompts-and-models.md)), and the default values
are defined in `config/default.yaml`:

```yaml
# config/default.yaml
globalMemory:
  factsEnabled: true      # always-on global facts and their tools
  factsLimit: 5
  ragEnabled: true        # shared knowledge base (RAG) and its tools
  ragLimit: 5
  ragMinRelevance: 0.3    # threshold for cutting off weak knowledge-base matches
  embeddingRepairEnabled: true      # background recompute of missing knowledge-base embeddings
  embeddingRepairIntervalMs: 600000 # repair pass interval in milliseconds (minimum 60000)
```

| Config path | Purpose | Default |
|-------------|---------|---------|
| `globalMemory.factsEnabled` | always-on global facts and their tools | `true` |
| `globalMemory.factsLimit` | how many global facts to mix into each request | `5` |
| `globalMemory.ragEnabled` | shared knowledge base (RAG) and its tools | `true` |
| `globalMemory.ragLimit` | how many knowledge-base fragments to mix in by relevance | `5` |
| `globalMemory.ragMinRelevance` | relevance threshold: fragments below it are excluded from context | `0.3` |
| `globalMemory.embeddingRepairEnabled` | background recompute of missing knowledge-base embeddings | `true` |
| `globalMemory.embeddingRepairIntervalMs` | repair pass interval in milliseconds (minimum 60000) | `600000` |

For the interactive chat (see [03-quickstart.md](03-quickstart.md)) there is a set of commands available to admins
only. Fact commands (when `config.globalMemory.factsEnabled` is set): `/fact-add <text>` adds a fact,
`/fact-list` shows facts with their IDs, `/fact-del <id>` deletes a fact. Knowledge-base commands (when
`config.globalMemory.ragEnabled` is set): `/kb-add <text>` adds a text to the base, `/kb-find <query>` searches
the base, `/kb-del <id>` deletes a text. The commands are simply a convenient wrapper around the functions in the
`global-memory.js` module; the model can perform the same operations using the tools from section `GLOB-7` when
requested by an admin in an ordinary conversation.

---

## [GLOB-10] Layer Readiness Criteria

Layer readiness is verified by three criteria from [02-criteria.md](02-criteria.md). Each operates under its own
flag and has no effect on baseline behaviour when the flag is disabled.

| ID | Criterion | Reference module (recommendation) | Enabling flag |
|----|-----------|-----------------------------------|---------------|
| CRIT-19 | Global facts are mixed into every request and are bounded by a count limit | `mem.global_facts` + `GLOBAL_FACTS` assembly in `src/agent.js` | `config.globalMemory.factsEnabled` |
| CRIT-20 | Shared knowledge base (RAG): texts visible to all, mixed in by relevance, searchable and deletable by ID | `mem.global_knowledge` + `src/pipeline/global-memory.js` | `config.globalMemory.ragEnabled` |
| CRIT-21 | Only an admin can populate and clean global memory (manual `is_admin` flag) | check in `executeTool` + `isAdmin` in `src/pipeline/admin.js` | both flags |

---

## [GLOB-11] The `layerGlobalMemory` Test Layer

The layer's tests are extracted into a dedicated test layer `layerGlobalMemory` in `tests/run.js` (see
[10-operations.md](10-operations.md)), enabled by the flags `config.globalMemory.factsEnabled` and
`config.globalMemory.ragEnabled`, and have no effect on the baseline run. As everywhere in the test suite, the
checks run against a real database and real models, verify structure before behaviour, and exit with a non-zero
code on failure. Fact tests and knowledge-base tests are enabled independently, each by its own flag.

1. **Structure.** The tables `global_facts` and `global_knowledge` have been created; the `mem.users.is_admin`
   column exists; the active-facts index, the full-text GIN index, and the vector HNSW index for the knowledge
   base are all present; a minimal create-and-read cycle completes successfully.
2. **Global facts always in context** (when `config.globalMemory.factsEnabled` is set). An enabled fact appears in
   the `GLOBAL_FACTS` block even for a message for which personal memory is not needed (`needs_memory = false`);
   a disabled fact does not appear; the fact count limit is respected; domain and domain-agnostic records are both
   taken into account.
3. **Knowledge base and relevance-based search** (when `config.globalMemory.ragEnabled` is set). A text added by
   an admin is found by a closely related query and is not returned for an unrelated query; deleting by ID removes
   the text from results; domain and domain-agnostic records are both taken into account; the fragment count limit
   is respected.
4. **Admin permissions.** A non-admin receives a rejection when attempting to add or delete a record (both facts
   and knowledge-base texts), and the rejection is recorded in `tool_calls` with status `blocked`; an admin
   performs the same actions successfully.
5. **Privacy.** User secrets do not end up in global memory: sensitive data remains in personal protected memory
   (see [07-secure-privacy.md](07-secure-privacy.md)) and is not transferred to the shared layer.
6. **Text-to-vector integrity trigger.** The trigger is installed; an `UPDATE` of one vector without the text keeps
   the vector; an `UPDATE` of the text without a vector resets the vector to `NULL` and bumps `updated_at`; an
   `UPDATE` writing the text and a fresh vector in one statement causes no false reset.
7. **Knowledge-base CRUD and embedding lifecycle** (when `config.globalMemory.ragEnabled` is set).
   `listGlobalKnowledge` returns records with the `hasEmbedding` flag; `updateGlobalKnowledge` applies field
   changes and recomputes the embedding after a text change; an edit made bypassing the application is visible as
   `hasEmbedding: false`; `reembedGlobalKnowledge` restores the vector; a `runEmbeddingRepairOnce` pass fills in
   missing vectors; soft deletion removes the record from the default selection but keeps it reachable by the
   `deleted` status, and restoring is the same update with status `active`.
8. **Fuzzy text search** (when `config.globalMemory.ragEnabled` is set). `searchGlobalKnowledgeText` finds a
   record by its exact words and by a misspelled word, does not return it for an unrelated query, and orders the
   results by descending relevance.

---

## [GLOB-12] Implementation Order

1. **Schema.** Add the `global_facts` and `global_knowledge` tables, the `is_admin` column, the indexes, and an
   idempotent seed of baseline facts to the single initialisation script `001_init.sql`, run the migration, and
   verify the structure.
2. **Access module.** Implement `src/pipeline/global-memory.js` (facts and knowledge base: retrieval, search,
   add, delete) and the `isAdmin` function in `src/pipeline/admin.js`.
3. **Tools and permission check.** Add one module per tool in `src/pipeline/agent-tools/` and the admin check in
   the `executeTool` wrapper.
4. **Injection into the response.** Populate `ctx.isAdmin` and assemble the `GLOBAL_FACTS` block (when
   `config.globalMemory.factsEnabled` is set, immediately after `MAIN_SYSTEM`) and the `GLOBAL_KNOWLEDGE` block
   (when `config.globalMemory.ragEnabled` is set, alongside `MEMORY_CONTEXT`) in `src/agent.js`.
5. **Configuration and commands.** Add the `globalMemory` section to `src/config.js` and the admin commands to
   the chat interface.
6. **Tests.** Implement the `layerGlobalMemory` layer in `tests/run.js` and record the number of passing checks.

---


