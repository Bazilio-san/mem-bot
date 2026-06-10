---
name: test-telegram-bot
description: >-
  Test the live Telegram bot (@tinter2_bot) end-to-end by driving Telegram Web with Playwright — sending real
  messages and watching the chat. Use when verifying streaming drafts, tool-call statuses, voice replies, or any
  behaviour that only shows up in the real bot, or when the user says "test the telegram bot", "проверь бота",
  "check streaming in telegram", or asks to drive the bot through the browser.
allowed-tools: Bash(node .claude/skills/test-telegram-bot/scripts/ensure.js), Bash(node .claude/skills/test-telegram-bot/scripts/driver.js), Bash(node .claude/skills/test-telegram-bot/scripts/tg.js:*), Bash(node .claude/skills/test-telegram-bot/scripts/generate-voice-sample.js:*), Bash(node .claude/skills/test-telegram-bot/scripts/make-sample-audio.js:*), Bash(node scripts/stop-telegram.js), Bash(node src/telegram/bot.js)
---

# Testing the Telegram bot via Playwright

Drive the live bot in Telegram Web to verify end-to-end behaviour: streaming drafts, tool-call statuses, voice
replies, history, proactivity. The bot is `@tinter2_bot` (read the real name from config `telegram.botUsername`); the
web chat is `https://web.telegram.org/k/#@tinter2_bot`.

## How this harness works

This skill does NOT use the Playwright MCP server. It uses Playwright installed as a project dev-dependency, driven by
scripts that live WITH the skill in `.claude/skills/test-telegram-bot/scripts/` (they are useful only for this test, so
they are kept here rather than in the project `scripts/` directory):

- `ensure.js` — checks that Playwright and the Chromium binary are installed; installs them if missing.
- `driver.js` — a long-running daemon that opens ONE headful Chromium with a persistent profile and exposes a tiny
  localhost HTTP command API. It is started once in the background and stays open between your Bash calls.
- `tg.js` — a thin CLI client that sends one command to the daemon and prints the JSON result.
- `generate-voice-sample.js` / `make-sample-audio.js` — produce the voice sample WAV (real speech via TTS, or a
  synthetic tone fallback). See Step 0.

Because the scripts sit four levels below the project root, always run them with the full path from the project root,
for example `node .claude/skills/test-telegram-bot/scripts/tg.js status`.

Why a daemon? A persistent browser profile can be held by only one process at a time, and you drive the bot across many
separate Bash calls. The daemon keeps the same page alive between calls, which is also the only way to watch a streaming
draft grow in place.

The browser runs HEADFUL (visible window) with its persistent profile in `.browser-session/` at the project root (this
folder is in `.gitignore`). Because the profile is on disk, the Telegram login survives across runs — the QR screen
should appear only on the very first run or after the user unlinks the device. Chromium is launched with fake-media
flags so a WAV file stands in for the microphone, which lets the harness send a real voice message without a live mic.

Default command port is `39517` (override with the `TG_PW_PORT` environment variable).

## Speed — how long each action takes

These were measured on this machine with the user already logged in. The point of the daemon design is that the slow
part (launching Chromium) happens ONCE; everything after it is fast. Keep one driver running for the whole test session
and never relaunch it per action.

| Action                          | Typical time | Notes                                                            |
|---------------------------------|--------------|------------------------------------------------------------------|
| `driver.js` cold start          | ~2.5 s       | one-time: Chromium launch + Telegram Web load (the "slow" part)  |
| `status` / `last` / `goto`      | ~0.15–0.3 s  | mostly the cost of spawning `node`, not Playwright               |
| `send` (text)                   | ~0.25 s      | returns immediately; the bot's own reply takes longer, separately |
| `shot`                          | ~0.3 s       | screenshot to `.browser-session/shots/`                          |
| `voice N`                       | ~N + 3 s     | the N-second recording plus a fixed gesture/send overhead        |

