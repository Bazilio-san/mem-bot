# Architecture — application layout

Generate Telethon apps with a layered structure. Keep the Telethon client, business logic, and storage
separate so the app stays testable and the handlers stay thin.

## Canonical layout

```
telegram_app/
├── app/
│   ├── handlers/        # thin event handlers: parse the event, delegate, reply
│   ├── services/        # business logic (no Telethon imports ideally)
│   ├── repositories/    # data access (DB, files, external APIs) behind an interface
│   ├── clients/         # TelegramClient factory + external clients (LLM, STT)
│   └── models/          # data models (dataclass / pydantic)
├── sessions/            # *.session files — in .gitignore
├── logs/
├── config/              # settings loaded from .env
└── main.py              # wire dependencies, register handlers, run the client
```

For small apps you can collapse `config/` into `app/config.py` (the scaffold does this). Keep the
`handlers / services / repositories / clients` split even when each is one file — it is the boundary that
matters.

## Layer responsibilities

- **clients/** — owns the single `TelegramClient` instance (one per account; see
  [client-and-auth.md](client-and-auth.md)). Also wraps any external client (LLM, AssemblyAI). Nothing else
  constructs a client.
- **handlers/** — decorated with `@client.on(events.…)`. A handler extracts what it needs from the `event`,
  calls a service, and sends a reply. No DB queries, no long loops, no business rules here.
- **services/** — the actual behavior (matching rules, lead parsing, broadcast pacing). Ideally takes plain
  data in and out, so it can be unit-tested without Telegram.
- **repositories/** — persistence behind an interface (`base.py`), with a concrete implementation
  (`sqlite.py` by default). Lets you swap SQLite for Postgres/files without touching services.
- **models/** — typed structures passed between layers (e.g. a `Lead`, a `ScrapedMessage`).

## How each recipe maps onto the layout

| Recipe | handlers | services | repositories | extra in clients |
|--------|----------|----------|--------------|------------------|
| Auto-responder | `NewMessage` handler | reply-rule matcher | (optional) reply log | — |
| Channel scraper | `NewMessage(chats=…)` for live; a runner for history | normalize/dedupe | scraped-message store + last-id cursor | — |
| Group monitor | `NewMessage`, `ChatAction` | keyword/mention detector | alert log / seen-state | — |
| Telegram→LLM | `NewMessage` handler | prompt build + post-process | conversation history | LLM client |
| Lead capture | command handler starts a `conversation` | dialog flow + validation | leads store | — |
| Voice processing | `NewMessage(func=is_voice)` | transcription orchestration | transcripts store | STT client |
| Mass broadcast | command/trigger | paced sender (throttle) | recipient list + send state | — |
| Client agent | several command handlers | command dispatch + background tasks | per-feature stores | maybe LLM/STT |

## Wiring (composition root = `main.py`)

`main.py` is the only place that knows how everything fits together: it loads config, builds the client and
repositories, injects them into services, registers handlers, then runs the client. See
[../templates/_scaffold/main.py](../templates/_scaffold/main.py) for the concrete pattern. Handlers get their
dependencies via closures or a small context object, not via globals.
