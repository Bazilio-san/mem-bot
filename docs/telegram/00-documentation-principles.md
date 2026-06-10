# 00. Documentation Principles for the Telegram Bot

This document establishes the rules for maintaining the Telegram bot documentation in the `docs/telegram/` directory.
It takes precedence over all other documents in that directory: whenever any of them are changed or extended, these
rules must be followed.

## Single Authoritative State

The Telegram bot documentation describes **the state of the current implementation** — how the adapter is structured
right now, with all its functionality in place. Documents are written in the present tense and from the perspective
of the one and only current state, as if the adapter had always been built this way.

## No References to Past States

Documents **must not contain references to past states**: no "it used to work like this, now it works like that",
no "added in version X", no "temporarily simplified", and no other historical notes of that kind. Change history
belongs in version control, not in the documentation itself.

## New Functionality as the Only State

When Telegram bot functionality changes or is added, it must not be described as "new" or as a "change". Instead,
find the appropriate places in the existing documents and integrate it there **as the sole current state** — as if
the adapter had always worked that way.

## Telegram-Specific Scope and Boundary with the Specification

Unlike the AI bot specification (in `docs/ai-bot-with-memory/`), which is channel-agnostic and portable, **this
documentation is intentionally Telegram-specific**: the concrete commands, menus, buttons, press codes, and
Telegram adapter handlers live here and nowhere else. It does not duplicate business logic; it only shows how
user actions in Telegram map onto the programmatic API of the AI bot. If a behaviour belongs to the bot core
rather than to the channel, its place is in the specification — only the Telegram-level mapping stays here. The
rules for maintaining the specification itself are in `docs/ai-bot-with-memory/00-documentation-principles.md`.