Two practical consequences. First, most per-command latency is Node.js process startup (~150 ms), not the browser —
if you need to poll fast (e.g. watching a streaming draft), the numbers above are the floor. Second, NEVER stop and
restart the driver between steps: that pays the ~2.5 s cold start again. Launch it once at the start (Step 2) and only
`stop` it at the very end (Step 9). The bot's answer latency (several LLM passes, often tens of seconds) is separate
from these harness numbers — do not count it as harness slowness.

## Step 0 — Make sure Playwright is installed

Run the dependency gate and read its LAST output line:

```bash
node .claude/skills/test-telegram-bot/scripts/ensure.js
```

- `PLAYWRIGHT_OK` or `PLAYWRIGHT_INSTALLED` (exit 0) — good, continue.
- `NEED_CLAUDE: <reason>` (exit 2) — automatic install failed; YOU must finish it intelligently. Typically run
  `npm install -D playwright` then `node_modules/.bin/playwright install chromium`, diagnosing whatever the reason
  line reported (proxy, disk, permissions), then re-run `ensure.js`.

The voice sample WAV lives at `.claude/skills/test-telegram-bot/assets/voice-sample.wav` and is committed. It is REAL
speech, synthesized from text with the project's text-to-speech provider. To regenerate it (or change what it says):

```bash
node .claude/skills/test-telegram-bot/scripts/generate-voice-sample.js "Текст для озвучивания"
```

That calls the OpenAI-compatible `audio/speech` endpoint (model `gpt-4o-mini-tts`, voice `ash`) and writes a 24 kHz,
mono, 16-bit PCM WAV — a format Chromium's fake-audio capture accepts. There is also `make-sample-audio.js`, which
writes a synthetic tone (no network needed) as a last-resort fallback when the TTS provider is unreachable.

## Step 1 — Reload the bot code first (critical)

The running `node src/telegram/bot.js` process holds the OLD code in memory; your source edits do nothing until you
restart it. If you skip this, you will "test" the previous version and draw wrong conclusions.

1. Stop the bot gracefully: `node scripts/stop-telegram.js` (soft SIGTERM, then force-kills survivors on Windows where
   background Node processes ignore the soft signal).
2. Start a fresh instance in the background: `node src/telegram/bot.js`.
3. Wait for this line in its log before sending anything:
   `Telegram bot @tinter2_bot started. Long polling is active.`

Never run two instances against the same token — two long-polling clients collide with HTTP 409, and messages get lost
or duplicated. Always stop the old one before starting a new one.

## Step 2 — Launch the browser driver (background)

Start the daemon as a background process and wait a few seconds for it to open Chromium and load Telegram Web:

```bash
node .claude/skills/test-telegram-bot/scripts/driver.js   # run in the background
```

Wait for its log line `Ready. Peer @<bot>. Command API on http://127.0.0.1:39517`, then confirm it answers:

```bash
node .claude/skills/test-telegram-bot/scripts/tg.js status
```

If `tg.js` reports "driver not reachable", the daemon is not up yet (give it more time) or another instance already
holds the profile — stop the old one with `node .claude/skills/test-telegram-bot/scripts/tg.js stop` and relaunch.

## Step 3 — Handle login (QR)

Check the screen state:

```bash
node .claude/skills/test-telegram-bot/scripts/tg.js status
# -> { authScreen, qrVisible, loggedIn, chatOpen, url }
```

How the harness detects login state (fast, no polling of pixels): Telegram Web "K" puts the class `has-auth-pages` on
`<body>` for ANY login screen and removes it once authenticated. So `loggedIn` is simply the ABSENCE of that class. The
QR variant additionally renders a `<canvas>` and the copy "Log in by QR Code"; `qrVisible` is true when the auth screen,
that text, and a canvas are all present.

If `qrVisible` is true: STOP and tell the user plainly that login is required — ask them to scan the QR in the already
open Chromium window from their phone (Settings → Devices → Link Desktop Device) and to reply here once they are logged
in. Do NOT try to log in yourself. Then WAIT for the user's confirmation message; do not proceed on your own. After they
confirm (or immediately, if there was no QR and `loggedIn` was already true), re-check `status` and continue.

