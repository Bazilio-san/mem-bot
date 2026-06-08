# CLAUDE.md

## Editing files in `.claude/` (Skill /edit-claude-files)

Any edit or new file under `.claude/**` (SKILL.md, scripts, hooks, agents, `settings.json`) is blocked
by `settings.json` — direct `Write`/`Edit` will fail. Invoke the `/edit-claude-files` skill, which
describes the required `scripts/fcp.js` temp-copy protocol.

## Formatting

MD lines ≤120 chars. Break at 120. Target 100-120. No short lines (60-80). Fill to ~120.
Exceptions: URLs, code blocks, tables — no wrap.

## AssemblyAI

Always fetch https://www.assemblyai.com/docs/llms.txt before writing AssemblyAI code.
The API has changed — do not rely on memorized parameter names.

## Testing the Telegram bot via Playwright

When you need to drive the live bot in Telegram Web — verifying streaming drafts, tool statuses, voice replies, or
any end-to-end behaviour by actually sending messages and watching the chat — use the `/test-telegram-bot` skill. It
holds the full procedure: restart the bot to load new code, open the chat, the `contenteditable` input selector, how
to observe a streaming draft, and the streaming gating rules.
