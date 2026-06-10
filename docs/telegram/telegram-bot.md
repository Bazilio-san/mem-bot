# Telegram Bot: Implementation on Top of the AI Bot

This documentation for the Telegram adapter is bound by the rules in
[00-documentation-principles.md](00-documentation-principles.md). This document covers only the Telegram integration
(bot `src/telegram/bot.js`, modules under `src/telegram/`) and how the AI bot's API is expressed in commands,
reactions, and channel formats.

## Startup and Transport

The Telegram adapter runs in either of two process modes, exposing the start and stop entry points
`startTelegram()` and `stopTelegram()` from `src/telegram/bot.js`. Standalone, it starts with `npm run telegram`
and is the sole occupant of the process. Co-hosted, it runs inside the combined web server (`npm run server`,
entry `src/server/index.js`), which on the very same Node.js process and event loop also serves the
administrative web interface and its JSON API under `/api`; the server brings the channel up by calling
`startTelegram()` after its HTTP listener is ready. Both services are I/O-bound and share one event loop without
interfering, because long polling and the background worker are asynchronous network operations rather than CPU
work. In both modes the token is taken from `config.telegram.apiKey`; without it the startup aborts. The web
server's own address and port come from `config.admin.host` and `config.admin.port` (defaults `localhost` and
`3001`). The adapter receives incoming updates via long polling (`getUpdates` with a 30-second timeout); replies and
proactive messages are sent via `sendMessage` with Telegram markup (`parse_mode=HTML`), splitting long text into
chunks of up to 4000 characters at tag boundaries to stay within Telegram's limit (see the "Response Markup"
section). For targeted reactions the bot uses `setMessageReaction`; if Telegram rejects a reaction in a particular
chat, the adapter sends a text fallback via `sendMessage`. Three update types are requested in the poll:
ordinary messages, inline-button taps, and message reactions:
`allowed_updates: ['message', 'callback_query', 'message_reaction']`.

The Telegram chat ID serves as the user's external identifier (`external_id` in the database). This is what allows
proactive messages from the delivery queue `mem.notification_outbox` to find the right chat. Messages from different
chats are processed in parallel; within a single chat they are processed strictly in order. The number of concurrent
heavyweight operations (model calls) is capped by a semaphore limited to `config.telegram.maxConcurrency`
(default 5). The delivery queue is drained on PostgreSQL events (`LISTEN`/`NOTIFY`), and a safety timer at interval
`config.telegram.outboxSafetyIntervalMs` (default 30000 ms) performs a sweep in case a notification was missed.
Outgoing Telegram `message_id` values are stored in `mem.message_external_refs` so that an incoming user reaction
can be matched to the corresponding internal history entry.

On a stop signal (`SIGINT` or `SIGTERM`) the process shuts down gracefully. The adapter's own stop routine
`stopTelegram()` halts the polling and background-worker loops, wakes the sleeping worker so it observes the stop
flag at once, releases the delivery-queue listener connection, and force-flushes the remaining journal buffers —
the model-call log and the agent-event log (`flushLlmLog`, `flushAgentEventLog`, see
`docs/ai-bot-with-memory/10-operations.md`, section [OPS-5]). Closing the database
connection pool belongs to whichever component owns the process: in standalone mode the adapter closes the pool
itself after stopping; in co-hosted mode the web server first stops accepting HTTP requests, then calls
`stopTelegram()`, and only then closes the shared pool, so the pool is closed exactly once.

## Response Markup

