# Recipe: lead capture / CRM

**Use when:** collect structured data from a user through a guided dialog (name → email → need), validate it,
and store it. Uses Telethon's **conversation** API for a linear flow.

> **Grow into a CRM:** combine this with the **client_agent** recipe. Lead capture is the intake; the client
> agent adds admin commands (list leads, export, assign) and background follow-ups on top of the same repo.

## Maps onto the scaffold

- `app/services/lead_flow.py` — the dialog steps + validation (returns a `Lead` or raises).
- `app/handlers/lead.py` — a command handler (`/lead`) that opens a conversation and runs the flow.
- `app/models/lead.py` — the `Lead` dataclass.
- Repository: a `leads` collection.

## Dialog with `client.conversation`

```python
# app/handlers/lead.py
import re
from telethon import events

EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

def make_lead_handler(repo):
    async def handler(event):
        async with event.client.conversation(event.chat_id, timeout=120) as conv:
            await conv.send_message("What's your name?")
            name = (await conv.get_response()).raw_text.strip()

            await conv.send_message("Your email?")
            for _ in range(3):
                email = (await conv.get_response()).raw_text.strip()
                if EMAIL.match(email):
                    break
                await conv.send_message("That doesn't look like an email — try again.")
            else:
                await conv.send_message("Too many tries, cancelled.")
                return

            await conv.send_message("Briefly, what do you need?")
            need = (await conv.get_response()).raw_text.strip()

            await repo.save("leads", {"name": name, "email": email, "need": need,
                                      "user_id": event.sender_id})
            await conv.send_message("Thanks! We saved your request and will be in touch. ✅")
    return handler

def register(client, repo):
    client.add_event_handler(make_lead_handler(repo), events.NewMessage(pattern=r"^/lead$"))
```

## Gotchas

- **One conversation per chat.** Opening a second `conversation` for the same chat while one is active raises;
  guard against double-starts, and set a `timeout` so abandoned flows free up.
- **`get_response()` waits for the next message** from that user in that chat — it does not validate; you
  validate (loop with retries, as above).
- **Cancellation.** Offer `/cancel`; catch `asyncio.TimeoutError` from the conversation timeout and tell the
  user it expired.
- **Conversation is a v1 convenience.** In v2 the dialog pattern differs — see
  [../../references/v1-to-v2.md](../../references/v1-to-v2.md).
- **Privacy.** You're storing personal data — keep the DB out of git, and only collect what you need.
