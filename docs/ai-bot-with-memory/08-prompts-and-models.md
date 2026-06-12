# 08. Prompts, Provider, and Model Selection

## [PROMPT-1] Client and Strict JSON

Structured stages go through the `chatJSON` function with two `response_format` modes. The default is the
provider-enforced `json_schema` (structured outputs): the schema is normalized by `prepareJsonSchema` —
`additionalProperties: false` and a complete `required` list are filled in recursively on every object node —
and sent with `strict: true`, so conformance is guaranteed at the decoder level. Free-form objects
(`additionalProperties: true` or an object type without declared properties) cannot be expressed in strict
mode: for such schemas `strict` is turned off — the schema still guides the model, but the API does not
enforce it. The legacy `json_object` mode (the schema described as text in the system prompt inside a
`<json-schema>` tag) is kept for providers and models without `json_schema` support; it is selected per call
via the `responseFormat` argument or globally via `config.llm.responseFormat`.

```js
export async function chatJSON({ model = config.llm.auxModel, system, user, schema,
                                 schemaName = 'result', kind, responseFormat }) {
  const mode = [responseFormat, config.llm.responseFormat].find((v) => RESPONSE_FORMATS.includes(v)) || 'json_schema';
  let sys = system || '';
  let format;
  if (mode === 'json_schema') {
    const { schema: prepared, strict } = prepareJsonSchema(schema);
    format = { type: 'json_schema', json_schema: { name: schemaName, strict, schema: prepared } };
  } else {
    sys = `${sys}

Ответь СТРОГО одним JSON-объектом, который соответствует JSON Schema (${schemaName}), приведённой в теге <json-schema>:
<json-schema>
${JSON.stringify(schema)}
</json-schema>
Без markdown, без пояснений, без текста до или после JSON. Только сам объект.`;
    format = { type: 'json_object' };
  }
  const res = await client.chat.completions.create({
    model,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    response_format: format,
  });
  const content = res.choices[0].message.content;
  try { return JSON.parse(content); }
  catch {
    const m = content.match(/\{[\s\S]*\}/);     // запасной разбор, если модель обернула JSON в текст
    if (m) return JSON.parse(m[0]);
    throw new Error('Модель вернула не-JSON: ' + content.slice(0, 200));
  }
}
```

Embeddings are produced by the `embed` function; on error it returns `null`, and the entire system falls back to
full-text and structural search without vectors. This makes the vector layer optional and resilient to model
unavailability.

---

## [PROMPT-1a] Streaming Main Response

The model's main response is delivered as a stream by the `chatStream` function: the selected provider returns the
response in chunks, where text lives in `delta.content` and tool calls live in `delta.tool_calls`. Parts of a single
tool call arrive indexed (the identifier may come first, then the function name, then fragments of the argument
string). As text arrives, the client calls `onDelta(chunkText)`, and from the deltas it assembles the same final
message object that the non-streaming `chat` returns: the `tool_calls` field is present only when tools were actually
invoked, and its arguments are valid JSON assembled from all fragments. Arguments are parsed and validated only after
the full message has been assembled, not on the fly.

```js
export async function chatStream({ model = config.llm.mainModel, messages, tools, toolChoice, onDelta }) {
  const stream = await client.chat.completions.create({ model, messages, tools, stream: true });
  const acc = createDeltaAccumulator();
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta || {};
    if (delta.content && onDelta) await onDelta(delta.content);
    accumulateChatDelta(acc, delta);   // копит content и собирает tool_calls по индексу
  }
  return finalizeChatMessage(acc);     // tool_calls только если они были
}
```

The three pure assembly functions (`createDeltaAccumulator`, `accumulateChatDelta`, `finalizeChatMessage`) are
extracted into their own module and covered by unit tests that make no network calls, because their correctness is
exactly what guarantees that a streaming response is structurally identical to a non-streaming one. The structured
stages (`chatJSON`) and embeddings are deliberately never streamed: they require the complete result, not a
progressive display.

