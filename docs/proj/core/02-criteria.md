# 02. Readiness Criteria

Readiness is defined by behavior, not by duplicated acceptance-test text in documentation. The core criteria are:

- A user can have a persistent, long-running conversation with durable memory.
- Memory retrieval is scoped, ranked, deduplicated, and small enough for the prompt budget.
- The bot can forget, pin, protect, and expire facts according to user intent and privacy rules.
- Old dialogue is compressed without losing active state or reintroducing stored facts as fresh facts.
- Reminders, recurring tasks, proactive messages, and external-event prompts are rate-limited and recoverable.
- Shared global facts and knowledge can help all users while admin-only mutations remain protected.
- Tool execution, LLM calls, agent events, and delivery surfaces are observable through logs and tests.
- Telegram, admin UI, and notes widgets are adapters over the same core state, not separate business engines.

The executable criteria are the tests:

- Broad behavioral suite: `../../../tests/run.js`
- Focused suites: `../../../tests/*.test.mjs`
- Memory fixtures: `../../../tests/memory_cases.json`
- Test commands: `../../../package.json`

The implementation status snapshot is [../../implementation-status.md](../../implementation-status.md).
