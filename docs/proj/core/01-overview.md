# 01. Core Overview

The project is an agentic chatbot with persistent user memory, compressed conversation history, scheduled reminders,
proactive contact, shared knowledge, voice support, image generation, and editable domain skills.

The core is channel-independent. Telegram and the admin UI are adapters around the same agent and storage layers.

## Processing Loops

The system has three loops:

- **Reactive loop:** an inbound user message is classified, enriched with context, answered by the model, persisted, and
  followed by memory extraction.
- **Maintenance loop:** background tasks run reminders, proactivity, embedding repair, log retention, and cleanup.
- **Operator loop:** admins inspect memory, logs, shared knowledge, and user state through the web UI.

Primary code owners:

- Agent orchestration: `../../../src/agent.js`
- Database access and conversation persistence: `../../../src/repo.js`
- LLM provider wrapper: `../../../src/llm.js`
- Scheduler worker: `../../../src/scheduler-run.js`
- Combined web server: `../../../src/server/index.js`
- Telegram adapter: `../../../src/telegram/bot.js`

## Context Layers

Each model turn receives a layered context assembled from recent messages, compressed history, personal memory, global
facts, shared knowledge, capabilities, and channel presentation rules. The intent is to keep the prompt useful without
letting any one layer become the entire state of the application.

The assembly points are:

- Recent conversation and summary context: `../../../src/pipeline/history-context.js`
- Personal memory retrieval and formatting: `../../../src/pipeline/retrieve.js`
- Global facts and shared knowledge: `../../../src/pipeline/global-memory.js`
- Channel profile and formatting: `../../../src/pipeline/channels.js`
- Tool registry and capability context: `../../../src/pipeline/tools.js`

## Configuration

Runtime behavior is controlled by `../../../config/default.yaml` plus environment-specific overrides. Environment
variable mappings live in `../../../config/custom-environment-variables.yaml`. The documentation names the conceptual
switches; the exact defaults belong to those configuration files.