The response is delivered in Telegram markup: the bot formats text with the HTML subset that the Telegram Bot API
understands (`parse_mode=HTML`). So that the model formats its reply exactly this way, the adapter registers a
channel presentation profile under the key `telegram` at startup (via `registerChannelProfile` from
`src/pipeline/channels.js`). The profile carries a formatting instruction that the core injects into the system
prompt as a service block named `OUTPUT_FORMAT` (the profile mechanism is described in the AI bot spec,
`docs/ai-bot-with-memory/04-architecture.md`, section [ARCH-8]). The instruction permits only the tags Telegram
supports: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a>`, `<blockquote>`,
`<span class="tg-spoiler">`; headings, tables, and Markdown are forbidden, and bulleted lists are formatted as
lines starting with "• ". The channel key is passed in every core call: `handleMessage({ …, channel: 'telegram' })`.

Before sending, the text goes through two processing steps assembled in `src/telegram/format.js`. First, the
sanitizer (`telegramPostProcess`, a wrapper around the `sanitize-html` library) reduces the response to Telegram's
allowed tag whitelist: disallowed tags are escaped and shown as plain text, dangerous link schemes are dropped, and
bare `&`, `<`, and `>` characters in plain text are escaped for `parse_mode=HTML`. Then the splitter
(`telegramSplit`) cuts long text **at tag boundaries**: no chunk contains a broken tag, and markup that crosses a
split boundary is closed at the end of one chunk and reopened at the start of the next.

Delivery is protected by a fallback. Each chunk is sent via `sendMessage` with `parse_mode=HTML`; if Telegram still
rejects the markup (for example, the model returned malformed HTML that fails entity parsing with
`can't parse entities`), the same chunk is sent again as a last resort without `parse_mode`. This guarantees the
response reaches the user regardless, and the reason for the failure is written to the log.

## Incoming Audio Recognition

The bot understands not only text but also speech. If the user sends a voice message (`message.voice`), a video
note (`message.video_note`), an audio file (`message.audio`), a video file (`message.video`), or a document with
an audio or video MIME type (`message.document`), the adapter transcribes the speech and feeds the resulting text
into the normal agent pipeline exactly as if the user had typed the message. All substantive processing —
request classification, memory retrieval, tool calls, fact recording — remains unchanged; only the source of the
input text is different. Transcription is isolated in the module `src/voice/transcribe.js`; the Telegram adapter
calls it through an explicit contract and contains no details about individual transcription providers.

Transcription is enabled by the flag `config.voiceInput.enabled`. At startup the adapter also checks that an access
key is configured for the selected provider; if the key is missing or the provider is unknown, the subsystem stays
disabled, the reason is written to the log, and incoming audio is then ignored — just as when the flag is off. The
provider is selected via `config.voiceInput.provider` from five supported options; the default is
`groq-whisper-large-v3-turbo` (the fastest and cheapest based on testing):

| `config.voiceInput.provider` value    | Provider and model                       | Access key path                     |
|---------------------------------------|------------------------------------------|-------------------------------------|
| `groq-whisper-large-v3-turbo`         | Groq `whisper-large-v3-turbo`            | `config.providers.groqApiKey`       |
| `groq-whisper-large-v3`               | Groq `whisper-large-v3`                  | `config.providers.groqApiKey`       |
| `assemblyai-universal-2`              | AssemblyAI `universal-2`                 | `config.providers.assemblyaiApiKey` |
| `openai-gpt-4o-transcribe`            | proxy `openai/gpt-4o-transcribe`         | `config.llm.apiKey`                 |
| `openai-gpt-4o-mini-transcribe`       | proxy `openai/gpt-4o-mini-transcribe`    | `config.llm.apiKey`                 |

Transcription is performed in whole-file mode: the attachment is sent to the provider in a single request; no
external `ffmpeg` utility is needed. The file is downloaded to the bot's side (via `getFile` and then by the
Telegram file URL) and passed to the provider as a byte stream rather than a link: the direct file URL contains
the bot token and sharing it with a third-party service would be unsafe.

Before downloading, the adapter checks limits. The maximum supported duration is `config.voiceInput.maxSeconds`
(default 300 seconds, i.e. five minutes); longer recordings are rejected with a prompt to send a shorter one, and
the file is not downloaded. If Telegram does not report a duration (common for documents), the size limit
`config.voiceInput.maxBytes` (default 25 MB) applies instead. The language hint code is set via
`config.voiceInput.language` (default `ru`).

