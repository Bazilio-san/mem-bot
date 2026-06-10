# 00. Documentation Principles

This document defines the rules governing all documentation in the `docs/ai-bot-with-memory/` directory. It takes
precedence over all other documents: whenever any of them is changed or extended, these rules must be followed.

## Single Authoritative State

All documentation in the `docs/ai-bot-with-memory/` directory describes **the ideal implementation state** — how the
system is structured when every requirement is fulfilled and all functionality is complete. Documents are written in
the present tense and from the perspective of the one current state of the system, as if it were already fully
implemented.

## No References to Past States

The documentation **must not contain any references to past states**: no "it used to work this way but now it works
differently", no "added in version X", no "temporarily simplified", no "previous behavior is preserved", or any
similar historical notes. The history of changes lives in version control, not in the specification itself.

## New Functionality as the Only State

When new functionality is added, it must not be described as a "new feature" or a "change". Instead, find the
appropriate places in existing documents and insert it **as the only current state** — as if the system had always
been designed that way. If the new functionality affects multiple documents (overview, criteria, architecture, data
schema, prompts), all those places must be updated consistently so that the documentation remains coherent and
self-consistent.

## Independence from Delivery Channel

The specification describes only the programmatic interface of the AI bot and **is not tied to any specific delivery
channel or messenger**. Documents in `docs/ai-bot-with-memory/` must not treat Telegram (or any other specific
messenger) as the target: no messenger-specific command names, no descriptions of its menus, buttons, or click
handlers as mandatory requirements. The only permitted exception is to note that a given programmatic API feature
(for example, a proactivity toggle) **may** be exposed as a bot command or on-screen menu entry on top of any
messenger. The concrete implementation for the chosen channel is described outside this specification — in the
documentation of the project that consumes it.

## Portability of Documentation

The documentation in `docs/ai-bot-with-memory/` must be **portable**: it can be copied wholesale into another
project and used autonomously, without the rest of the repository. Therefore it must not contain links to
documentation of other parts of the project — to descriptions of specific delivery channels, reports, scripts, or
files outside this directory. Only cross-references between documents within `docs/ai-bot-with-memory/` itself are
permitted, and — to a limited extent — links to external sources on the internet (official specifications,
standards, model documentation). Any coupling to a specific project or its other parts is prohibited: if such a
connection is needed, it belongs in the consuming project's documentation, not here.

References to recommended code modules (e.g., `src/pipeline/proactive.js`) are not references to other parts of
the project's documentation — they are part of the portable implementation description and are permitted.
