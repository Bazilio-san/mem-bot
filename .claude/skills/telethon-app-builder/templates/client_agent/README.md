# Recipe: client agent / userbot

**Use when:** a long-running userbot that responds to commands and also runs background work (periodic checks,
scheduled posts, cleanup). This is the "combine everything" recipe — it shows command dispatch + a background
task alongside the event loop.

## Maps onto the scaffold

- `app/handlers/commands.py` — several command handlers (`/help`, feature commands).
- `app/services/*` — one service per feature.
- A **background task** started next to `run_until_disconnected()`.
- Repository: per-feature stores.

## Command handlers

```python
# app/handlers/commands.py
from telethon import events

def register(client, deps):
    @client.on(events.NewMessage(pattern=r"^/help$", outgoing=True))   # control it from your own account
    async def _help(event):
        await event.reply("Commands: /help, /stats, /digest")

    @client.on(events.NewMessage(pattern=r"^/stats$", outgoing=True))
    async def _stats(event):
        count = await deps["repo"].get_cursor("processed")
        await event.reply(f"Processed: {count}")
```

Using `outgoing=True` lets you drive the userbot by typing commands from the same account (a common userbot
pattern). For a public bot, drop `outgoing=True` and use incoming commands instead.

## Background task alongside the client

```python
# main.py (extended) — run a periodic job concurrently with the client.
import asyncio

async def periodic(client, deps, interval=3600):
    while True:
        try:
            # e.g. post a digest, prune old data, poll an external source…
            await do_periodic_work(client, deps)
        except Exception:
            logging.getLogger(__name__).exception("periodic job failed")
        await asyncio.sleep(interval)

async def main():
    # ...build client + deps, start, register handlers...
    async with client:
        await start_client(client, config)
        register(client, deps)
        bg = asyncio.create_task(periodic(client, deps))   # runs in parallel
        try:
            await client.run_until_disconnected()
        finally:
            bg.cancel()                                     # clean shutdown
```

## Gotchas

- **Don't block the loop in the background task** — keep it async; offload heavy work with `asyncio.to_thread`.
- **Cancel background tasks on shutdown** (the `finally: bg.cancel()` above) so the process exits cleanly.
- **Guard commands.** `outgoing=True` (own account) or an admin allowlist prevents strangers triggering admin
  commands.
- **State across restarts.** Persist what the background job needs (cursors, last-run time) via the repo.
- **One client, one loop.** All handlers and the background task share the single client and event loop; don't
  spin up threads that touch the client.
