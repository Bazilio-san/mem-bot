# CLAUDE.md

## Editing files in `.claude/` (Skill /edit-claude-files)

Any edit or new file under `.claude/**` (SKILL.md, scripts, hooks, agents, `settings.json`) is blocked
by `settings.json` — direct `Write`/`Edit` will fail. Invoke the `/edit-claude-files` skill, which
describes the required `scripts/fcp.js` temp-copy protocol.

## Language in code

All code comments, `console.*` / logger calls, and `throw new Error(...)` messages must be written in **English**.

Keep Russian for strings that are user-facing at runtime: Telegram bot replies, admin web UI error responses, LLM system/user
prompts, tool descriptions and result strings passed to the model, tool `title` fields shown as Telegram progress statuses,
and test fixtures (seed data, sample user messages, expected values).

## Formatting

MD lines ≤120 chars. Break at 120. Target 100-120. No short lines (60-80). Fill to ~120.
Exceptions: URLs, code blocks, tables — no wrap.

## Strings (JS)

Never build a string with `+` concatenation. Whenever a string would overflow the 120-column limit and needs to span
several source lines, write it as a single multi-line template literal (backticks) instead of joining `'…' + '…' +`
fragments. Use `${expr}` interpolation rather than `'…' + value` to splice values in. Short single-line strings that
fit within 120 columns stay as plain quotes. For user-facing text where the exact spacing matters (no stray line
breaks), keep the wording on one logical line inside the backticks even if that line is long — the formatter leaves
template-literal contents untouched, which is exactly why they replace `+` wrapping.

## AssemblyAI

Always fetch https://www.assemblyai.com/docs/llms.txt before writing AssemblyAI code.
The API has changed — do not rely on memorized parameter names.

## Removing test users after a test run

Tests create users flagged with `mem.users.is_test = true` (set automatically by `ensureUser` when
`NODE_ENV === 'test'`). They are NOT cleaned up automatically. 
When I say "после прогона тестов удалить тестовых пользователей" or "удали тестовых пользователей" (or any equivalent request to delete test users), run
`node scripts/delete-user.js --test-users --yes`, which deletes every user with `is_test = true` and all their
cascaded data without an interactive prompt.

## Updating documentation

When I say "скорректируй документацию", "актуализируй доку", "отрази в документации" (or any equivalent request to
update the docs), reflect the changes in BOTH documentation sets:

- `docs/ai-bot-with-memory/` — following the principles in `docs/ai-bot-with-memory/00-documentation-principles.md`.
- `docs/telegram/telegram-bot.md` — following the principles in `docs/telegram/00-documentation-principles.md`.

Read the relevant `00-documentation-principles.md` first and apply its rules to whatever you write.

## Testing the Telegram bot via Playwright

When you need to drive the live bot in Telegram Web — verifying streaming drafts, tool statuses, voice replies, or
any end-to-end behaviour by actually sending messages and watching the chat — use the `/test-telegram-bot` skill. It
holds the full procedure: restart the bot to load new code, open the chat, the `contenteditable` input selector, how
to observe a streaming draft, and the streaming gating rules.
