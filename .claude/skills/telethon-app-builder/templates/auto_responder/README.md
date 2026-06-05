# Recipe: auto-responder

**Use when:** the app should reply to incoming messages by rules — keywords, sender, or working hours
(out-of-office, FAQ bot, first-touch replies). Built on `events.NewMessage`.

## Maps onto the scaffold

- `app/services/reply_rules.py` — pure rule matching: text in → reply text out (or `None`).
- `app/handlers/autoreply.py` — thin handler that calls the service and replies.
- Register in `register_handlers`. No new storage needed (add a reply log via the repo if you want an audit).

## Service (pure, testable)

```python
# app/services/reply_rules.py
from datetime import datetime, time

RULES = {
    "price": "Our pricing is at example.com/pricing.",
    "hours": "We're open 9:00–18:00, Mon–Fri.",
}

def match_reply(text: str, now: datetime | None = None) -> str | None:
    """Return a reply for the message text, or None to stay silent."""
    now = now or datetime.now()
    lowered = text.lower()
    for keyword, reply in RULES.items():
        if keyword in lowered:
            return reply
    # Out-of-office fallback outside working hours:
    if not (time(9) <= now.time() <= time(18)):
        return "Thanks! We'll reply during business hours (9:00–18:00)."
    return None
```

## Handler (thin)

```python
# app/handlers/autoreply.py
from telethon import events
from app.services.reply_rules import match_reply

def make_autoreply():
    async def handler(event):
        reply = match_reply(event.raw_text)
        if reply:
            await event.reply(reply)
    return handler

def register(client):
    # incoming=True → only messages from others; private chats only here.
    client.add_event_handler(make_autoreply(), events.NewMessage(incoming=True, func=lambda e: e.is_private))
```

Call `register(client)` from `register_handlers` in the scaffold.

## Gotchas

- **Don't reply to yourself / loops.** Use `incoming=True` so your own outgoing messages don't trigger it. In
  v2 own messages *do* fire — add an explicit `not event.out` guard there.
- **Don't auto-reply in big groups** unless intended — scope with `func=lambda e: e.is_private` or `chats=`.
- **Rate.** A burst of incoming messages means a burst of replies; consider a per-chat cooldown to avoid
  flooding (and FloodWait). See [../../references/errors-and-flood.md](../../references/errors-and-flood.md).
- **Userbot etiquette.** Auto-replying from a *user* account to strangers can look like spam — prefer a bot
  account for public-facing auto-reply.
