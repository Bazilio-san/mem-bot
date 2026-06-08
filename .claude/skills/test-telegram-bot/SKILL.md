---
name: test-telegram-bot
description: >-
  Test the live Telegram bot (@tinter2_bot) end-to-end by driving Telegram Web with Playwright — sending real
  messages and watching the chat. Use when verifying streaming drafts, tool-call statuses, voice replies, or any
  behaviour that only shows up in the real bot, or when the user says "test the telegram bot", "проверь бота",
  "check streaming in telegram", or asks to drive the bot through the browser.
allowed-tools: Bash(node scripts/stop-telegram.js), Bash(node src/telegram.js)
---

# Testing the Telegram bot via Playwright

Drive the live bot in Telegram Web to verify end-to-end behaviour: streaming drafts, tool-call statuses, voice
replies, history, proactivity. The bot is `@tinter2_bot`; the web chat is `https://web.telegram.org/k/#@tinter2_bot`.
Playwright must run in persistent-cache mode so the Telegram login survives across runs.

## Step 1 — Reload the code first (critical)

The running `node src/telegram.js` process holds the OLD code in memory; your source edits do nothing until you
restart it. If you skip this, you will "test" the previous version and draw wrong conclusions.

1. Stop the bot gracefully: `node scripts/stop-telegram.js` (sends a soft SIGTERM, then force-kills survivors on
   Windows where background Node processes ignore the soft signal).
2. Start a fresh instance in the background: `node src/telegram.js`.
3. Wait for this line in its log before sending anything:
   `Telegram-бот @tinter2_bot запущен. Длинный опрос активен.`

Never run two instances against the same token — two long-polling clients collide with HTTP 409, and messages get
lost or duplicated. Always stop the old one before starting a new one.

## Step 2 — Open the chat

Navigate Playwright to `https://web.telegram.org/k/#@tinter2_bot`. If the QR-login screen appears
(`Log in by QR Code` / `Scan with Telegram app on your phone`), STOP and ask the user to scan it from their phone
(Settings → Devices → Link Desktop Device). Do not attempt to log in yourself. The cache is persistent, so once the
user logs in the session survives later runs.

## Step 3 — Send a message

The message box is a `contenteditable` div, NOT an `<input>`/`<textarea>` — calling `browser_type` on a snapshot
`ref` fails with "Element is not an <input>…". Two `.input-message-input` elements match (one is a fake overlay), so
target the real one by its peer attribute: `div.input-message-input[data-peer-id]`. Pass `submit: true` to press
Enter and send.

## Step 4 — Observe a streaming draft

To make streaming visible, send a prompt that forces a LONG answer, e.g.
"напиши длинный рассказ на пять абзацев про …". Then poll `browser_snapshot` on the chat container
`div.bubbles-inner.has-rights` every ~1.5–2 seconds.

Streaming is confirmed when a single bot bubble appears early and GROWS in place across snapshots:
an intermediate capture shows the text cut mid-word (for example ending "…а руч"), and a later capture shows the
SAME bubble (same timestamp) continued and much longer. If instead nothing appears for a long silence and then the
whole answer shows up at once as one finished bubble, the non-streaming delivery path ran — investigate the gating
(Step 5) rather than the streaming code.

Tip: large snapshots bloat context. Save them to a file with the `filename` option and read only the tail of that
file to inspect the last bubble, instead of dumping the whole bubble tree.

## Step 5 — Streaming gating rules

In `src/telegram.js` the streaming path activates only when BOTH streaming flags are on
(`config.streaming.enabled` and `config.streaming.telegramEnabled`) AND the user is not in voice mode. When
`VOICE_OUTPUT_ENABLED=on` globally, only users whose `reply_mode` is `text` get streaming — the bot reads the
per-user mode via `getUserReplyMode(externalId)` before calling the core, because voice replies need the whole final
text for synthesis and cannot be streamed as an editable draft.

So if streaming "does not work", check in order:
1. `.env`: `LLM_STREAMING_ENABLED` and `TELEGRAM_STREAMING_ENABLED` both truthy (`1/true/on/yes`).
2. The test user's `reply_mode`: a voice-mode user never streams. Switch that user back to text, or set
   `VOICE_OUTPUT_ENABLED=off`, and restart the bot.
3. The transport itself: run `npm run check:streaming` — if the proxy returns the answer in one chunk, no Telegram
   change will help.

## Step 6 — Clean up

If you started the bot as a session-owned background process, restart it in the user's own terminal afterwards (or
tell the user to), so it does not die when your session ends. Delete any snapshot artifacts written to the repo root
(`snap-*.md`) to keep the workspace clean.
