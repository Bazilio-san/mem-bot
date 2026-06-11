# Development

Testing commands and utility scripts for the project. The main `README.md` covers only the essential commands —
this document provides the full list of subsystem checks and helper scripts.

## Testing

The project uses Node.js's built-in test runner — no external frameworks are required. Tests run against a real
database and real models through the configured endpoint (API address), so the configuration must be populated
(`config/local.yaml` or environment variables) and migrations applied before running them.

```bash
npm test                 # multi-layer core check suite (DB schema, memory, privacy, dialogue)
npm run check:llm        # verify availability and response speed of the selected model
```

## Subsystem Tests

Each check can be run individually via its own npm script.

| Script | What it checks |
|--------|----------------|
| `npm run test:schema` | Database schema structure. |
| `npm run test:streaming` | Streaming response output. |
| `npm run test:progress` | Tool-call progress display. |
| `npm run test:reactions` | Bot reactions. |
| `npm run test:voice` | Voice input transcription. |
| `npm run test:voice-output` | Voice response synthesis. |
| `npm run test:voice-selector` | Voice selection logic. |
| `npm run test:channels` | Message delivery channels. |
| `npm run test:telegram-format` | Telegram message formatting. |
| `npm run test:progress-format` | Tool status formatting. |
| `npm run test:tts-strip` | Text sanitization before text-to-speech. |
| `npm run test:skills` | Skill loading and validation. |
| `npm run test:skill-authoring` | Skill authoring tooling. |

## Utility Scripts

| Script | Purpose |
|--------|---------|
| `npm run memory:dedupe` | Deduplicate memory entries. |
| `npm run delete:user` | Delete a user and all their associated data. |
| `npm run skills:list` | List all loaded skills. |
| `npm run skills:validate` | Validate skills and their schemas. |
| `npm run skills:sync` | Synchronize skills. |

## Source Code Layout

- `src/agent.js` — main response pipeline;
- `src/pipeline/` — processing stages (classification, retrieval, extraction, merging, protected memory,
  scheduler, proactivity);
- `src/telegram/` — Telegram channel;
- `src/voice/` — voice support (transcription `transcribe.js`, synthesis `tts.js`, voice list `voices.js`);
- `src/mcp/` — Model Context Protocol client;
- `src/schema/` — domain schemas;
- `migrations/` — database migrations.
