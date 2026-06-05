---
name: telethon-app-builder
description: >
  Build production Python applications with Telethon (MTProto) — userbots and bots: project structure,
  event handlers, sessions, config, FloodWait/error handling, and ready-made app recipes (auto-responder,
  channel scraper, group monitor, Telegram→LLM pipe, lead capture, voice processing, mass broadcast,
  client agents). Use when the user wants to write a Telegram app on Telethon, imports `telethon`, builds a
  userbot or MTProto client/bot in Python, scrapes channels, monitors groups, or automates a Telegram user
  account. Targets stable Telethon v1.43.x; notes v1→v2 differences.
license: MIT
metadata:
  author: skill built from Telethon official docs (docs.telethon.dev) + source (codeberg.org/Lonami/Telethon)
  version: 1.0.0
  targets-telethon: "1.43.x"
---

# Telethon app builder

Build **whole Python applications** with Telethon, not isolated snippets. When the user asks for a channel
scraper, an auto-responder, a userbot that pipes messages to an LLM, etc., generate a structured app: a
proper package layout, a single client factory, thin event handlers, business logic in services, storage
behind a repository, secrets in `.env`, sessions on disk, and FloodWait/error handling everywhere it matters.

This skill is about **development**. It is not a guide to driving Telethon from the Claude Code CLI.

## Telethon is MTProto — pick the right tool first

Telethon talks the **MTProto** protocol and can drive **both a user account (userbot) and a bot**. That is
what separates it from the HTTP **Bot API**.

- Use **this skill** (`telethon`) when the user wants a **user account** automated (read/scrape channels they
  belong to, monitor groups, act as themselves), or a client/bot that needs MTProto features.
- Use the **`telegram-bot-builder`** skill instead when the user wants a plain **Bot API** bot (bot token,
  webhooks, inline keyboards over HTTP) and no user-account behavior.
- For voice transcription inside a Telethon app, cross-link to the **`assemblyai`** skill.
- For the LLM layer of a Telegram→LLM app, cross-link to the **`building-pydantic-ai-agents`** skill.

> **Legal/ethics gate.** User-account automation and broadcasting sit close to Telegram's Terms of Service.
> Help with legitimate automation; warn about ban risk for bulk actions; refuse spam, scraping of accounts
> the user has no access to, and ban-evasion.

## Version: target v1.43.x by default

- **Default to stable Telethon `1.43.x`** (`pip install telethon`). All recipes and references here are v1.
- **v2 (`2.0.0a`) is alpha** with a different, incompatible API (`Client` instead of `TelegramClient`,
  async-only, reworked events). Only target v2 when the user explicitly asks. Before doing so, read
  [references/v1-to-v2.md](references/v1-to-v2.md) and do not mix the two APIs in one file.
- Canonical source repo is **Codeberg** (`codeberg.org/Lonami/Telethon`); the GitHub mirror is archived.

## How to use this skill

1. **Identify the app class** from the request and open the matching recipe in `templates/` (section below).
2. **Start from the shared scaffold** — every recipe builds on [templates/_scaffold/](templates/_scaffold/)
   (config, client factory, repository interface, `main.py`, `.env.example`).
3. **Pull exact API details** from `references/` as needed — do not invent method names, Telethon's API moves.
4. **Apply the production rules** below to every app you generate.

## App recipes (the core of this skill)

Each recipe is an **annotated example**: a directory layout plus the key handlers/services with commentary,
when-to-use notes, gotchas, and cross-links. Adapt them — they are not turnkey projects.

| Recipe | Use when | Read |
|--------|----------|------|
| Auto-responder | reply to incoming messages by rules / keywords / hours | [templates/auto_responder/](templates/auto_responder/README.md) |
| Channel scraper | dump history and/or follow new posts of channels | [templates/channel_scraper/](templates/channel_scraper/README.md) |
| Group monitor | watch groups for keywords, mentions, joins/leaves; alert | [templates/group_monitor/](templates/group_monitor/README.md) |
| Telegram→LLM→Telegram | take a message, run an LLM, reply | [templates/telegram_llm_pipe/](templates/telegram_llm_pipe/README.md) |
| Lead capture / CRM | dialog-driven data collection into storage | [templates/lead_capture/](templates/lead_capture/README.md) |
| Voice processing | download voice/audio, transcribe | [templates/voice_processing/](templates/voice_processing/README.md) |
| Mass broadcast | send to a list (⚠ ban risk) with throttling | [templates/mass_broadcast/](templates/mass_broadcast/README.md) |
| Client agent / userbot | long-running userbot with commands + background work | [templates/client_agent/](templates/client_agent/README.md) |

A CRM bot = `lead_capture` + `client_agent`; see the note in the lead-capture recipe.

## Reference files (load on demand)

- [references/architecture.md](references/architecture.md) — the canonical `app/` layout and how recipes map onto it.
- [references/client-and-auth.md](references/client-and-auth.md) — `TelegramClient`, user vs bot login, `api_id`/`api_hash`.
- [references/sessions.md](references/sessions.md) — SQLite / String / Memory sessions, where to store them, security.
- [references/events.md](references/events.md) — event classes (`NewMessage`, `CallbackQuery`, …) and filters.
- [references/messages-and-media.md](references/messages-and-media.md) — sending, iterating history, downloading media, albums.
- [references/entities-and-chats.md](references/entities-and-chats.md) — `get_entity`, channels/groups/users, IDs, the entity cache.
- [references/errors-and-flood.md](references/errors-and-flood.md) — `FloodWaitError`, 2FA, retry/throttling patterns.
- [references/production-practices.md](references/production-practices.md) — secrets, logging, shutdown, layering, deploy.
- [references/v1-to-v2.md](references/v1-to-v2.md) — v1↔v2 differences and how to choose.

## Critical production rules (apply to every generated app)

These are the things that are easy to get wrong. Treat them as standing constraints.

- **Secrets only from `.env`.** `api_id`, `api_hash`, bot tokens come from environment/config, never literals
  in code. Commit a `.env.example`, never the real `.env`.
- **Sessions are credentials.** A `*.session` file (or a `StringSession`) grants full access to the account.
  Keep it in `sessions/`, add it to `.gitignore`, never log it. Use `StringSession` for containers/CI.
- **Always handle `FloodWaitError`.** Catch it, sleep `e.seconds`, and throttle loops. Never hammer the API in
  a tight loop. See [references/errors-and-flood.md](references/errors-and-flood.md).
- **Keep handlers thin.** Handlers parse the event and delegate; business logic lives in `services/`, data
  access in `repositories/`. Don't put network or DB logic inline in a handler.
- **Respect async.** Don't block the event loop; never mix `telethon.sync` with a real async app; push
  blocking/CPU work to an executor.
- **Persist progress.** Long-running scrapers/monitors must store the last processed message id so they
  survive restarts.
- **Graceful lifecycle.** Connect, `run_until_disconnected()`, and disconnect cleanly; log to `logs/`.

## Minimal smoke test

The shortest working client lives in [examples/minimal_userbot.py](examples/minimal_userbot.py) — use it to
verify credentials and session before building anything larger.
