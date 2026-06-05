# Errors and FloodWait (v1.43.x)

All Telethon RPC errors live in `telethon.errors`. Handle them explicitly — especially `FloodWaitError`,
which **every** non-trivial app will hit.

## FloodWaitError — the one you must handle

Telegram rate-limits. When you go too fast, the API responds with a flood-wait telling you how many seconds
to back off:

```python
import asyncio
from telethon.errors import FloodWaitError

async def safe_call(coro_factory):
    while True:
        try:
            return await coro_factory()
        except FloodWaitError as e:
            # e.seconds = how long Telegram wants us to wait.
            await asyncio.sleep(e.seconds + 1)
```

- `e.seconds` is the required wait. Sleep it (plus a small margin), then retry the **same** call.
- Telethon auto-sleeps short flood waits below `client.flood_sleep_threshold` (default 60s). Set it to bound
  what it swallows silently:

  ```python
  client.flood_sleep_threshold = 60   # auto-sleep waits <= 60s; raise FloodWaitError above that
  ```

- For long waits (minutes/hours), don't busy-wait the whole process — log it, and for batch jobs (scraping,
  broadcasting) persist progress so a restart resumes cleanly.
- **Prevention beats cure:** throttle loops (a small `await asyncio.sleep(...)` between sends), use
  `iter_messages` (already paced) instead of manual paging, and never fan out hundreds of calls at once.

## 2FA on sign-in

When signing in to a 2FA-protected account manually (not via `start()`):

```python
from telethon.errors import SessionPasswordNeededError

try:
    await client.sign_in(phone, code)
except SessionPasswordNeededError:
    await client.sign_in(password=two_factor_password)
```

## Other errors you'll meet

| Exception | Meaning | Typical handling |
|-----------|---------|------------------|
| `ChatAdminRequiredError` | account lacks admin rights for the action | report clearly; don't retry |
| `UserPrivacyRestrictedError` | target's privacy blocks the action (e.g. adding to a group) | skip that user |
| `ChannelPrivateError` | channel is private / account was kicked | drop it from the watch list |
| `MessageNotModifiedError` | edit produced identical text | ignore |
| `UserDeactivatedError` / `AuthKeyError` | account banned / session invalid | stop; alert a human |
| `rpcerrorlist.*` | many specific RPC errors | catch specific ones you expect |

Generic safety net: catch `telethon.errors.RPCError` (the base for server-side errors) as a fallback, but
prefer catching the specific exceptions you actually expect so real bugs aren't swallowed.

## A reusable retry wrapper

```python
import asyncio, logging
from telethon.errors import FloodWaitError, RPCError

log = logging.getLogger(__name__)

async def with_retries(coro_factory, *, retries=3):
    """Run an async Telegram call, sleeping through FloodWait and retrying transient RPC errors."""
    attempt = 0
    while True:
        try:
            return await coro_factory()
        except FloodWaitError as e:
            log.warning("FloodWait: sleeping %ss", e.seconds)
            await asyncio.sleep(e.seconds + 1)
        except RPCError as e:
            attempt += 1
            if attempt > retries:
                raise
            log.warning("RPCError %s, retry %s/%s", e, attempt, retries)
            await asyncio.sleep(2 ** attempt)
```

Pass a zero-arg lambda that creates the coroutine: `await with_retries(lambda: client.send_message(chat, txt))`.
Re-create the coroutine each attempt — you cannot await the same coroutine object twice.
