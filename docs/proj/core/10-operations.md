# 10. Operations: Scheduler, Tools, Logging, and Tests

Operational behavior is implemented in scripts, entry points, and tests. This document maps the concepts to their code
owners.

## Scheduler and Background Work

The scheduler stores user tasks, computes due times, claims work safely, records task runs, and sends notifications
through the channel outbox. It also supports recurring schedules through cron and RRULE helpers.

Code owners:

- Scheduler logic: `../../../src/pipeline/scheduler.js`
- Worker process: `../../../src/scheduler-run.js`
- Telegram outbox drain: `../../../src/telegram/bot.js`
- Schema: `../../../migrations/001_init.sql`

## Agent Tools

Tools are registered centrally and exposed to the model according to feature flags, active skill, and admin status.
Definitions live in `../../../src/pipeline/agent-tools/`; registry composition lives in
`../../../src/pipeline/tools.js` and `../../../src/pipeline/agent-tools/index.js`.

External MCP tools are loaded through `../../../src/mcp/config.js` and `../../../src/mcp/client.js`.

## Logging

The project logs LLM requests, usage costs, and agent events to the logs database. The admin UI reads those logs and can
stream analysis output for a selected request.

Code owners:

- LLM request and usage logs: `../../../src/pipeline/llm-log.js`
- Agent events: `../../../src/pipeline/agent-event-log.js`
- Batched writes: `../../../src/pipeline/log-writer.js`
- Retention: `../../../src/pipeline/log-retention.js`
- Admin log API: `../../../src/server/llm-log-data.js`, `../../../src/server/log-analysis.js`

## Tests

The script index is `../../../package.json`. The broad end-to-end behavioral suite is `../../../tests/run.js`; focused
unit and integration tests live in `../../../tests/*.test.mjs`. Keep exact scenarios in tests, not in this document.