## Step 4 — Open the bot chat

```bash
node .claude/skills/test-telegram-bot/scripts/tg.js goto            # opens the configured telegram.botUsername
node .claude/skills/test-telegram-bot/scripts/tg.js goto some_other # or open a different peer by username
```

`goto` sets the SPA URL hash to `#@<peer>` and waits for that peer's message box to mount. The reported `chatOpen: true`
means the message input `div.input-message-input[data-peer-id]` is present.

## Step 5 — Send a text message and read replies

```bash
node .claude/skills/test-telegram-bot/scripts/tg.js send "Ответь ровно одним словом: ок"
node .claude/skills/test-telegram-bot/scripts/tg.js last 3
```

`send` clicks the real message box (a `contenteditable` div, not an `<input>`), types via keyboard `insertText`, and
presses Enter. `last N` returns the last N message bubbles as objects:

```jsonc
{ "mid": "543", "out": true,  "voice": false, "voiceDuration": null, "text": "Ответь ровно одним словом: ок" }
{ "mid": "545", "out": false, "voice": false, "voiceDuration": null, "text": "Понял." }
```

- `out: true` — outgoing (sent by us); `out: false` — the bot's message.
- `text` has the trailing timestamp and reactions stripped out, so it is the clean message body.
- To wait for a reply, poll `last 1` every ~3 s until a NEW bubble with `out: false` and a `mid` higher than your sent
  message appears. The bot can take tens of seconds (it runs several LLM passes), so be patient and watch its log.

## Step 6 — Observe a streaming draft

To make streaming visible, send a prompt that forces a LONG answer, e.g. "напиши длинный рассказ на пять абзацев
про …". Then poll `node .claude/skills/test-telegram-bot/scripts/tg.js last 1` every ~1.5–2 s.

Streaming is confirmed when a single bot bubble (`out: false`) appears early and its `text` GROWS in place across polls:
one poll shows it cut off mid-sentence, a later poll shows the SAME `mid` much longer. If instead nothing appears for a
long silence and then the whole answer shows up at once as one finished bubble, the non-streaming delivery path ran —
investigate the gating (Step 8) rather than the streaming code.

## Step 7 — Send and receive voice

Send a voice message (uses the fake-audio WAV as the microphone):

```bash
node .claude/skills/test-telegram-bot/scripts/tg.js voice 3   # record ~3 seconds and send
node .claude/skills/test-telegram-bot/scripts/tg.js last 2
```

A successful send shows a bubble with `out: true, voice: true, voiceDuration: "0:03"`. Reading the bot's voice REPLY
works the same way — a `voice: true` bubble with `out: false`.

How the voice send works (worked out live against Telegram Web "K"): the main circular button is `.btn-send.record`
while the input is empty. A short TAP on it latches a LOCKED recording (the button switches to `.btn-send.send`, a
cancel control appears, and an mm:ss timer starts running in the input row). The harness then waits the requested number
of seconds and clicks the now-checkmark `.btn-send` to dispatch the recording. The harness also keeps a press-and-hold
fallback for builds that send on release. The fake microphone is confirmed working when Chromium reports an audio track
labelled "Fake Default Audio Input" (check `curl http://127.0.0.1:39517/mic`).

Reliability: a single `voice` call is enough — no retry or double-click is needed. A 5-trial run sent the voice every
time and the bot replied within 6–12 s on each. The message box must be EMPTY before recording, though: a non-empty box
turns the button into text-send instead of record.

