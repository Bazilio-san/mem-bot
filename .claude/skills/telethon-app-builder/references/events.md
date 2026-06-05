# Events (v1.43.x)

Telethon delivers updates as **events**. You register an async handler with the `@client.on(...)` decorator
(or `client.add_event_handler`). Handlers must be `async def`.

```python
from telethon import events

@client.on(events.NewMessage(pattern=r"^/start"))
async def on_start(event):
    await event.respond("Hello!")
```

## Event classes (`telethon.events`)

- **`NewMessage`** — a new message arrives. The workhorse. Filters: `chats=`, `pattern=`, `incoming=`,
  `outgoing=`, `from_users=`, `func=`, `forwards=`.
- **`MessageEdited`** — a message was edited (same filters as `NewMessage`).
- **`MessageDeleted`** — messages were deleted.
- **`MessageRead`** — read receipts.
- **`ChatAction`** — joins, leaves, title/photo changes, pins. Use for group membership/admin events.
- **`UserUpdate`** — typing/online status of a user.
- **`CallbackQuery`** — an inline button was pressed (bots). Filter with `data=` or `pattern=`.
- **`InlineQuery`** — inline `@bot query` typed (bots).
- **`Album`** — a grouped media album arrived as one event (instead of N `NewMessage`).
- **`Raw`** — raw Telegram `Update` objects, when you need something the high-level events don't expose.

## The event object (for `NewMessage`)

Common fields/methods you'll use in handlers:

```python
event.raw_text        # message text (no formatting)
event.message         # the full Message object
event.chat_id         # where it came from
event.sender_id       # who sent it
await event.get_sender()   # the User/Channel entity (network call, cached)
await event.get_chat()
event.is_private / event.is_group / event.is_channel
event.out             # True if the message is outgoing (sent by us)

await event.respond("text")   # send a new message to the same chat
await event.reply("text")     # reply to the triggering message
await event.edit("text")      # edit (only your own messages)
await event.delete()
```

## Filters — keep them cheap

Prefer built-in filter arguments over logic inside the handler when you can:

```python
# Only this channel, only incoming, only messages matching a regex:
@client.on(events.NewMessage(chats=channel_id, incoming=True, pattern=r"(?i)urgent"))
async def alert(event): ...

# Custom predicate via func (must be fast; runs for every candidate event):
@client.on(events.NewMessage(func=lambda e: e.voice is not None))
async def on_voice(event): ...

# Restrict to specific senders:
@client.on(events.NewMessage(from_users=[123456, "username"]))
async def from_vips(event): ...
```

Notes:

- In **v1**, your own outgoing messages do **not** trigger handlers by default (use `outgoing=True` to catch
  them). This flips in v2 — see [v1-to-v2.md](v1-to-v2.md).
- Raise `events.StopPropagation` inside a handler to stop later handlers from also running for that event.
- `chats=` and `from_users=` accept ids, usernames, or entities; resolving usernames costs a network call the
  first time (then it's cached — see [entities-and-chats.md](entities-and-chats.md)).

## Registering without decorators

When handlers live in `app/handlers/` and need injected dependencies, register them explicitly in `main.py`:

```python
from telethon import events
client.add_event_handler(make_handler(service), events.NewMessage(chats=watched))
```

where `make_handler(service)` returns an `async def handler(event)` closure. This keeps handlers thin and
testable while passing in services/repositories.