Whether the transcribed text is shown to the user depends on the attachment type. For voice messages and video
notes the transcribed text is not shown — this is live voice conversation, and the bot replies directly to the
content. For sent audio files, video files, and documents the bot first sends the transcribed text as a line such
as "Transcribed text: …" and then replies, so the user can see exactly what was recognized from the file. If no
speech was found in the recording (silence, music only, or a recording that is too quiet), the bot politely
reports this and does not call the model. During downloading and transcription, which takes noticeably longer than
text processing, the adapter maintains a "typing…" indicator by refreshing it periodically. The concurrency
semaphore slot is held for the entire heavy portion of a voice message — downloading, transcription, and the
subsequent agent call — so that multiple simultaneous voice messages do not overload the external transcription
services.

## Streaming Response Delivery

The adapter shows the response progressively as the model generates it. The AI bot core knows nothing about
Telegram for this purpose: it is invoked with `stream: true` and an abstract `onEvent` callback, and emits
processing-progress events (`assistant.delta`, `tool.started`, `tool.completed`, `assistant.completed`, and
others — their contract is described in the core spec, section [ARCH-7]). The Telegram adapter is simply one
consumer of these events: it turns them into concrete Bot API calls. All of this logic is assembled in the factory
`createTelegramProgress(chatId)` (module `src/telegram/progress.js`), which can be tested without a real Telegram
connection by substituting a fake API-call function.

The basic display model works as follows. Immediately after a message is received, a "typing…" indicator is started
via `sendChatAction` with action `typing`. This indicator is short-lived: Telegram extinguishes it after roughly
five seconds and on any message from the bot, so it is re-sent on a timer and serves only to fill the gap before
the first visible text rather than as the streaming mechanism itself. When the first response fragment arrives
(`assistant.delta`), the adapter creates a single draft message via `sendMessage` with the accumulated text so far
and stops the "typing…" indicator: the visible message itself shows progress. The adapter then edits that same
message via `editMessageText` with throttling — no more than once per `config.telegram.streaming.editIntervalMs`
(default 500 ms) and not until at least `config.telegram.streaming.minEditChars` new characters have accumulated
(default 20). The first visible draft is not created until `config.telegram.streaming.minFirstDraftChars` characters
have accumulated (default 50). At the end, a mandatory final edit with the full response text is performed.

Editing a message on every token is not feasible: it quickly hits Telegram's rate limits and clutters the chat
history. Therefore the stream is reduced to a single editable draft. Edit errors from Telegram are often normal —
for example, the text has not changed, or the message is no longer editable; such errors do not drop the response,
and the final text is still guaranteed to be delivered.

Markup is applied only to the final version. The intermediate draft is edited as plain text, without `parse_mode`:
an unclosed tag in incomplete text during incremental editing would break the display. Once the response is
complete, the final delivery converts it to Telegram markup — the text goes through the sanitizer and tag-boundary
splitter described in the "Response Markup" section, and the final draft edit and any remaining chunks are sent
with `parse_mode=HTML` and the same fallback to plain text on a markup parsing error.

Long responses. Telegram limits a message to roughly 4096 characters; the adapter keeps a safety margin of
`TG_MAX_LEN = 4000`. In streaming mode only the first segment up to this limit is edited; when the full response
is longer, the remainder is sent as ordinary `sendMessage` calls after completion, and the external `message_id`
values of all sent messages are stored in `mem.message_external_refs`.

Tool statuses. When the model calls a tool, the user sees a ready-made string from the `toolTitle` field of the
event, for example `Searching the knowledge base...`. This text is defined by the developer alongside the tool
itself; arguments, results, stack traces, and internal identifiers do not appear in the status. The adapter
maintains one status message per current operation: a `tool.started` event creates or updates it, and the
appearance of the first response fragment deletes it via `deleteMessage` so that the tool status does not mix with
the response text. If no response text arrives during processing (for example, the entire response comes after all
tool calls), the status is removed at the end. Multiple tools in a single turn are shown sequentially, in the
order they are called. Status display is disabled by the flag `config.telegram.streaming.toolStatuses`; the
"typing…" indicator is preserved in that case.

