# Recipe: mass broadcast

**Use when:** send a message to a list of recipients (your own subscribers/opt-ins). Built on a paced sender
with mandatory throttling and FloodWait handling.

> ⚠ **Ban risk / ToS.** Bulk sending from a **user account** is the fastest way to get it limited or banned,
> and unsolicited messages violate Telegram's Terms. Only broadcast to people who opted in. Prefer a **bot**
> with users who pressed Start. Use conservative delays. Refuse to help with cold/spam blasts.

## Maps onto the scaffold

- `app/services/broadcast.py` — paced sender with throttle + FloodWait + per-recipient send state.
- A runner (function) that loads the recipient list and calls the service.
- Repository: recipient list + `sent` state so a restart doesn't double-send.

## Paced sender

```python
# app/services/broadcast.py
import asyncio, logging
from telethon.errors import FloodWaitError, UserPrivacyRestrictedError, RPCError

log = logging.getLogger(__name__)

async def broadcast(client, repo, recipients, text, *, delay=3.0):
    """Send `text` to each recipient with a fixed gap; survive FloodWait; record progress."""
    for rid in recipients:
        if await _already_sent(repo, rid):
            continue
        while True:
            try:
                await client.send_message(rid, text)
                await repo.save("sent", {"recipient": rid})
                break
            except FloodWaitError as e:
                log.warning("FloodWait %ss on %s", e.seconds, rid)
                await asyncio.sleep(e.seconds + 1)        # wait it out, then retry same recipient
            except UserPrivacyRestrictedError:
                log.info("skip %s (privacy)", rid); break
            except RPCError as e:
                log.warning("skip %s (%s)", rid, e); break
        await asyncio.sleep(delay)                        # pace between recipients

async def _already_sent(repo, rid) -> bool:
    # implement against your repo; e.g. a set/table of sent ids
    return False
```

## Gotchas

- **Throttle always.** A few seconds between sends, more for large lists. No tight loops — that triggers
  flood waits and bans. See [../../references/errors-and-flood.md](../../references/errors-and-flood.md).
- **Resume, don't restart.** Track sent recipients; on restart skip them.
- **Privacy errors are normal.** Many users block being messaged — skip and continue, don't abort.
- **Opt-in only.** Maintain a real opt-in list; provide an unsubscribe path. This recipe will not help with
  scraping strangers or evading limits.
- **Bot vs user.** A bot can only message users who started it — which is exactly the safe, compliant model.
