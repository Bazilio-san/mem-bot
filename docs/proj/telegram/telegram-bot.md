# Telegram Bot Adapter

The Telegram adapter presents the core agent through Telegram Bot API polling, commands, callback queries, reactions,
voice input, voice output, image delivery, streaming drafts, and Mini App buttons.

Project documentation rules are in [../documentation-principles.md](../documentation-principles.md).

## Boundary

Business rules live in the core docs and source modules. This document describes Telegram-specific delivery and user
interaction. The adapter owner is `../../../src/telegram/bot.js`.

Related core docs:

- Agent loop: [../core/04-architecture.md](../core/04-architecture.md)
- Memory: [../core/06-memory.md](../core/06-memory.md)
- Proactivity: [../core/09-proactivity.md](../core/09-proactivity.md)
- Notes: [../core/15-notes.md](../core/15-notes.md)

## Startup and Transport

The Telegram process loads configuration, validates required settings, starts polling, processes updates through a
bounded queue, and drains the notification outbox. Exact concurrency, retry, listener, and shutdown behavior belongs to
`../../../src/telegram/bot.js` and `../../../config/default.yaml`.

## Message Handling

Inbound text, voice, callback queries, and reactions are translated into core calls. The adapter stores external message
references so replies, reactions, and generated media can be associated with conversation messages.

Code owners:

- Main adapter: `../../../src/telegram/bot.js`
- Telegram HTML formatting and splitting: `../../../src/telegram/format.js`
- Streaming draft state: `../../../src/telegram/progress.js`
- Reaction mapping: `../../../src/telegram/reactions.js`
- Conversation and external-reference persistence: `../../../src/repo.js`

## Commands and Controls

Bot commands, inline keyboards, callback payloads, and command handlers are defined in `../../../src/telegram/bot.js`.
Do not copy the command list into documentation; the source file is the authoritative menu.

Conceptually, Telegram exposes controls for:

- Starting the bot and refreshing the command menu.
- Inspecting memory and deleting remembered facts.
- Enabling or disabling proactivity and individual triggers.
- Selecting text or voice reply mode and voice timbre.
- Opening the notes Mini App when configured.
- Showing bot build metadata.

## Streaming and Tool Statuses

The core emits streaming and tool-status events. Telegram renders them as an editable draft message and progress text,
using throttling and length gates from configuration.

Implementation owners:

- Core streaming: `../../../src/llm.js`, `../../../src/agent.js`
- Telegram progress renderer: `../../../src/telegram/progress.js`
- Adapter delivery: `../../../src/telegram/bot.js`

## Voice, Images, and Reactions

Voice input is transcribed before the core turn; voice output is synthesized after the core result when the user prefers
spoken replies. Image generation is a model-callable tool that returns generated image metadata, then Telegram sends the
result as photos. Compact reactions are selected by the core and mapped to Telegram reaction payloads when possible.

Code owners:

- Speech recognition: `../../../src/voice/transcribe.js`
- Text-to-speech: `../../../src/voice/tts.js`
- Voice catalog: `../../../src/voice/voices.js`
- Image generation tool: `../../../src/pipeline/agent-tools/image/generate_image.js`
- Delivery intent and reaction helpers: `../../../src/pipeline/reactions.js`,
  `../../../src/telegram/reactions.js`

## Mini Apps and Admin Sign-In

Telegram participates in two web flows:

- The notes Mini App opens the notes widget with a signed widget token.
- Admin sign-in validates Telegram Login Widget data in the web server.

Implementation owners:

- Notes widget token: `../../../src/notes/widget-token.js`
- Telegram init-data validation: `../../../src/notes/telegram-init-data.js`
- Notes API and widget: `../../../src/server/notes-api.js`, `../../../web/src/components/notes/`
- Admin auth: `../../../src/server/admin-auth.js`

## Verification

Focused adapter tests live in `../../../tests/telegram-format.test.mjs`, `../../../tests/progress.test.mjs`,
`../../../tests/progress-format.test.mjs`, `../../../tests/reactions.test.mjs`, `../../../tests/streaming.test.mjs`,
and voice-related tests. Live Telegram Web verification uses the repository's Telegram testing skill instructions.