Enabling and boundary with voice. Streaming delivery works when both the core (`config.streaming.enabled`) and
Telegram (`config.telegram.streaming.enabled`) have streaming enabled. When `config.telegram.streaming.enabled`
is off, the adapter sends the "typing…" indicator and the final response in a single `sendMessage`, as in
non-streaming delivery. Reactions (`delivery.kind = 'reaction'`) do not go through the stream: they have no full
response text, so they still take the old path through `deliverAgentResult`. When voice output is enabled
(`config.voiceOutput.enabled`), text is not streamed — voice synthesis requires the complete final text, and
mixing an editable draft with sending a voice message would duplicate the response; in that case the voice
delivery path described below applies. For voice input, streaming progress works normally: while speech is being
transcribed the "typing…" indicator is shown, and once the agent pipeline begins, normal text streaming starts.

## Voice Response

The bot can respond not only in text but also in voice. The user chooses the response form in plain words: a phrase
like "reply in voice" enables voice responses, while "reply in text" or "stop the voice" switches back to text.
The intent is recognized by the model, which calls the core tool `voice_or_text` to save the user's preference;
details of how the preference is stored and persisted are described in the AI bot spec
(`docs/ai-bot-with-memory/06-memory.md`). The Telegram adapter reads the ready preference from the `replyMode`
field of the `handleMessage` result and decides how to deliver the response. The preference is a wish, not a
channel command: a response is delivered as voice only when the flag `config.voiceOutput.enabled` is on; otherwise
the adapter silently replies in text.

The user also chooses the voice timbre in plain words: "set the voice to onyx", "speak in nova", "I want a female
voice", "pick a male voice". The model calls the core tool `voice_set_preference`, and `handleMessage` returns the
chosen timbre in the field `voiceOutputVoice`. The supported voices are `alloy`, `ash`, `ballad`, `cedar`, `coral`,
`marin`, `nova`, `fable`, `onyx`, `sage`, `verse`; for male, female, and neutral selections deterministic defaults
are used. If the user names an unknown voice, the preference is not saved and the bot briefly lists the valid
options. If no timbre has been selected, the global `config.voiceOutput.voice` is used.

The delivery fork is consolidated in a single entry point `deliverAgentResult`. First the reaction branch is
checked: if the delivery layer chose `delivery.kind = 'reaction'` for a short reply, the adapter sets the reaction
as usual and speech synthesis is not triggered — reactions remain valid in voice mode. Substantive agent responses
in voice mode are synthesized; all other responses are sent as text.

Not every response is read aloud in full. A short response without code or lists is fully synthesized. If the
response exceeds the hard limit `config.voiceOutput.maxChars` (default and maximum: 500 characters) or contains
code blocks or multi-line lists, the bot builds a brief summary using an auxiliary fast model
(`config.voiceOutput.summaryModel`) and synthesizes that instead, while the full response is also sent as text so
nothing is lost. Nothing longer than the limit is ever passed to synthesis: the summary is additionally truncated
at a sentence boundary. If a usable summary cannot be prepared, the adapter falls back to text delivery.

Before synthesis, markup is stripped from the text. In voice mode the response arrives with the same markup as
the text response (Telegram tags), and reading tags and formatting characters aloud is not acceptable. Therefore
the text preparation for speech (`src/voice/tts.js`) removes HTML tags, restores escaped entities to normal
characters, and strips common Markdown characters, so that clean speech is passed to synthesis. The check for code
and list markers is done on the original marked-up response — the presence of markup is the signal to build a
summary, so markup removal happens after that check.

