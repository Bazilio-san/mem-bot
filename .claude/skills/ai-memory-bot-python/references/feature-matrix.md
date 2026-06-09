# Feature Matrix

## Presets

| Preset | Features |
|---|---|
| `minimal` | `core` |
| `chat` | `core,memory,tools,streaming` |
| `companion` | `chat,companion,history-compression` |
| `voice` | `chat,voice-input,voice-output` |
| `full` | all features except channel-specific secrets |

## Capability Rules

- Include `memory` for any bot that should remember facts, preferences, domain progress, or prior context.
- Include `secure-memory` when user data may contain passports, addresses, payment data, medical data, tokens, or other
  secrets. It requires `AUTH_SECRET`.
- Include `scheduler` when the bot can create reminders, recurring tasks, delayed notifications, or outbox messages.
- Include `proactive` only with `scheduler`. It checks user-level opt-in, trigger-level opt-in, quiet hours, unanswered
  soft-message counts, and daily/weekly limits.
- Include `companion` when the bot should behave like an ongoing conversational companion. It adds temporal context,
  topic tracking, open loops, activity rhythm, and communication style memory.
- Include `history-compression` when conversations can be long. Keep a hot window verbatim and summarize older messages
  into `conversation_summaries`; do not replace long-term memory with summaries.
- Include `global-memory` for admin-managed facts shared by all users or a shared knowledge base. Reads can be public;
  writes must be admin-only.
- Include `domain-schema` when domain facts have structured `data` fields that should be validated or canonicalized.
- Include `telegram` only when the user asks for a Telegram bot or a real messaging adapter.
- Include `voice-input` to accept uploaded audio, Telegram voice, video notes, or speech-to-text processing.
- Include `voice-output` when the bot should answer with synthesized speech or remember a user's text/voice preference.

## Required Secrets

| Feature | Required environment |
|---|---|
| `core` | `OPENAI_API_KEY`; optional `OPENAI_BASE_URL` |
| `memory` | `DATABASE_URL` |
| `secure-memory` | `AUTH_SECRET` |
| `telegram` | `TELEGRAM_BOT_TOKEN` |
| `voice-input` | provider-specific key, usually `OPENAI_API_KEY`, `GROQ_API_KEY`, or `ASSEMBLYAI_API_KEY` |
| `voice-output` | provider-specific key, usually `OPENAI_API_KEY` |

## Acceptance Checks

- `pytest` passes without live secrets by using fake LLMs and skipped integration tests.
- `python -m app.migrate` creates schema and seed domains idempotently.
- `python -m app.cli` can answer through the configured provider after `OPENAI_API_KEY` is set.
- Memory extraction stores only useful facts above thresholds and refuses high/secret facts without confirmation.
- Memory retrieval returns bounded context with profile, dialog, domain, secure summaries, and reminders separated.
- Tool calls are logged and return structured JSON-like dictionaries.
- Optional features disabled in `.env` do not change the base response path.