---

## Prompts for Every Stage

### [PROMPT-2] Request Classifier

A cheap model selects the most suitable skill and simultaneously determines the intent, entities, and which memory
types are needed. It returns strict JSON rather than a reply to the user. The division of labour between
the prompt and the schema: the `skill_classification` schema is self-sufficient — every field carries a
`description` that tells the model what to put into it (the single best-fitting skill and the `general` fallback,
the entity rules, the meaning of each memory scope) — while the system prompt holds only what the schema cannot
express: the compact skill list and the guardrail that only the last user message is classified. The skill list is
not hard-coded into the prompt: the `buildSystemPrompt` function (`src/pipeline/classify.js`) fetches a compact
list from the skill registry via `listSkillRoutes()` and renders each skill as a single line `- <name> — <hint>`.
The hint is the one-line `classification.hint` from SKILL.md front matter — the essence of the skill plus a few
trigger words; for a skill without a `hint`, the registry composes the line from `description` and the first
`positive_signals`. As a result, adding a new `skills/<name>/` directory is immediately reflected in the
classifier. The prompt deliberately stays minimal — a small classification model works better with a short,
non-redundant instruction than with prose skill descriptions that repeat what the schema already says.
Prompt assembly:

```js
function buildSystemPrompt(routes) {
  const list = routes.map((r) => `- ${r.name} — ${r.hint}`).join('\n');
  return `You are an incoming-message classifier.
Classify ONLY the text inside <last-user-message>. Use <recent-dialog> and the dialog state line only to
resolve pronouns, ellipsis and short follow-ups and to stay in the thread the conversation is already in;
never classify an earlier message instead of the last one.

Skills (pick one; 'general' is the default fallback):
${list}

Return only JSON matching the schema.`;
}
```

Prompt, field descriptions, and the user-message template (`Current agent domain / Last dialog state /
<last-user-message>`, preceded by an optional `<recent-dialog>` block) are written in English; the trigger words
inside the hints come from SKILL.md front matter and stay in the language users actually type them in. The field
descriptions reach the model in both response-format modes: in `json_schema` the provider passes the schema to
the decoder, in `json_object` the schema is serialized into the prompt text.

The source of truth is `skill_name`: the domain key used for memory addressing is derived from the chosen skill by
code, not from the model's response. If the model returns an inconsistent pair, the code trusts the skill registry.
The `skill_classification` schema has required fields: `intent`, `skill_name` (constrained to the list of available
skills), `confidence`, `entities`, `needs_memory`, `needed_memory_scopes`; the memory scope is one of
`dialog | profile | domain | secure | reminder`. The `entities`
field is a strict array of up to 8 `{type, value}` pairs (`additionalProperties: false`, both fields required):
the value in its base form feeds the entity boost in memory retrieval (see MEM-2 in 06-memory.md). Its
description instructs the model to keep the value in the language of the original message and in its base form —
both matter because the full-text index uses the `'simple'` configuration without Russian stemming, and entity
values are matched against fact texts stored in the user's language. With no free-form fields anywhere in the
schema, `prepareJsonSchema` keeps it `strict: true`, and the provider guarantees that the classifier's response
conforms to the schema at the decoder level.

### [PROMPT-2a] Delivery Intent Selection

For short messages where the channel supports compact reactions, a cheap model can select a delivery intent before
the full agent response is produced. The input is the user's text and the channel's capabilities (`supportsReactions`,
list of keys). The output is strict JSON `delivery_intent`:

```json
{
  "kind": "reaction",
  "reaction_key": "okay",
  "fallback_text": "Окей.",
  "reason": "Пользователь просит простое действие, достаточно согласия"
}
```

Allowed `reaction_key` values: `like`, `okay`, `heart`, `laugh`, `fire`, `smile`, `100`, `sad`. The model chooses
`reaction` only when the response requires no facts, no tools, no clarifications, and no substantive text. In all
other cases it returns `kind = "text_needed"`, and the message proceeds through the normal `handleMessage` flow.

