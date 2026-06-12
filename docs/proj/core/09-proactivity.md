# 09. Proactivity and Companion Mode

Proactivity lets the bot write first when there is a useful reason and the contact policy allows it. Companion mode
keeps topic and temporal state fresh enough for the bot to notice unfinished threads.

## Conceptual Layers

- **Topic tracking:** extracts and refreshes topics from normal dialogue.
- **Triggers:** inactivity, daily check-in, goal reminders, welcome-back moments, and external events create candidates.
- **Contact policy:** rate limits soft contact and quiets down after ignored proactive messages.
- **Message generation:** builds a short, context-aware first message for an allowed candidate.
- **Delivery:** adapters send the message through their channel outbox.

## Code Owners

- Trigger checks and firing: `../../../src/pipeline/proactive.js`
- Contact policy: `../../../src/pipeline/proactiveContactPolicy.js`
- Proactive message generation: `../../../src/pipeline/proactiveMessage.js`
- External event processing: `../../../src/pipeline/events.js`
- Topic persistence helpers: `../../../src/repo.js`
- Scheduler and worker loop: `../../../src/scheduler-run.js`
- Telegram outbox delivery: `../../../src/telegram/bot.js`
- Configuration defaults: `../../../config/default.yaml`
- Schema: `../../../migrations/001_init.sql`

## Boundary

This document describes channel-independent behavior. Telegram commands and inline controls for enabling or disabling
proactivity are documented in [../telegram/telegram-bot.md](../telegram/telegram-bot.md).
