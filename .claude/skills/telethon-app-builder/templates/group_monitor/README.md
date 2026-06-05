# Recipe: group monitor

**Use when:** watch one or more groups for keywords, mentions, or membership changes, and raise alerts
(forward to an admin chat, log, notify). Built on `events.NewMessage` and `events.ChatAction`.

## Maps onto the scaffold

- `app/services/detect.py` — decide whether a message is "interesting" (keywords, mention of you, regex).
- `app/handlers/monitor.py` — message handler + chat-action handler; both delegate to a service and alert.
- Repository: optional alert log / seen-state.

## Keyword + mention monitor

```python
# app/services/detect.py
import re

def make_detector(keywords, my_username):
    patt = re.compile("|".join(re.escape(k) for k in keywords), re.I) if keywords else None
    def is_interesting(text: str) -> bool:
        if patt and patt.search(text):
            return True
        if my_username and f"@{my_username}".lower() in text.lower():
            return True
        return False
    return is_interesting
```

```python
# app/handlers/monitor.py
from telethon import events

def make_message_monitor(is_interesting, alert):
    async def handler(event):
        if is_interesting(event.raw_text):
            sender = await event.get_sender()
            await alert(f"🔔 In {event.chat_id} from {getattr(sender, 'username', sender.id)}:\n{event.raw_text}")
    return handler

def register(client, watched_chats, is_interesting, alert):
    client.add_event_handler(make_message_monitor(is_interesting, alert),
                             events.NewMessage(chats=watched_chats))
```

## Membership changes (joins / leaves / pins)

```python
from telethon import events

@client.on(events.ChatAction(chats=watched_chats))
async def on_action(event):
    if event.user_joined or event.user_added:
        await alert(f"➕ user joined {event.chat_id}")
    elif event.user_left or event.user_kicked:
        await alert(f"➖ user left {event.chat_id}")
    elif event.new_pin:
        await alert(f"📌 new pin in {event.chat_id}")
```

`alert(text)` is an injected coroutine — e.g. `lambda t: client.send_message(admin_chat_id, t)`.

## Gotchas

- **ChatAction fields are situational** — check `event.user_joined`, `event.user_left`, `event.user_kicked`,
  `event.new_pin`, `event.new_title` rather than assuming one shape.
- **Scope with `chats=`** so you only process the groups you watch, not every dialog.
- **Alert throttling.** A noisy group can spam your alert chat — debounce or batch alerts to avoid FloodWait
  on the outgoing side.
- Resolve watched groups by username/link first to warm the entity cache
  ([../../references/entities-and-chats.md](../../references/entities-and-chats.md)).