One detail you will see in `last` right after sending: the fresh voice bubble has a FRACTIONAL mid such as `561.0001`.
That is Telegram's optimistic placeholder while the message uploads; it resolves to a normal integer mid within about a
second. When you compare mids (e.g. to detect the bot's reply), floor them to integers — do not do integer math on the
raw `561.0001` string, or the comparison silently fails.

Speech-to-text content: the committed `voice-sample.wav` is real spoken Russian, so the bot's recognizer transcribes
it and acts on it. The default sentence asks the bot to set a reminder; a confirmed end-to-end run produced the voice
bubble and then the bot reply "Готово — напомню завтра в 10:00 позвонить маме." To test a different phrase, regenerate
the WAV with `node .claude/skills/test-telegram-bot/scripts/generate-voice-sample.js "новый текст"` and relaunch the driver. Record for a
little longer than the clip's length (it is ~11 s) so the whole sentence is captured — Chromium loops the file.

## Step 8 — Streaming gating rules

In `src/telegram/bot.js` the streaming path activates only when BOTH streaming flags are on
(`config.streaming.enabled` and `config.streaming.telegramEnabled`) AND the user is not in voice mode. When
`VOICE_OUTPUT_ENABLED=on` globally, only users whose `reply_mode` is `text` get streaming — the bot reads the per-user
mode via `getUserReplyMode(externalId)` before calling the core, because voice replies need the whole final text for
synthesis and cannot be streamed as an editable draft.

So if streaming "does not work", check in order:
1. `.env`: `LLM_STREAMING_ENABLED` and `TELEGRAM_STREAMING_ENABLED` both truthy (`1/true/on/yes`).
2. The test user's `reply_mode`: a voice-mode user never streams. Switch that user back to text, or set
   `VOICE_OUTPUT_ENABLED=off`, and restart the bot.
3. The transport itself: run `npm run check:streaming` — if the proxy returns the answer in one chunk, no Telegram
   change will help.

## Command cheatsheet (`node .claude/skills/test-telegram-bot/scripts/tg.js <cmd>`)

| Command          | Effect                                                                            |
|------------------|-----------------------------------------------------------------------------------|
| `status`         | screen state `{authScreen, qrVisible, loggedIn, chatOpen, url}`                    |
| `goto [peer]`    | open a peer (default: configured bot); waits for the message box                  |
| `send "<text>"`  | type the text into the message box and send it                                    |
| `last [n]`       | last N bubbles `{mid, out, voice, voiceDuration, text}` (default 3)               |
| `voice [sec]`    | record + send a voice message from the fake-audio WAV (default 3 s)              |
| `shot [name]`    | save a screenshot to `.browser-session/shots/<name>.png`                          |
| `debug`          | raw DOM probe (selector counts, button classes) for refining selectors           |
| `stop`           | shut the driver and browser down                                                  |

There is also a `GET /mic` HTTP route on the driver (`curl http://127.0.0.1:39517/mic`) that reports whether the fake
microphone returns a live audio track — useful when a voice send silently fails.

## Verified selectors (Telegram Web "K")

These were confirmed live; keep them in `driver.js` (`SEL` map) up to date if Telegram changes its markup.

- Login screen (any kind): `document.body.classList.contains('has-auth-pages')`.
- QR specifically: above + body text matches `/Log in by QR|Scan with Telegram|QR Code/` + a `<canvas>` exists.
- Message input: `div.input-message-input[data-peer-id]` (two `.input-message-input` exist; the real one has the peer
  attribute).
- Message bubbles: `.bubble[data-mid]`; outgoing carries `.is-out`; text in `.message` (strip the inner `.time` and
  `.reactions`); voice messages contain `.audio` with the duration in `.audio-time`.
- Record/send button: `.btn-send` — it carries `.record` while the input is empty and `.send` while recording or when
  there is text to send.

## Step 9 — Clean up

- Stop the driver with `node .claude/skills/test-telegram-bot/scripts/tg.js stop` when finished. The login stays
  in `.browser-session/`, so the next run reuses it without a new QR scan.
- If you started the bot as a session-owned background process, restart it in the user's terminal afterwards (or tell
  the user to), so it does not die when your session ends.
- Screenshots accumulate under `.browser-session/shots/` (gitignored); clear that folder if it grows large.