### [PROMPT-3] Fact Extraction

Runs after the response — a single model call per turn (request kind `fact_extract`). The source of facts is
**only what the user says**: the user's recent messages are passed verbatim in `<user>` tags, the assistant
reply the user was responding to is passed as a short plain-text summary in an `<assistant>` tag, and the
classifier's detected intent of the current message is added as a reference line. The prompt forbids
extracting anything from `<assistant>` — that text is already stored memory, and re-extracting it would
multiply duplicates. The prompt also includes the `## Fact Extraction Prompt` block of the active skill
(which explains what facts are useful in that specific domain) with an explicit note that the
user-replicas-only rule still applies.

The `user_facts` response schema is an array of flat objects with fields `type` (one of the ten fact types
from [06-memory.md](06-memory.md)), `fact_text` (one short third-person sentence without HTML),
`confidence` (0..1), and `ttl_days` (an integer or `null`). The item shape is the exported `FACT_ITEM_SCHEMA`
(`src/pipeline/facts.js`) — the single source of truth for the strict fact form, reused by every schema where
a model returns fact candidates (here and in the history summariser's `facts_to_memory`, see [PROMPT-6]).
The storage domain is assigned by the pipeline, not by the model.

The model judges the fact's lifetime by its nature through `ttl_days`, the way a person would: namings and
stable communication agreements are open-ended (`ttl_days = null`); fleeting moods and one-off appraisals are
not saved at all (only a recurring pattern is); working agreements about a current task are `open_loop` or
`goal` facts with `ttl_days` of 30–60 so they fade out unless revisited. An explicit `ttl_days` takes
priority over the per-type retention table when computing `expires_at` (see [06-memory.md](06-memory.md),
MEM-5).

The extraction prompt preserves stable, useful facts rather than one-off states. It prohibits psychological
diagnoses and labels, absolute phrasing such as "always" and "never", and requires lowering `confidence` when
the inference is weak. It explicitly excludes: anything said by the assistant, fleeting emotions and one-off
details, commands to the bot ("show my notes", "remind me tomorrow" — actions, not facts about the person),
and sensitive data (passport, payment, exact address, medical) — such data is skipped entirely. `open_loop`
stores plans, events, problems, or wellbeing items that have no follow-up update, while `discovery_seed` is
extracted from phrases like "I'd like to try", "it would be interesting", "I've been thinking about". If
there is nothing to save, the model returns an empty list. The full prompt text is in
`src/pipeline/facts.js`.

User reactions to an assistant message are fed into extraction with the target message's plain text in the
`<assistant>` tag and the reaction description as the user turn. The prompt saves a fact only when the
meaning of the reaction is unambiguous in the context of the target assistant message. For example, the
question "Do you like cakes?" followed by a `:heart:` reaction yields the preference "The user likes cakes."
Reactions that could mean politeness, mood, or one-time approval without future utility do not create facts.

### [PROMPT-3a] Assistant Reply Summary

Right after each response an auxiliary model call (request kind `answer_summary`) compresses the assistant's
reply into one or two plain-text sentences: what the reply was about and what question the assistant asked
the user, if any. No HTML or markdown, no lists; enumerations are described generically ("showed the saved
notes list") and user facts are not repeated. The summary is stored in the assistant message's
`metadata.summary` and substitutes the full reply text in the fact-extraction context on the next turn.
Replies short enough to be their own summary skip the model call; on any model error the HTML-stripped,
truncated reply text is used instead, so the pipeline does not depend on the auxiliary model's availability.

### [PROMPT-4] Scheduler Task Creation

The scheduler has no dedicated extractor prompt: tasks and reminders are created by the main dialogue model itself
by calling the `scheduler_create_task` tool (`src/pipeline/agent-tools/scheduler/scheduler_create_task.js`).
Behaviour is governed by the tool's parameter descriptions. The schedule kind is selected via the `schedule_kind`
field: `one_time` with an absolute `run_at` for a one-off task, `interval` with `interval_seconds` for a simple
"every N seconds" cadence, `cron` with a `cron_expr` for calendar local time (e.g. weekdays at 09:00 —
`0 9 * * 1-5`), and `rrule` for complex iCalendar rules.

The `instruction` field contains the ready-to-deliver reminder text, which is delivered to the user verbatim
without reformulation (see [10-operations.md](10-operations.md), section OPS-3). Accordingly, the parameter
description requires writing it as live first-person speech addressed directly to the user — "Reminder: you wanted
to call your mom" — rather than a third-person service instruction such as "Remind the user to call their mom."

### [PROMPT-4a] User Response Preferences

The format of the response and the voice tone are changed by the main dialogue model itself via tools. The stable
system prompt includes an explicit rule: requests to enable or disable voice output (switching between text and
voice format) invoke `voice_or_text`, while requests for a specific voice, tone, or male/female/neutral voice
invoke `voice_set_preference`. These tools are not memory extractors: they synchronously update the user's control
fields so that the preference takes effect for the current response.

`voice_or_text` accepts `mode = "voice" | "text"`. `voice_set_preference` accepts a string `selection`: this can
be a specific voice identifier (`nova`, `onyx`, `ash`) or a category (`male`, `female`, `neutral` and their
Russian equivalents). The handler validates the selection against the voice catalogue; unknown values return an
error and the list of allowed options, and are not written to the user's state.

### [PROMPT-4b] Image Generation

When the user asks to draw, generate, or create a picture, illustration, or photo, the main dialogue model calls
the `generate_image` tool (`src/pipeline/agent-tools/image/generate_image.js`). The tool sends a `POST` request
with a JSON body to the external image-generation API at `config.imageGen.apiUrl` and receives a public https URL
of a ready image in return. It is channel-agnostic: it does not render anything itself, it only returns a picture
descriptor in `structuredContent.image` (the URL, the prompt, the model, and the seed). A delivery channel that
supports pictures **may** present it as an attached image; channels without image support simply show the model's
text answer and ignore the descriptor.

The tool parameters are `prompt` (a detailed image description; the parameter description asks the model to write
it in English and enrich it with style, lighting, and quality, since the generation model works best with English),
`negative_prompt` (what to exclude), and `width`/`height`. The requested size is clamped to
`config.imageGen.allowedSizes`; an omitted or unsupported value falls back to the configured default
`config.imageGen.width`/`height`. The request is bounded by `config.imageGen.timeoutMs`: on overrun, on a non-200
response, or on a missing URL the tool returns a clear error instead of hanging the turn, and the model reports the
failure to the user in text. The whole capability is gated by `config.imageGen.enabled`.

### [PROMPT-5] Dialog Topic Extraction (Companion Mode)

In parallel with fact extraction, when `config.companion.enabled` is set, a separate call returns the dialog's
topics along with an engagement score. The `dialog_topics` schema is an array of objects with `topic_key` (a short
snake_case Latin key) and `user_engagement` (0..1). The prompt requires avoiding overly generic topics (`life`,
`things`, `stuff`), not splitting every sentence into a separate topic, merging closely related topics, and using
the engagement scale: 0.1–0.3 for one-word answers with no interest, 0.4–0.6 for neutral engagement, 0.7–0.9 for
active topic development and questions, 1.0 for explicit enthusiasm. More detail in
[09-proactivity.md](09-proactivity.md).

### [PROMPT-5a] Companion Prompt for the Main Response

When `config.companion.enabled` is set, the main response receives an additional stable system block
`COMPANION_SYSTEM`. It does not replace `MAIN_SYSTEM`: rules for tools, safety, memory, and prioritising the
current request remain in the first system message. `COMPANION_SYSTEM` defines the role and style of a live
conversational partner:

```text
# Роль

Ты — персональный ассистент и приятель пользователя.

Твоя задача — поддерживать живое, интересное и ненавязчивое общение,
постепенно узнавая интересы, предпочтения и жизненный контекст пользователя.

Ты не «придумываешь темы», а находишь **уместные поводы для разговора**,
как это делает хороший коммуникатор.

Ты не проводишь опросы и не задаёшь формальных вопросов.
Ты общаешься естественно, как близкий знакомый.
```

The block's key logic is the "observation → space → choice" formula: first an apt observation about the moment,
the user's state, or the context; then a gentle invitation to talk; then a sense of freedom without pressure.
The block also specifies the topic-selection order: "here and now", unresolved threads from the past,
micro-observations, a careful emotional entry, and a light choice. Dynamic data is not embedded in
`COMPANION_SYSTEM`; it is passed in a separate `CONVERSATION_CONTEXT`.

`CONVERSATION_CONTEXT` remains a reference block, not a directive. It contains temporal context, topic management,
rules for not returning to recent topics without cause, avoiding burned-out topics, developing topics with high
engagement, and periodically proposing new directions from `discovery_seed` facts.

### [PROMPT-5b] Proactive First Message

The generator for the message the bot sends first uses the same companion framework, but with a strict first-contact
format: 1–2 sentences, at most one question, no self-introduction, no apologies, no pressure. The prompt receives
the trigger type, contact mode, temporal context, topics, and the user's regular facts as reference data. The
decision to send a message is made by the algorithmic contact policy before the model is called, so the prompt does
not decide whether to write to the user — it only formulates an appropriate text. In `cautious` mode it does not
start a new topic and briefly acknowledges an important trigger.

### [PROMPT-6] Dialog History Summariser (History Compression)

When `config.historyCompression.enabled` is set, a separate call compresses the cold portion of the dialog
history. The prompt requires retaining only what is needed to continue the conversation, leaving the most recent
messages untouched (they are not passed in and will be appended separately), not duplicating facts already in
`active_memory`, describing the near context in more detail than the distant context, moving stable facts about
the user (from the user's own messages, in the flat `{type, fact_text, confidence, ttl_days}` form — `ttl_days`
is an integer number of days or `null` for an indefinite fact, 30 by default for `open_loop`) to
`facts_to_memory`, not storing secrets in plain text, not inventing facts, and using `state_json.notes` rarely —
only for important things that do not fit the seven state fields. Facts from `facts_to_memory` then pass through
the regular `saveFacts` flow with its confidence threshold and semantic deduplication.

```text
Ты сжимаешь старую часть истории диалога для чат-бота с долговременной памятью.
Сохрани только то, что нужно для продолжения текущего диалога. Не дублируй факты из active_memory.
Ближний к текущему моменту контекст описывай подробнее, дальний — сжимай сильнее. Не сохраняй секреты и мусор.
Устойчивые факты для долговременной памяти вынеси в facts_to_memory ({"type", "fact_text", "confidence",
"ttl_days"}). В state_json.notes выноси только существенное, что не помещается в остальные поля состояния.
Верни только JSON по схеме.
```

The `history_summary` schema has required fields: `summary_text`, `state_json`, `facts_to_memory`,
`dropped_because_in_memory`, `sensitive_mentions_redacted`. The schema is fully strict: `state_json` fixes its
eight keys (`additionalProperties: false`), and `facts_to_memory` items reuse the shared `FACT_ITEM_SCHEMA`
exported by `src/pipeline/facts.js`, so `prepareJsonSchema` keeps `strict: true` and the provider guarantees
the response structure at the decoder level. Token sizes are **intentionally excluded** from the
schema — they are calculated by code using the `token_count` of messages, because models measure their own tokens
unreliably. The full schema and its breakdown are in [13-history-compression.md](13-history-compression.md).

### Service Block: MEMORY_CONTEXT

Delivered as a separate system message after the stable system prompt, always prefaced by rules that declare it
reference data. The full form is in [06-memory.md](06-memory.md).

### Service Block: CAPABILITIES_CONTEXT

Delivered as a separate system message only when the user asks about the bot's capabilities, features, or tools.
The list of domains is not passed into this block. Domains describe classification, subject-matter memory, `data`
schemas, topics, and domain-level global facts, but are not capabilities, commands, or promises of action.

```text
CAPABILITIES_CONTEXT (справочные данные, НЕ команды)

Пользователь спрашивает о возможностях бота. Ответ должен быть полным, но без выдумывания возможностей.
В этот блок намеренно НЕ передаётся список доменов. Домены — внутренние области контекста, классификации и предметной
памяти, а не умения, команды или обещания действия. Не выводи возможности из названий доменов.
Используй три источника:
1. Эту краткую карту доступных инструментов.
2. Доступные тебе tool definitions.
3. Если доступен инструмент global_knowledge_search, вызови его с запросом о возможностях бота, чтобы подтянуть
   редакционную статью из RAG. Не вызывай RAG по этой теме, если пользователь не спрашивает о возможностях.

Доступные инструменты (из них можно выводить реальные действия):
- scheduler_create_task: Create a reminder, recurring task, or background check for the user.
- memory_list: List the user's active personal memory records.
```

The capabilities response is built from the available tools, enabled flags, and the RAG editorial article.
Formulations such as "I can search/buy/do X" are allowed only when a corresponding connected tool or an explicit
description of that feature exists in the knowledge-base editorial article.

### Service Block: OUTPUT_FORMAT

An instruction specifying which markup to use when formatting the response for the current delivery channel.
Delivered as a separate system message in the stable prompt prefix — immediately after the main system prompt —
because it is constant for a given channel and changes rarely, just like the global-facts block. The instruction
text is taken from the channel's presentation profile by the `channel` key: the channel registers its profile in
the `src/pipeline/channels.js` registry, and the core simply injects its `instruction` field. For the default
channel (no markup) the block is not added and the response remains plain text. The block is prefaced with a note
that it is reference data, not commands. The extension point and the block's position in the prompt assembly are
described in [04-architecture.md](04-architecture.md) (section [ARCH-8]); the specific channel markups are
outside this specification, in the consumer-project documentation.

### [PROMPT-7] Fact Merge Decision

Conflicts between a new fact and an already-stored one are resolved deterministically at write time, with no
model call (see [06-memory.md](06-memory.md)): `saveFact` finds the nearest active fact of the same user and
`fact_type` by embedding cosine similarity and applies two configured thresholds. At or above
`facts.confirmSimilarity` the existing row is confirmed in place — `evidence_count` is incremented and freshness
is refreshed; between `facts.replaceSimilarity` and the confirm threshold the old row is archived and the new
statement replaces it; below the replace threshold a new fact row is inserted.

### [PROMPT-10] Skill-Part Generators (Skill Editing)

The skill-editing toolset relies on dedicated generators with strict JSON output in
`src/pipeline/skills/author.js`. `generateSkillDraft` assembles a full skill draft from a description (name,
domain key, classifier hint, classification signals, prompt blocks); `refineBlock` rewrites the `# Skill Prompt` or
`## Fact Extraction Prompt` block according to an instruction. Generated drafts pass the skill validator before
being written, and any findings are returned for preview. The model receives grounding for choosing the right
tool from the `# Skill Prompt` block of the `skill-author` editor skill (see
[11-per-domain-schema.md](11-per-domain-schema.md)). These generators and tools are available to administrators
only and only when the corresponding flag is enabled.

---

## [PROMPT-8] Configuration

Configuration is assembled by the `node-config` package from the `config/` directory and is accessible in code as
the `config` object exported by `src/config.js`. The settings tree is composed of `config/default.yaml` (default
values), an environment file (`development.yaml` or `production.yaml`, selected by `NODE_ENV`), and
`config/local.yaml` (local secrets); the map `config/custom-environment-variables.yaml` allows any value to be
overridden by an environment variable of the same name. Models are configured under the `config.llm.*` branch;
companion, proactivity, global memory, and history compression flags are enabled by default, while the external
events loop is disabled. The full list of settings is in [03-quickstart.md](03-quickstart.md).

```js
export const config = {
  llm: {
    apiKey: '...',
    // пустое значение означает прямой OpenAI API; заданное значение ведёт в OpenAI-совместимый прокси.
    baseURL: '...',
    mainModel: '<MAIN_MODEL>',
    auxModel: '<AUX_MODEL>',
    extractModel: '<MAIN_MODEL>',
    embedModel: '<EMBED_MODEL>',
    embedDim: 1536,
  },
  authSecret: 'dev-insecure-secret-change-me',
  timezone: 'Europe/Moscow',
  debug: ['...'],
  companion: { enabled: true },
  streaming: {
    enabled: true, // потоковый вызов модели (chatStream) и события onEvent
  },
  globalMemory: {
    factsEnabled: true, // глобальные факты (always-on)
    factsLimit: 5,
    ragEnabled: true,   // общая база знаний (RAG)
    ragLimit: 5,
    ragMinRelevance: 0.3,
  },
  proactive: {
    enabled: true,
    intervalMs: 300000,
    inactivityMinutes: 1440,
    checkinHour: 10,
    goalIntervalMinutes: 2880,
    welcomeBackGapMinutes: 60,
    events: { enabled: false, relevanceThreshold: 0.6 },
  },
  historyCompression: {
    enabled: true,
    hotWindow: 8,
    maxTokens: 2000,
    shrinkTokens: 800,
    zoneWeights: [0.55, 0.30, 0.15],
    model: '<AUX_MODEL>',
    minCompressGain: 0.35,
  },
  // Параметры подключения к PostgreSQL живут в ветви config.db.postgres.dbs.<id>
  // и читаются пакетом af-db-ts (рабочая база — алиас main).
};
```

At startup the hysteresis invariant is checked: the value of `config.historyCompression.shrinkTokens` must be
strictly less than `config.historyCompression.maxTokens`.

---

## [PROMPT-9] Model Selection by Stage

The principle is: the main response is produced by a mid-tier model, all auxiliary JSON tasks use the cheapest
fast model, and memory writes happen asynchronously so they do not delay the response.

| Stage | What is used | Path in `config` |
|-------|--------------|------------------|
| Main agent response | `<MAIN_MODEL>` | `llm.mainModel` |
| Request classification | `<AUX_MODEL>` | `llm.auxModel` |
| Delivery intent selection | `<AUX_MODEL>` | `llm.auxModel` |
| Fact extraction to memory | `<MAIN_MODEL>` | `llm.extractModel` |
| Dialog topic extraction | `<AUX_MODEL>` | `llm.auxModel` |
| Dialog history summariser | `<AUX_MODEL>` | `historyCompression.model` |
| Fact merging | deterministic rules, no model call | — |
| Embeddings | `<EMBED_MODEL>` (1536) | `llm.embedModel` |

Before going to production, verify the availability and capabilities of the selected models (chat, strict JSON,
tool calling, and embeddings) through the chosen endpoint using the check script `tests/check-llm.js`
(`npm run check:llm`).

### Recommended Models (Selection Examples)

Reference points for two providers; any model of a comparable class that passes `npm run check:llm` is suitable.

| Model class | OpenAI-compatible proxy | Groq equivalent |
|-------------|-------------------------|-----------------|
| `<MAIN_MODEL>` — main response | `gpt-5.4-mini` | `llama-3.3-70b-versatile` |
| `<AUX_MODEL>` — cheap auxiliary | `gpt-5.4-nano` | `openai/gpt-oss-20b` or `llama-3.1-8b-instant` |
| `<EMBED_MODEL>` — embeddings (1536) | `text-embedding-3-small` | Groq has no embeddings: use another provider or disable the vector layer |

---


