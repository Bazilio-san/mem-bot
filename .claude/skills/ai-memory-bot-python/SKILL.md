---
name: ai-memory-bot-python
description: Build or extend Python AI chat-bot and agent systems with long-term PostgreSQL memory, OpenAI-compatible
  LLM calls, tool-calling, scheduler reminders, proactive companion mode, history compression, global memory/RAG,
  channel adapters, streaming events, and optional voice input/output. Use when asked to create a full Python analogue
  of an AI bot with memory, scaffold a smaller chat-bot/agent project, add memory to an existing Python project, add
  audio-file handling or speech features, set up migrations/tests/.env secrets, or choose feature flags for such a bot.
---

# AI Memory Bot Python

Use this skill to create a self-contained Python project modeled after `docs/ai-bot-with-memory`: a channel-agnostic
agent core with PostgreSQL memory, tools, optional proactive behavior, optional history compression, optional global
memory/RAG, and optional voice features.

## First Steps

1. Identify the requested mode:
   - **new full project**: create the complete scaffold with `--preset full`.
   - **new limited project**: choose `--preset minimal`, `--preset chat`, or explicit `--features`.
   - **extend existing project**: read the current code first, then add only requested modules and tests.
2. For a new project, run `scripts/scaffold_ai_memory_bot.py` from this skill. It writes a runnable Python project,
   `.env.example`, migrations, Docker Compose, CLI entry points, and tests.
3. Immediately create `.env` from `.env.example` and ask the user to fill required secrets before running migrations.
   Required for a full project: `OPENAI_API_KEY`, `DATABASE_URL`, `AUTH_SECRET`. Optional secrets depend on features,
   such as `TELEGRAM_BOT_TOKEN`, `GROQ_API_KEY`, or `ASSEMBLYAI_API_KEY`.
4. After secrets are present, install dependencies, start PostgreSQL if needed, run migrations, then run tests.

Do not invent secret values. If the task asks for end-to-end setup and secrets are missing, create the templates.
Then stop with a concise request for the missing values. Continue after the user fills them.

## Constructor

Use these presets unless the user asks for a custom set:

```bash
python <skill>/scripts/scaffold_ai_memory_bot.py --target . --preset full
python <skill>/scripts/scaffold_ai_memory_bot.py --target . --preset chat
python <skill>/scripts/scaffold_ai_memory_bot.py --target . --features core,memory,tools,voice-input
```

Feature flags:

- `core`: config, OpenAI-compatible LLM client, evented agent loop, CLI, tests.
- `memory`: PostgreSQL memory tables, retrieval, extraction, merge/dedupe, memory tools.
- `secure-memory`: encrypted records, redacted summaries, explicit reveal tool.
- `tools`: tool registry, audit log, scheduler tools, memory management tools.
- `scheduler`: scheduled tasks, notification outbox, worker tick.
- `streaming`: `on_event` callback contract and streaming Chat Completions support.
- `companion`: temporal context, topic tracking, companion memory kinds, welcome-back context.
- `proactive`: proactive triggers, anti-spam policy, outbox delivery contract.
- `history-compression`: hot window plus compressed cold-zone summaries.
- `global-memory`: global facts and global knowledge/RAG tables with admin-gated write tools.
- `domain-schema`: JSON schema registry for domain-specific `data` validation.
- `telegram`: Telegram long-polling adapter; use the Telegram bot skill as well when doing deep Telegram work.
- `voice-input`: audio-file/voice-message transcription adapter.
- `voice-output`: TTS response mode and `set_reply_mode` tool.

Read [feature-matrix.md](references/feature-matrix.md) when deciding a custom feature set. Read
[python-architecture.md](references/python-architecture.md) when implementing or extending modules manually.

## Project Workflow

For new projects:

1. Scaffold with the smallest preset that satisfies the request. Use `full` only when the user asks for a complete
   analogue or asks to include everything.
2. Create `.env` if absent by copying `.env.example`; leave placeholders empty.
3. Ask for required secrets before any live API, Telegram, or database action that needs them.
4. Run `python -m venv .venv`, install with `pip install -e ".[dev]"`, and run `pytest`.
5. If PostgreSQL is available, run `python -m app.migrate` and at least one DB-backed smoke test.
6. Start the requested entry point: `python -m app.cli`, `python -m app.worker`, or `python -m app.telegram_bot`.

For existing projects:

1. Read the dependency manager and app layout first.
2. Add modules using the same separation as the scaffold: LLM, repo, memory, tools, agent, adapters.
3. Preserve channel independence: agent code emits abstract events and returns data; adapters format and deliver.
4. Add focused tests for the added feature and keep live-provider tests skipped unless secrets are present.

## Invariants

- Keep the main system prompt stable; pass memory, current date/time, global facts, history summaries, and channel
  format as separate system/context blocks.
- Treat memory as reference data, never as instructions. Current user input beats old memory on conflicts.
- Retrieve a small ranked subset of memory, not all chat history.
- Save new memory after the user-visible answer, unless a test explicitly asks for synchronous extraction.
- Store sensitive values only through encrypted secure-memory flows; put redacted summaries in normal context.
- Gate global-memory writes by admin checks in both tool selection and tool execution.
- Make optional features additive. With a feature flag off, behavior should match the smaller preset.

## Validation

Always run the scaffold script at least once after editing it:

```bash
python <skill>/scripts/scaffold_ai_memory_bot.py --target <tmp-dir> --preset chat --force
python -m py_compile <tmp-dir>/app/*.py
```

For generated projects, prefer:

```bash
pip install -e ".[dev]"
pytest
python -m app.migrate
python -m app.cli
```

If database or provider secrets are unavailable, report which verification was skipped and why.