Speech synthesis is isolated in the module `src/voice/tts.js`: it receives text and returns the bytes of a voice
message in OGG/OPUS format, hiding the choice of provider and model. Synthesis is done through the `audio/speech`
endpoint of the selected OpenAI-compatible endpoint: `config.llm.baseURL` if a proxy is needed, or the direct
OpenAI API if no value is set (model `config.voiceOutput.model`, global timbre `config.voiceOutput.voice`,
format `config.voiceOutput.format`). The per-user `voiceOutputVoice` is passed in the `audio/speech` request if
selected, otherwise the global timbre is used. No separate access key is required. Some proxies periodically
close the connection on timeout, so the synthesis request is retried several times. The speech language is not
specified: it adapts to the language of the response automatically, because the response text itself is
synthesized.

The finished audio is sent via `sendVoice`. Unlike the text `sendMessage`, this is a file upload
(`multipart/form-data`) rather than a JSON request, so the body is assembled via `FormData`. The OGG/OPUS format
is shown by Telegram as the familiar voice "blob" with a waveform and playback speed control; no re-encoding is
needed. During synthesis the adapter shows the action indicator `record_voice` ("recording a voice message…") so
the wait looks meaningful. After a successful send, the external `message_id` of the voice message is stored in
`mem.message_external_refs` with kind `voice`, just as for text responses. On any synthesis failure the response
is not lost: the reason is written to the log and the same response is sent to the user as text.

## Bot Commands

Telegram command names allow only lowercase Latin letters, digits, and underscores, so proactivity-control
commands use underscores (`proactivity_on`) rather than hyphens.

| Command | Purpose | AI bot programmatic API function |
|---------|---------|----------------------------------|
| `/start`, `/help` | greeting and help; the list of proactivity commands is shown only when `config.proactive.enabled` is on | — |
| `/domain <key>` | change the conversation domain for the chat (stored in process memory) | — |
| `/proactivity_on` | enable proactivity for the user and create a disabled set of triggers | `setUserProactivity(externalId, true)` |
| `/proactivity_off` | disable proactivity for the user | `setUserProactivity(externalId, false)` |
| `/proactivity` | open the on-screen trigger-selection submenu | `getProactivityState(externalId)`, `setTrigger(...)` |

The global memory commands (`/fact-add`, `/fact-list`, `/fact-del`, `/kb-add`, `/kb-find`, `/kb-del`) are not
implemented in the Telegram adapter; they are available in the reference interactive CLI (`src/cli.js`).

## Proactivity Management

The management mirrors the two-level model from the spec (`docs/ai-bot-with-memory/09-proactivity.md`): the global
flag `config.proactive.enabled`, the user master flag `mem.users.proactivity_enabled`, and the per-trigger flag
`enabled`.

- `/proactivity_on` calls `setUserProactivity(externalId, true)`. The function enables the master flag and
  idempotently creates the trigger set, all disabled. The bot reports that no triggers are active yet and
  suggests opening `/proactivity`.
- `/proactivity_off` calls `setUserProactivity(externalId, false)` — the master flag is disabled and the bot
  stops messaging first.
- `/proactivity` reads the state via `getProactivityState(externalId)`. If proactivity is disabled for the user,
  the bot suggests running `/proactivity_on` first; otherwise it shows the inline trigger submenu.

If proactivity is disabled globally (`config.proactive.enabled` is off), the enable commands respond that enabling
is not possible.

## Message Reactions

For short replies where a reaction is the natural response, the adapter passes the text to `decideDeliveryIntent`
with the channel capabilities `supportsReactions = true` and the key set `like`, `okay`, `heart`, `laugh`,
`fire`, `smile`, `100`, `sad`. If the delivery layer chooses `delivery.kind = 'reaction'`, the adapter records
the conversation turn via `recordReactionTurn` and attempts to set a reaction on the user's original message via
`setMessageReaction`.

