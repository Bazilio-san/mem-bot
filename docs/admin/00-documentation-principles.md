# 00. Documentation Principles for the Admin Interface

This document establishes the rules for maintaining the administrative interface documentation in the `docs/admin/`
directory. It takes precedence over all other documents in that directory: whenever any of them are changed or
extended, these rules must be followed.

## Single Authoritative State

The admin interface documentation describes **the state of the current implementation** — how the combined web
server and the Vue front-end are structured right now, with all their functionality in place. Documents are written
in the present tense and from the perspective of the one and only current state, as if the interface had always been
built this way.

## No References to Past States

Documents **must not contain references to past states**: no "it used to work like this, now it works like that",
no "added in version X", no "temporarily simplified", and no other historical notes of that kind. Change history
belongs in version control, not in the documentation itself.

## New Functionality as the Only State

When admin interface functionality changes or is added, it must not be described as "new" or as a "change". Instead,
find the appropriate places in the existing documents and integrate it there **as the sole current state** — as if
the interface had always worked that way.

## Admin-Specific Scope and Boundary with the Specification

Like the Telegram bot documentation (in `docs/telegram/`), and unlike the AI bot specification (in
`docs/ai-bot-with-memory/`) which is channel-agnostic and portable, **this documentation is intentionally
project-specific**: the concrete web server, its routes, the JSON API, and the front-end application live here and
nowhere else. It does not duplicate business logic; it only shows how the admin interface surfaces the AI bot's
data and programmatic API to an operator. If a behaviour belongs to the bot core rather than to the admin layer,
its place is in the specification — only the admin-level mapping stays here. The rules for maintaining the
specification itself are in `docs/ai-bot-with-memory/00-documentation-principles.md`, and the rules for the Telegram
adapter are in `docs/telegram/00-documentation-principles.md`.
