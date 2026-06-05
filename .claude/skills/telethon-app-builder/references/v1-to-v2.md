# Choosing a version: v1 vs v2

**Default to v1.43.x.** This whole skill targets v1. Only switch to v2 when the user explicitly asks, and
when they do, do not mix the two APIs in one file — they are incompatible.

## Status (as of this skill's build)

- **v1 — `1.43.x` (stable, maintenance mode).** Recommended for all production work today. Bug fixes and new
  layers still land; the API is settled. `pip install telethon`.
- **v2 — `2.0.0a` (alpha).** A ground-up async rewrite with a different API. Not recommended for production
  until it stabilizes. `pip install "telethon>=2.0a0"` (pre-release).
- Canonical repo: **Codeberg** (`codeberg.org/Lonami/Telethon`). The GitHub mirror is archived.

## Key API differences

| Aspect | v1.43.x (this skill) | v2.0.0a |
|--------|----------------------|---------|
| Client class | `from telethon import TelegramClient` | `from telethon import Client` |
| Sync convenience | `telethon.sync` shim exists | removed — async only |
| Login | `await client.start()` | `await client.connect()` then `await client.interactive_login()` |
| History iteration | `client.iter_messages(...)` | unified method usable with `await` and `async for` |
| Event filters | nested filter args, may do work/IO | standalone **sync** filter functions combined with `&` `|` `~` |
| Own messages | do **not** trigger handlers by default | **do** trigger handlers |
| `StopPropagation` | available | removed |

## Migration guidance

If a user has v1 code and wants v2:

1. Confirm they truly need v2 (alpha risk). Most should stay on v1.43.x.
2. Swap `TelegramClient` → `Client`; remove any `telethon.sync` usage; make everything async.
3. Replace `start()` with `connect()` + `interactive_login()`.
4. Rewrite event registration to v2's standalone filter functions; account for own-message events now firing.
5. Follow the official migration guide: `https://docs.telethon.dev/en/v2/developing/migration-guide.html`.

When generating v2 code, fetch the v2 docs (`https://docs.telethon.dev/en/v2/`) for exact signatures — the
v1 references in this skill do not apply.
