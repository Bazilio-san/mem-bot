# Recipe: Telegram → LLM → Telegram

**Use when:** take an incoming message, run it through an LLM, and reply. Telethon is just the transport; the
intelligence is the LLM layer.

> **Cross-link:** build the agent/LLM layer with the **`building-pydantic-ai-agents`** skill. This recipe
> shows only how to plug it into Telethon. Provider/keys for the LLM come from `.env`, never code.

## Maps onto the scaffold

- `app/clients/llm.py` — the LLM/agent client (from the pydantic-ai skill), built once.
- `app/services/conversation.py` — build the prompt, keep short per-chat history, post-process the reply.
- `app/handlers/chat.py` — thin handler: get reply text from the service, send it.
- Repository: per-chat conversation history (optional but recommended).

## Handler

```python
# app/handlers/chat.py
from telethon import events

def make_chat_handler(answer):  # answer: async (chat_id, text) -> str
    async def handler(event):
        if not event.raw_text:
            return
        async with event.client.action(event.chat_id, "typing"):  # show "typing…" while the LLM runs
            reply = await answer(event.chat_id, event.raw_text)
        await event.reply(reply)
    return handler

def register(client, answer):
    client.add_event_handler(make_chat_handler(answer),
                             events.NewMessage(incoming=True, func=lambda e: e.is_private))
```

## Service (wraps the agent)

```python
# app/services/conversation.py — `answer` closes over your pydantic-ai agent + history store
def make_answer(agent, repo):
    async def answer(chat_id: int, text: str) -> str:
        # Optionally load recent history for context:
        # history = await repo.load_history(chat_id)
        result = await agent.run(text)          # see building-pydantic-ai-agents skill
        reply = result.output if hasattr(result, "output") else str(result)
        # await repo.append_history(chat_id, text, reply)
        return reply[:4000]                      # Telegram message length guard
    return answer
```

## Gotchas

- **Latency.** LLM calls take seconds — use `client.action(chat, "typing")` so the user sees activity, and
  don't block the loop (the agent call is awaited, not run sync).
- **Message length.** Telegram caps message length (~4096 chars). Truncate or split long replies.
- **Cost/abuse control.** Rate-limit per user; ignore empty/non-text messages; consider an allowlist.
- **Don't echo untrusted text into Markdown** without escaping
  ([../../references/messages-and-media.md](../../references/messages-and-media.md)).
- **User vs bot.** A public assistant is usually a **bot**; a personal one can run on a user account.