The entire Telegram emoji mapping is assembled in a single adapter module `src/telegram/reactions.js` — both the
forward mapping from a canonical key to the emoji for sending and the reverse mapping from an incoming emoji to
its canonical key. The core (`src/pipeline/reactions.js`) knows nothing about Telegram emojis. The forward
mapping from key to emoji for outgoing reactions:

| Key | Telegram emoji |
|-----|----------------|
| `like` | `👍` |
| `okay` | `👌` |
| `heart` | `❤` |
| `laugh` | `😁` |
| `fire` | `🔥` |
| `smile` | `😊` |
| `100` | `💯` |
| `sad` | `😢` |

If Telegram returns an error from `setMessageReaction` (for example, reactions are not available in the chat),
the adapter sends the `fallbackText` as an ordinary message and links the sent message to the internal assistant
turn via `mem.message_external_refs`. If the delivery layer chooses `text_needed`, the adapter calls the normal
`handleMessage`.

Incoming user reactions arrive as `message_reaction` updates. The adapter normalizes the first element of
`new_reaction` to a canonical key using `normalizeTelegramReaction` from the same module
`src/telegram/reactions.js`, looks up the target message by `(channel = 'telegram', chat_id, message_id)` in
`mem.message_external_refs`, and calls `recordUserReaction`. A separate user turn of the form "User reacted
:heart: to the assistant's message: …" appears in the history. If a reaction is removed, the event is also
saved in history but does not trigger memory recording. If the target assistant message is found and the meaning
of the reaction is unambiguous, the common memory-extraction pipeline may save a persistent fact.

## Dynamic Command Menu

The set of commands visible in the chat (the "Menu" button and hints shown when typing "/") is recalculated for
the user's current state via `setMyCommands` scoped to the specific chat
(`scope: { type: 'chat', chat_id }`). The logic for building the set:

- proactivity is disabled globally — only the base commands (`/start`, `/help`, `/domain`);
- globally enabled, user master flag disabled — base commands plus `/proactivity_on`;
- globally enabled, master flag enabled — base commands plus `/proactivity_off` and `/proactivity`.

The menu is recalculated after every ordinary message (because the master flag could have changed) and immediately
after any toggle. At startup the bot registers a global command set as a fallback for chats without their own
menu: the base commands plus `/proactivity_on` if proactivity is enabled globally.

## Inline Trigger Submenu

The `/proactivity` submenu is an inline keyboard: one button per trigger and a separate button to disable all
proactivity. Each trigger shows a state indicator: `✅` for enabled and `⬜` for disabled. Users see descriptive
labels while the technical trigger keys remain in the database and in the tap payload:

| Trigger key | Label in submenu |
|-------------|-----------------|
| `inactivity` | Inactivity |
| `daily_checkin` | Daily check-in |
| `goal_reminder` | Goal reminder |
| `welcome_back` | Welcome back |

The tap payload (`callback_data`) uses short codes that comfortably fit within Telegram's 64-byte limit:
`pa:t:<type>` toggles a single trigger (for example, `pa:t:inactivity`), and `pa:off` disables the master flag.

Taps arrive as `callback_query` updates and are handled immediately, without calling the model. The handler
confirms the tap via `answerCallbackQuery` (a brief pop-up notification with the result) and redraws the UI:

- `pa:t:<type>` reads the current state via `getProactivityState`, toggles the trigger with
  `setTrigger(externalId, triggerType, enabled)`, and updates the keyboard via `editMessageReplyMarkup` with the
  new indicators;
- `pa:off` calls `setUserProactivity(externalId, false)`, updates the chat menu, and replaces the message text
  via `editMessageText` with a hint that proactivity has been disabled.

## Command-to-API Function Mapping

The adapter contains no proactivity business logic of its own — it merely maps user actions to the AI bot's
programmatic API functions from `src/repo.js` (`setUserProactivity`, `getProactivityState`, `setTrigger`,
`ensureDefaultTriggers`, `listUsersWithTriggers`). Any other channel (a web interface, another messenger) can
map the same functions to its own commands and menus without changing the bot core.
