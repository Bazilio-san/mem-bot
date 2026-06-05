# Recipe: channel scraper

**Use when:** you need to dump a channel's history and/or follow new posts, normalize them, and store them.
Two modes: a one-shot **backfill** over history, and a live **follow** of new posts.

## Maps onto the scaffold

- `app/services/normalize.py` — turn a Telethon `Message` into your stored shape (`ScrapedMessage`).
- `app/handlers/follow.py` — live `NewMessage(chats=...)` handler for new posts.
- A backfill runner (a function, not a handler) using `iter_messages` with a persisted cursor.
- Repository: store messages + a `cursor` per channel (last processed id) so restarts resume.

## Backfill (history), resumable

```python
# run a one-shot history dump; resumes from the last stored id.
from telethon.errors import FloodWaitError
import asyncio

async def backfill(client, repo, channel, cursor_name):
    last_id = await repo.get_cursor(cursor_name)
    newest = last_id
    try:
        # min_id=last_id fetches only messages newer than what we've seen.
        async for msg in client.iter_messages(channel, min_id=last_id):
            await repo.save("scraped", {
                "channel": str(channel),
                "id": msg.id,
                "date": msg.date,
                "text": msg.text or "",
                "sender_id": msg.sender_id,
            })
            newest = max(newest, msg.id)
    except FloodWaitError as e:
        await asyncio.sleep(e.seconds + 1)
    finally:
        await repo.set_cursor(cursor_name, newest)   # persist progress even on interruption
```

## Live follow (new posts)

```python
# app/handlers/follow.py
from telethon import events

def make_follow(repo):
    async def handler(event):
        msg = event.message
        await repo.save("scraped", {
            "channel": str(event.chat_id), "id": msg.id,
            "date": msg.date, "text": msg.text or "", "sender_id": msg.sender_id,
        })
    return handler

def register(client, repo, channels):
    client.add_event_handler(make_follow(repo), events.NewMessage(chats=channels))
```

## Gotchas

- **Entity resolution.** Resolve channels by username or invite link first to warm the cache; id-only lookups
  fail on a cold start. See [../../references/entities-and-chats.md](../../references/entities-and-chats.md).
- **FloodWait on big history.** `iter_messages` is paced, but long backfills still hit flood waits — sleep
  `e.seconds` and resume from the cursor. Don't restart from zero.
- **Access.** A bot can't read arbitrary channel history; use a **user account** that is a member. Only scrape
  channels the account is allowed to read.
- **Dedupe.** Key stored rows by `(channel, id)` so re-runs don't duplicate.
