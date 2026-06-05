# Production practices

The rules Claude most often forgets. Apply them to every generated Telethon app.

## Secrets and config

- `api_id`, `api_hash`, bot tokens, and any session string come from the environment, never code literals.
- Load them once in `app/config.py` (the scaffold uses `python-dotenv`; `pydantic-settings` is a fine
  upgrade). Validate required values at startup and fail fast with a clear message.
- Commit `.env.example` (keys, no values). Add `.env` to `.gitignore`.

```python
# app/config.py
import os
from dataclasses import dataclass
from dotenv import load_dotenv

load_dotenv()

@dataclass(frozen=True)
class Config:
    api_id: int
    api_hash: str
    session_name: str
    bot_token: str | None = None

def load_config() -> Config:
    try:
        api_id = int(os.environ["API_ID"])
        api_hash = os.environ["API_HASH"]
    except KeyError as e:
        raise SystemExit(f"Missing required env var: {e}. Copy .env.example to .env and fill it in.")
    return Config(
        api_id=api_id,
        api_hash=api_hash,
        session_name=os.getenv("SESSION_NAME", "sessions/account"),
        bot_token=os.getenv("BOT_TOKEN"),
    )
```

## Sessions

- A `*.session` file (or `StringSession`) is a credential — `sessions/` and `*.session` go in `.gitignore`.
- Use `StringSession` (from an env var/secret) for containers and CI; SQLite file for hosts you control.
- One process per session file. See [sessions.md](sessions.md).

## Layering

- Telethon client ↔ business logic ↔ storage stay separate (see [architecture.md](architecture.md)).
- Handlers are thin; services hold rules; repositories hide persistence. Don't query a DB inside a handler.

## Async hygiene

- Never block the event loop. Blocking/CPU-bound work (parsing big files, heavy regex, sync SDKs) goes to a
  thread via `asyncio.to_thread(...)` or a `run_in_executor`.
- Don't use `telethon.sync` in a real async app; it's for scripts/REPL only.
- Use `asyncio.run(main())` as the single entry point; create the client inside the running loop.

## Rate limiting and resilience

- Wrap API calls in FloodWait handling and throttle loops (see [errors-and-flood.md](errors-and-flood.md)).
- Persist progress for long jobs (last processed message id, broadcast cursor) so restarts resume.
- Make handlers idempotent where possible; de-dupe by message id.

## Lifecycle, logging, deploy

```python
import asyncio, logging

async def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=[logging.StreamHandler(), logging.FileHandler("logs/app.log")],
    )
    # build client + deps, register handlers...
    async with client:
        await client.run_until_disconnected()

if __name__ == "__main__":
    asyncio.run(main())
```

- Structured logs to `logs/`; never log secrets or session strings.
- Graceful shutdown: the `async with client:` block disconnects cleanly on exit/signal.
- Deploy as a long-running service (systemd unit, Docker container, or a process manager). In containers,
  prefer `StringSession` so there's no writable session file to manage.
- Pin the Telethon version (`telethon==1.43.*`) in `requirements.txt` so an API change doesn't surprise you.

## Ethics / ToS

- Userbot automation and bulk sending can violate Telegram's ToS and get the account banned. Add conservative
  delays, warn the user, and refuse spam, ban-evasion, or scraping content the account has no access to.
