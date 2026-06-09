# Python Architecture Notes

## Module Layout

Use this layout for generated or manually extended projects:

```text
app/config.py          pydantic settings and feature flags
app/db.py              psycopg pool, query helpers, vector serialization
app/llm.py             OpenAI-compatible chat, JSON, streaming, embeddings, transcription/TTS helpers
app/repo.py            users, conversations, messages, tool logs, domain helpers
app/memory.py          retrieve, build MEMORY_CONTEXT, extract candidates, merge/dedupe
app/secure_memory.py   encrypted values and redacted summaries
app/tools.py           tool registry, access checks, audit logging
app/agent.py           handle_message pipeline and event contract
app/scheduler.py       scheduled tasks, task claiming, notification outbox
app/proactive.py       trigger checks, anti-spam policy, proactive message generation
app/history.py         hot window and cold-zone summary compression
app/global_memory.py   admin-managed global facts and shared RAG snippets
app/domain_schema.py   schema registry and data validation
app/telegram_bot.py    Telegram adapter, formatting, long polling, voice/reaction handling
app/voice.py           speech-to-text and text-to-speech providers
```

## Response Pipeline

`handle_message` should do this in order:

1. Ensure user and active conversation.
2. Emit `agent.started`.
3. Classify intent with fallback to memory-enabled defaults.
4. Retrieve a bounded memory subset when `needs_memory` is not false.
5. Build dynamic system blocks: global facts, memory context, capabilities, global RAG, history, companion, datetime.
6. Run the main model with tool-calling for up to five turns. Emit tool events before and after execution.
7. Save user and assistant messages.
8. Extract and merge memory after the answer; tests may request synchronous extraction.
9. Emit `assistant.completed` and `agent.completed`.

## Memory Scoring

Rank memory with a weighted score:

- semantic/text relevance: 0.45
- importance: 0.25
- recency: 0.10
- confidence: 0.10
- entity match: 0.07
- usage count: 0.03

Apply hard limits per scope and total. Keep secure records out of normal retrieval; include redacted summaries only.

## Memory Write Rules

- Auto-save only when `importance >= 0.6`, `confidence >= 0.7`, and sensitivity is not `high` or `secret`.
- Sensitive or confirmation-required candidates return `needs_confirmation`.
- Merge by stable entity key first, normalized text second. Update existing facts instead of creating duplicates.
- Archive replaced facts when the new fact conflicts with the old one.
- Domain facts with structured `data` must pass the active domain schema when `domain-schema` is enabled.

## Event Contract

Events are channel-agnostic:

```python
{"type": "agent.started"}
{"type": "stage.started", "stage": "classify", "title": "..."}
{"type": "stage.started", "stage": "memory", "title": "..."}
{"type": "stage.started", "stage": "llm", "title": "..."}
{"type": "assistant.delta", "text": "..."}
{"type": "assistant.completed", "text": "..."}
{"type": "tool.started", "tool_name": "...", "tool_title": "..."}
{"type": "tool.completed", "tool_name": "...", "tool_title": "...", "ok": True}
{"type": "agent.completed"}
{"type": "agent.failed", "error": "..."}
```

Do not put private tool arguments into visible progress events.
