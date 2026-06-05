# Sessions

A Telethon **session** stores the authorization key and cached entities for an account. **A session is a
credential**: anyone with it has full access to the account. Treat it like a password.

## Session types

```python
from telethon import TelegramClient
from telethon.sessions import StringSession

# 1) SQLite (default): pass a name/path → creates `<name>.session` on disk.
client = TelegramClient("sessions/account", api_id, api_hash)

# 2) StringSession: portable, in-memory, serializable to a string.
client = TelegramClient(StringSession(session_string), api_id, api_hash)

# 3) MemorySession: volatile, lost on exit (pass StringSession() with no arg, or MemorySession()).
client = TelegramClient(StringSession(), api_id, api_hash)
```

- **SQLiteSession** (default) — a `.session` file on disk. Best for a normal long-running app on a host you
  control. Keep it in `sessions/` and in `.gitignore`.
- **StringSession** — serialize once, store the string in a secret manager / env var, rehydrate at startup.
  Best for containers, serverless, and CI where you don't want a writable file. Generate it once:

  ```python
  from telethon.sync import TelegramClient
  from telethon.sessions import StringSession
  with TelegramClient(StringSession(), api_id, api_hash) as c:
      print(c.session.save())   # run once locally, paste the output into your secret store
  ```

- **MemorySession** — nothing persists; you re-authenticate every run. Only for throwaway scripts/tests.

## Security rules

- Add `sessions/` and `*.session` to `.gitignore`. Never commit a session file or a session string.
- Never log the session string or print it outside the one-time generation step above.
- A leaked session = account takeover. If one leaks, **revoke active sessions** from the Telegram app
  (Settings → Devices) and regenerate.
- One session file per account. Don't run two processes against the same SQLite session concurrently — it
  locks and corrupts; use a `StringSession` per process or coordinate access.

## Where to put it

The scaffold loads the session path from config (`SESSION_NAME`, default `sessions/account`). For
`StringSession`, load the string from an env var (`SESSION_STRING`) and pass `StringSession(value)` to the
client factory.
