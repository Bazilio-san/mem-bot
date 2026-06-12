# 04. Response Loop Architecture

The response loop is centered on `handleMessage` in `../../../src/agent.js`. It coordinates persistence, context
assembly, model calls, tools, streaming callbacks, memory extraction, and post-response bookkeeping.

## Pipeline Shape

Conceptually, a message turn goes through these stages:

1. Resolve the user, domain, conversation, admin status, and channel presentation profile.
2. Persist the inbound message and record channel metadata when an adapter provides it.
3. Retrieve context: recent messages, compressed history, personal memory, secure summaries, global facts, and RAG.
4. Build capability context and select the active skill.
5. Run the main model turn, including tool calls and optional streaming events.
6. Persist the assistant response and references needed by adapters.
7. Extract and save memory from the turn without blocking final delivery.
8. Update companion/proactivity state and event logs.

Exact control flow belongs in `../../../src/agent.js`.

## Responsibilities by Module

- Model wrapper, streaming accumulation, and strict JSON helpers: `../../../src/llm.js`
- Memory retrieval and prompt block formatting: `../../../src/pipeline/retrieve.js`
- Fact extraction, saving, deduplication, and sweeps: `../../../src/pipeline/facts.js`
- History context and compression: `../../../src/pipeline/history-context.js`,
  `../../../src/pipeline/history-compress.js`
- Delivery intent and compact reactions: `../../../src/pipeline/reactions.js`
- Channel profiles: `../../../src/pipeline/channels.js`
- Tool registry: `../../../src/pipeline/tools.js`, `../../../src/pipeline/agent-tools/index.js`
- Agent event journal: `../../../src/pipeline/agent-event-log.js`

## Streaming Contract

The core emits semantic events; adapters decide how to display them. Telegram turns those events into editable draft
messages and tool-status updates. The web admin chat consumes a server-sent event stream.

Implementation owners:

- Core streaming model call: `../../../src/llm.js`
- Agent event emission: `../../../src/agent.js`
- Telegram draft renderer: `../../../src/telegram/progress.js`
- Admin chat events: `../../../src/server/chat-events.js`, `../../../web/src/api.js`

## Channel Boundary

The core can request text, voice, image, reaction, widget, or tool-result delivery semantics, but it does not know how a
specific messenger renders them. Adapter-specific behavior belongs in
[../telegram/telegram-bot.md](../telegram/telegram-bot.md) or
[../admin/admin-interface.md](../admin/admin-interface.md).
