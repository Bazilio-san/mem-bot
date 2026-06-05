# Scaffold — shared application skeleton

Every recipe builds on this. It is the minimal layered Telethon app: config from `.env`, one client factory,
a repository interface with a SQLite implementation, a handler-registration pattern, and a `main.py`
composition root. Copy it, then add the recipe's handlers/services.

## Files

```
_scaffold/
├── .env.example              # required env vars (copy to .env, fill in)
├── requirements.txt          # pinned telethon + dotenv
├── main.py                   # composition root: build deps, register handlers, run
└── app/
    ├── config.py             # load + validate settings from .env
    ├── clients/telegram.py   # the single TelegramClient factory (user or bot)
    ├── repositories/base.py  # storage interface
    ├── repositories/sqlite.py# default SQLite implementation
    └── handlers/__init__.py  # register_handlers(client, deps) pattern
```

## How to extend it for a recipe

1. Add a service in `app/services/<feature>.py` with the business logic (no Telethon imports if you can).
2. Add a handler factory in `app/handlers/<feature>.py` that closes over the service and returns an
   `async def handler(event)`.
3. Register it in `register_handlers(...)` (or in `main.py`).
4. Add any new env vars to `.env.example` and `config.py`.

The recipe READMEs show exactly what to add for each app class. Keep handlers thin; see
[../../references/architecture.md](../../references/architecture.md).
