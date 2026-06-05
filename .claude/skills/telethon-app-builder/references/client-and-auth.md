# Client and authentication (v1.43.x)

## Credentials

Every Telethon app needs an `api_id` (int) and `api_hash` (str). Get them once from
**https://my.telegram.org/apps** (log in with the account's phone number → "API development tools"). These
identify *your application*, not the account — the same pair is reused across user and bot logins.

Never hardcode them. Load from `.env` (see [production-practices.md](production-practices.md)).

## Constructing the client

```python
from telethon import TelegramClient

client = TelegramClient(session, api_id, api_hash)
```

`session` is either a name/path for an on-disk SQLite session, or a session object
(see [sessions.md](sessions.md)). One `TelegramClient` instance per account; build it in `app/clients/`.

## Logging in — user account

A user login is interactive the first time (phone → code → optional 2FA password), then the session file
remembers it:

```python
async def start_user(client):
    # Prompts for phone + login code on first run; reuses the session afterward.
    await client.start()
    return client
```

If the account has 2FA, `start()` will also prompt for the password. When you drive sign-in manually instead
of `start()`, catch `SessionPasswordNeededError` and call `client.sign_in(password=...)`
(see [errors-and-flood.md](errors-and-flood.md)).

## Logging in — bot

Same `api_id`/`api_hash`, plus a bot token from **@BotFather**. No phone/code:

```python
async def start_bot(client, bot_token):
    await client.start(bot_token=bot_token)
    return client
```

A bot client cannot do user-only things (e.g. read arbitrary dialog history it was never part of). Choose
user vs bot based on what the app must access.

## Running the client

For long-running apps (handlers/listeners), connect and block until disconnected:

```python
async def run(client):
    async with client:                  # connects, and disconnects on exit
        await client.run_until_disconnected()
```

For one-shot scripts (e.g. a history dump), just use the `async with client:` block and do the work inside,
then let it disconnect. Avoid `telethon.sync` in a real async app — it is a convenience shim for scripts and
the REPL, and mixing it with `asyncio` causes subtle bugs.

## One account, one client

`TelegramClient` is an asyncio object tied to one event loop and one account. Do not share a single instance
across threads. For multiple accounts, build multiple clients (each with its own session) and run them on the
same loop.
