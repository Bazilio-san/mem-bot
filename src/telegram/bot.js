// Telegram adapter: connects the chat bot with long-term memory to the Telegram Bot API.
// Incoming messages are received via long polling (the getUpdates method),
// while agent answers and proactive messages go to the user via the sendMessage method.
// The user's external identifier (external_id) is the Telegram chat id —
// thanks to this, proactive messages from the delivery queue find the right chat.
// Run: npm run telegram
import { config, requireConfig } from '../config.js';
import { pathToFileURL } from 'node:url';
import { handleMessage, recordReactionTurn, recordUserReaction } from '../agent.js';
import { tick, msUntilDueTask } from '../pipeline/scheduler.js';
import { checkProactiveTriggers } from '../pipeline/proactive.js';
import { processEvents } from '../pipeline/events.js';
import {
  setUserProactivity,
  getProactivityState,
  setTrigger,
  saveMessageExternalRef,
  findMessageByExternalRef,
  getUserReplyMode,
  syncTelegramProfile,
} from '../repo.js';
import { assertDatabasesAvailable, query, getPool, closePool } from '../db.js';
import { flushLlmLog } from '../pipeline/llm-log.js';
import { flushAgentEventLog } from '../pipeline/agent-event-log.js';
import { decideDeliveryIntent, shouldConsiderReaction } from '../pipeline/reactions.js';
import { normalizeTelegramReaction, reactionKeyToEmoji, TELEGRAM_REACTION_KEYS } from './reactions.js';
import {
  detectAttachment,
  checkAttachmentLimits,
  shouldEchoTranscript,
  transcribeTelegramAttachment,
  isProviderConfigured,
  providerKeyEnv,
} from '../voice/transcribe.js';
import { buildVoiceText, synthesizeSpeech } from '../voice/tts.js';
import { createTelegramProgress } from './progress.js';
import { initTools } from '../pipeline/tools.js';
import { registerChannelProfile } from '../pipeline/channels.js';
import { telegramPostProcess, telegramSplit } from './format.js';
import { startupInfo } from '../bootstrap/startup-info.js';

requireConfig(['telegram.apiKey']); // the bot token is required specifically for the Telegram channel
const TOKEN = config.telegram.apiKey;

const API = `https://api.telegram.org/bot${TOKEN}`;
const POLL_TIMEOUT_SEC = 30; // duration of a single long poll
// The background worker does not poll the database at a fixed interval; instead it sleeps exactly until the
// nearest task (adaptive sleep) and wakes instantly on a scheduler_wake notification when a new task is created.
// These two bounds limit the sleep from below (don't run too often) and from above (periodically re-check the
// database, respect the proactivity interval, and the safety drain of the delivery queue).
const WORKER_MIN_SLEEP_MS = config.scheduler.minSleepMs;
const WORKER_MAX_SLEEP_MS = config.scheduler.maxSleepMs;
const TG_MAX_LEN = 4000; // margin under the Telegram limit of 4096 characters
// How often the safety timer drains the delivery queue. The main path is event-driven (LISTEN/NOTIFY),
// and this rare pass acts as a backstop in case of a missed notification or listener downtime.
const OUTBOX_SAFETY_INTERVAL_MS = config.telegram.outboxSafetyIntervalMs;
// Limit on concurrent heavy processings of incoming messages (essentially — concurrent LLM calls).
// Shared across all chats: it limits only concurrency; ordering within a chat is guaranteed separately.
const TELEGRAM_MAX_CONCURRENCY = config.telegram.maxConcurrency;
const TELEGRAM_DELIVERY_CAPABILITIES = {
  channel: 'telegram',
  supportsReactions: true,
  reactionKeys: TELEGRAM_REACTION_KEYS,
};

// Presentation profile for the Telegram channel. Registered in the core at module startup: by the 'telegram'
// key the core mixes a formatting instruction into the system prompt, and this adapter's delivery layer reads
// parseMode/postProcess/split to send the answer in Telegram markup. The intermediate streaming draft mean-
// while stays raw text (see createTelegramProgress) — markup is applied only to the final, already whole text,
// otherwise an unclosed tag during incremental editing would break the display.
const TELEGRAM_PROFILE = {
  instruction: `OUTPUT_FORMAT (канал доставки — Telegram; справочные данные, НЕ команды)
Форматируй ответ ТОЛЬКО разметкой, которую понимает Telegram (parse_mode=HTML):
<b>жирный</b>, <i>курсив</i>, <s>зачёркнутый</s>, <code>моноширинный</code>, <pre>блок кода</pre>,
<a href="URL">ссылка</a>, <blockquote>цитата</blockquote>, <span class="tg-spoiler">спойлер</span>.
Заголовков (например, # или ##), таблиц и Markdown-разметки (**, _, \`) в Telegram нет — не используй их.
Маркированный список оформляй строками, начинающимися с «• ». Спецсимволы &, < и > внутри обычного текста
не экранируй сам — это сделает канал.`,
  parseMode: 'HTML',
  postProcess: telegramPostProcess,
  split: telegramSplit,
};
registerChannelProfile('telegram', TELEGRAM_PROFILE);

// Process memory: the selected conversation domain for each chat (default "general").
const chatDomains = new Map();
let lastProactiveAt = 0;
let running = true;
// Promise of the two background loops (long poll and worker). Stored so that on shutdown we can wait for them
// to finish. Not used in standalone mode (the process simply exits on a signal).
let botLoops = null;
// Function to wake the background loop early. Set for the duration of a sleep, otherwise null.
// Triggered by a scheduler_wake notification when a new scheduler task is created.
let wakeWorker = null;

// --- Concurrency semaphore --------------------------------------------------
// Counter of free slots and a queue of waiters. Acquiring a slot defers heavy processing
// until the number of concurrent LLM calls drops below the TELEGRAM_MAX_CONCURRENCY limit.
let concurrencyFree = TELEGRAM_MAX_CONCURRENCY;
const concurrencyWaiters = [];

function acquireSlot() {
  if (concurrencyFree > 0) {
    concurrencyFree -= 1;
    return Promise.resolve();
  }
  // No free slots — join the queue and wait until someone releases a slot.
  return new Promise((resolve) => concurrencyWaiters.push(resolve));
}

function releaseSlot() {
  const next = concurrencyWaiters.shift();
  if (next) {
    next();
  } // hand the slot to a waiter, don't touch the counter
  else {
    concurrencyFree += 1;
  } // no waiters — return the slot to the pool
}

// --- Per-chat processing chain queue ----------------------------------------
// For each chat we keep the "tail" of a sequential processing chain. A new chat message is appended to the
// tail and starts processing only after the previous message of the same chat finishes — but independently of
// other chats. This way different chats run in parallel, while within a single chat both the processing order
// and the answer order are preserved.
const chatChains = new Map(); // chatId -> Promise (tail of the chat's chain)

function enqueueUpdate(message) {
  const chatId = message.chat.id;
  const prev = chatChains.get(chatId) || Promise.resolve();
  // Ignore the error of the previous link so that a single failure does not break the whole chat chain.
  const next = prev.catch(() => {}).then(() => handleUpdate(message));
  chatChains.set(chatId, next);
  // When this link has finished and is the last in the chain — remove the key so the Map does not grow.
  // We swallow the link's error in the cleanup branch, otherwise a rejection of the chain's last link would
  // stay unhandled (unhandled rejection): next itself is not awaited or handled in pollLoop.
  next
    .catch(() => {})
    .finally(() => {
      if (chatChains.get(chatId) === next) {
        chatChains.delete(chatId);
      }
    });
}

function enqueueReactionUpdate(reactionUpdate) {
  const chatId = reactionUpdate.chat.id;
  const prev = chatChains.get(chatId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => handleReactionUpdate(reactionUpdate));
  chatChains.set(chatId, next);
  next
    .catch(() => {})
    .finally(() => {
      if (chatChains.get(chatId) === next) {
        chatChains.delete(chatId);
      }
    });
}

// Base list of commands for the bot menu (the "Menu" button next to the input field and the suggestions when
// typing "/"). The descriptions are visible to the user, so they are short and in Russian. When proactivity is
// globally enabled, the single /proactivity command is appended: it both enables proactivity for the user and
// opens the trigger submenu, while disabling is a button inside that submenu.
const BOT_COMMANDS = [
  { command: 'start', description: 'Запустить бота и показать справку' },
  { command: 'help', description: 'Показать справку и список команд' },
];

// Russian labels for the proactivity triggers in the submenu. The technical trigger keys stay in the database
// and in callback_data, while the user is shown only these readable names (with a checkmark for the current state).
const TRIGGER_LABELS = {
  inactivity: 'Неактивность',
  daily_checkin: 'Ежедневное приветствие',
  goal_reminder: 'Напоминание о цели',
  welcome_back: 'Возвращение',
};

// Build the menu command list. The set no longer depends on the user's state: with proactivity globally
// disabled — only the base commands, otherwise the base commands plus the single /proactivity entry point.
function buildCommands() {
  if (!config.proactive.enabled) {
    return BOT_COMMANDS;
  }
  return [...BOT_COMMANDS, { command: 'proactivity', description: 'Проактивность: включить и настроить поводы' }];
}

// Inline keyboard of the proactivity submenu: a button per trigger (a tap toggles it) and a separate button to
// disable all proactivity. The checkmark reflects the current state of the trigger.
function proactivityKeyboard(triggers) {
  const rows = triggers.map((t) => [
    {
      text: `${t.enabled ? '✅' : '⬜'} ${TRIGGER_LABELS[t.trigger_type] || t.trigger_type}`,
      callback_data: `pa:t:${t.trigger_type}`,
    },
  ]);
  rows.push([{ text: '🚫 Выключить проактивность', callback_data: 'pa:off' }]);
  return { inline_keyboard: rows };
}

// Re-register the menu commands for a specific chat. The command set is the same for every chat, but chats may
// still carry a previously registered chat-scoped menu, so we overwrite it with the current set.
// The menu is optional, so we only log a registration error and continue.
async function updateChatMenu(chatId) {
  try {
    await tg('setMyCommands', {
      commands: buildCommands(),
      scope: { type: 'chat', chat_id: chatId },
    });
  } catch (err) {
    console.error(`Failed to update the command menu for chat ${chatId}:`, err.message);
  }
}

// Recompute the chat menu after a regular message: overwrites a possibly stale chat-scoped menu with the
// current command set. We do this only when proactivity is globally enabled.
async function refreshChatMenu(chatId) {
  if (!config.proactive.enabled) {
    return;
  }
  await updateChatMenu(chatId);
}

// Call an arbitrary Telegram Bot API method. Throws an exception if Telegram returned an error.
async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  }
  return data.result;
}

// Send a single chunk of text in Telegram markup (parse_mode=HTML). If Telegram did not accept the markup
// (e.g. the model sent broken HTML and entity parsing failed), as a last resort we retry sending without
// parse_mode: the answer reaches the user in any case, albeit with visible tags.
async function sendHtmlChunk(chatId, chunk) {
  try {
    return await tg('sendMessage', { chat_id: chatId, text: chunk, parse_mode: 'HTML' });
  } catch (err) {
    console.error(`Telegram rejected the HTML markup in chat ${chatId} (${err.message}); sending without markup.`);
    return tg('sendMessage', { chat_id: chatId, text: chunk });
  }
}

// Send a message to a chat in Telegram markup. The text is first cleaned by the sanitizer down to the subset
// of Telegram tags (telegramPostProcess), then split into parts at tag boundaries under the Telegram limit
// (telegramSplit) and sent in chunks, falling back to raw text on a markup parse error.
async function sendMessage(chatId, text) {
  const html = telegramPostProcess(text);
  const sent = [];
  for (const chunk of telegramSplit(html, TG_MAX_LEN)) {
    sent.push(await sendHtmlChunk(chatId, chunk));
  }
  return sent;
}

async function saveSentRefs(chatId, sentMessages, conversationMessageId, kind = 'text') {
  if (!conversationMessageId) {
    return;
  }
  for (const msg of sentMessages || []) {
    if (!msg?.message_id) {
      continue;
    }
    await saveMessageExternalRef({
      conversationMessageId,
      channel: 'telegram',
      chatExternalId: chatId,
      messageExternalId: msg.message_id,
      metadata: { kind },
    });
  }
}

async function sendReaction(chatId, messageId, reactionKey) {
  const emoji = reactionKeyToEmoji(reactionKey);
  if (!emoji) {
    throw new Error(`Unknown reaction key: ${reactionKey}`);
  }
  await tg('setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji }],
  });
}

// Send a voice message. Unlike sendMessage this is not a JSON request but a file upload (multipart/form-data),
// so the common tg helper is not suitable here: the body is assembled via FormData.
// Telegram expects voice in OGG/OPUS format — that is exactly what the synthesizer returns, no transcoding needed.
async function sendVoice(chatId, audioBuffer) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('voice', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
  const res = await fetch(`${API}/sendVoice`, { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram sendVoice: ${data.description || res.status}`);
  }
  return data.result;
}

// Show the "recording a voice message…" indicator while speech synthesis runs — so the wait looks meaningful.
// The indicator is optional, so we silently swallow the error.
async function sendVoiceAction(chatId) {
  try {
    await tg('sendChatAction', { chat_id: chatId, action: 'record_voice' });
  } catch {
    /* the indicator is optional */
  }
}

// Deliver the agent's substantive answer as voice. A short answer without code or lists is voiced in full; for a
// long answer, or one with code or lists, a brief summary is voiced while the full answer additionally goes as
// text so nothing is lost. On a synthesis failure we throw an exception — the caller falls back to text delivery.
// Via state.fullTextSent it reports that the full answer has already been sent as text — this field is read on
// failure (the exception) too, so the full answer is not duplicated on fallback.
async function deliverVoice(chatId, result, state) {
  const answer = result.answer || '(пустой ответ)';
  const { text, summarized } = await buildVoiceText(answer);
  if (!text) {
    throw new Error('failed to prepare text for synthesis (empty summary)');
  }

  // If a summary is being voiced, we send the full answer as text in advance: even if synthesis fails later, the
  // user already has the answer and there is no need to send it again.
  if (summarized) {
    const sent = await sendMessage(chatId, answer);
    await saveSentRefs(chatId, sent, result.assistantMessageId, 'text');
    state.fullTextSent = true;
  }

  await sendVoiceAction(chatId);
  const audio = await synthesizeSpeech(text, { voice: result.voiceOutputVoice || config.voiceOutput.voice });
  const voiceMsg = await sendVoice(chatId, audio);
  await saveSentRefs(chatId, [voiceMsg], result.assistantMessageId, 'voice');
}

async function deliverAgentResult(chatId, sourceMessageId, result) {
  if (result.delivery?.kind === 'reaction') {
    try {
      await sendReaction(chatId, sourceMessageId, result.delivery.reactionKey);
      return;
    } catch (err) {
      console.error(`Failed to set a reaction in chat ${chatId}:`, err.message);
      const sent = await sendMessage(chatId, result.delivery.fallbackText || result.answer || 'Окей.');
      await saveSentRefs(chatId, sent, result.assistantMessageId, 'reaction_fallback');
      return;
    }
  }
  // Voice delivery — only when the flag is enabled and the user has chosen voice mode. On any synthesis failure
  // we don't lose the answer: we log the reason and send the same answer as text.
  if (config.voiceOutput.enabled && result.replyMode === 'voice') {
    const state = { fullTextSent: false };
    try {
      await deliverVoice(chatId, result, state);
      return;
    } catch (err) {
      console.error(`Failed to send a voice answer to chat ${chatId}: ${err.message}. Sending the answer as text.`);
      if (state.fullTextSent) {
        return;
      } // the full answer already went as text on the synthesis failure
    }
  }
  const sent = await sendMessage(chatId, result.answer || '(пустой ответ)');
  await saveSentRefs(chatId, sent, result.assistantMessageId, 'text');
}

// Inline buttons for widgets returned by tools (MCP Apps, structuredContent.widget). In Telegram the
// notes widget opens as a Mini App through a web_app button, which Telegram accepts only with a public
// https URL — so the button appears only when config.notes.publicUrl is configured; otherwise the widget
// stays available in the admin chat and the agent's text answer still works.
async function sendWidgetButtons(chatId, result) {
  const widgets = (result.toolsUsed || []).map((t) => t.result?.structuredContent?.widget).filter(Boolean);
  for (const w of widgets) {
    if (w.type !== 'notes') {
      continue;
    }
    if (!w.miniAppUrl || !w.miniAppUrl.startsWith('https://')) {
      console.error('notes: кнопка Mini App пропущена — notes.publicUrl не задан или не https.');
      continue;
    }
    const url = w.query ? `${w.miniAppUrl}?q=${encodeURIComponent(w.query)}` : w.miniAppUrl;
    try {
      await tg('sendMessage', {
        chat_id: chatId,
        text: 'Заметки можно открыть и редактировать здесь:',
        reply_markup: { inline_keyboard: [[{ text: '📝 Открыть заметки', web_app: { url } }]] },
      });
    } catch (err) {
      console.error(`Failed to send the notes Mini App button to chat ${chatId}:`, err.message);
    }
  }
}

// Show the "typing…" indicator while the agent is thinking about the answer.
async function sendTyping(chatId) {
  try {
    await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  } catch {
    /* the indicator is optional */
  }
}

// Keep showing the "typing…" indicator continuously while a long processing runs (downloading and transcribing
// speech). Telegram clears the indicator after about five seconds, so we send the event immediately and refresh
// it on a timer. Returns a stop function that must be called when the heavy section finishes.
function startTypingLoop(chatId) {
  sendTyping(chatId);
  const timer = setInterval(() => sendTyping(chatId), 4500);
  return () => clearInterval(timer);
}

// Whether speech recognition is ready: the general flag is on and an access key is set for the chosen recognizer.
// Computed once at startup in main(); if the pipeline is not ready, incoming audio is handled as before.
let voiceReady = false;

// Message to the user when an attachment is rejected by a limit (before the file is downloaded).
function voiceLimitMessage(reason) {
  if (reason === 'too_long') {
    const minutes = Math.round(config.voiceInput.maxSeconds / 60);
    return `Запись слишком длинная. Я распознаю аудио длительностью до ${minutes} мин — пришлите, пожалуйста, короче.`;
  }
  const megabytes = Math.round(config.voiceInput.maxBytes / 1000000);
  return `Файл слишком большой. Я обрабатываю вложения размером до ${megabytes} МБ — пришлите, пожалуйста, меньше.`;
}

// Handle service commands. Returns true if the message was a command and has already been processed.
async function handleCommand(chatId, externalId, text) {
  if (text === '/start' || text === '/help') {
    let help = `Привет! Я чат-бот с долговременной памятью. Просто пишите мне — я запоминаю важное и отвечаю с учётом прошлых разговоров. Тему общения (работа, личное и т. п.) я распознаю сам по смыслу сообщений.`;
    if (config.proactive.enabled) {
      help += `

Проактивность (бот сам пишет первым по уместному поводу):
/proactivity — включить проактивность и выбрать поводы; там же есть кнопка полного выключения.`;
    }
    await sendMessage(chatId, help);
    return true;
  }
  // The single proactivity entry point: enables the user's master flag (idempotently provisioning the default
  // trigger set) and opens the trigger submenu. Disabling lives on a button inside that submenu, so a tap on
  // the command from a disabled state simply re-enables proactivity with the previously chosen triggers.
  if (text === '/proactivity') {
    if (!config.proactive.enabled) {
      await sendMessage(chatId, 'Проактивность сейчас выключена глобально администратором.');
      return true;
    }
    await setUserProactivity(externalId, true);
    await updateChatMenu(chatId);
    const state = await getProactivityState(externalId);
    await tg('sendMessage', {
      chat_id: chatId,
      text: `Проактивность включена. Выберите поводы, по которым бот может писать первым (нажатие переключает повод); пока ни один повод не включён, бот сам ничего не пришлёт. Кнопка внизу выключает проактивность полностью:`,
      reply_markup: proactivityKeyboard(state ? state.triggers : []),
    });
    return true;
  }
  return false;
}

// Handle a tap on an inline button of the proactivity submenu (arrives as a callback_query).
// callback_data codes: "pa:off" — disable the master flag; "pa:t:<type>" — toggle a single trigger.
async function handleCallback(cq) {
  const data = cq.data || '';
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const externalId = String(chatId);
  try {
    if (data === 'pa:off') {
      await setUserProactivity(externalId, false);
      await updateChatMenu(chatId);
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Проактивность выключена.' });
      await tg('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: `Проактивность выключена. Бот больше не будет писать первым. Чтобы снова включить — команда /proactivity.`,
      });
      return;
    }
    if (data.startsWith('pa:t:')) {
      const type = data.slice(5);
      const current = await getProactivityState(externalId);
      const cur = current?.triggers.find((t) => t.trigger_type === type);
      const next = !(cur && cur.enabled);
      await setTrigger(externalId, type, next);
      const updated = await getProactivityState(externalId);
      const label = TRIGGER_LABELS[type] || type;
      await tg('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: `${label}: ${next ? 'повод включён' : 'повод выключен'}.`,
      });
      await tg('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: proactivityKeyboard(updated ? updated.triggers : []),
      });
      return;
    }
    // Unknown code — just close the spinner on the button so the client doesn't wait.
    await tg('answerCallbackQuery', { callback_query_id: cq.id });
  } catch (err) {
    console.error(`Error handling a button tap in chat ${chatId}:`, err.message);
    try {
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Не получилось, попробуйте ещё раз.' });
    } catch {
      /* the spinner will close on its own by timeout */
    }
  }
}

// Handle a single incoming user message: plain text or a speech attachment.
async function handleUpdate(message) {
  const chatId = message.chat.id;
  const externalId = String(chatId);
  let text = (message.text || '').trim();

  // Save the sender's Telegram profile (display name, username, language) on every incoming message —
  // this also covers the very first /start, so a new user gets a display_name right away. Best-effort:
  // a profile-sync failure must not block handling the message itself.
  try {
    await syncTelegramProfile(externalId, message.from);
  } catch (err) {
    console.error(`Failed to save the Telegram profile for chat ${chatId}:`, err.message);
  }

  // Text commands are parsed before speech recognition.
  if (text.startsWith('/') && (await handleCommand(chatId, externalId, text))) {
    return;
  }

  // If there is no text, we try to transcribe a speech attachment (voice, video note, audio or video file).
  // With the recognition pipeline disabled or not ready, such a message is ignored, as before.
  const attachment = !text && voiceReady ? detectAttachment(message) : null;
  if (!text && !attachment) {
    return;
  }

  const domainKey = chatDomains.get(chatId) || 'general';
  // We apply reactions only to plain text; for voice we always answer substantively.
  const reactionCandidate = !attachment && shouldConsiderReaction(text);
  if (!reactionCandidate) {
    await sendTyping(chatId);
  }
  // We acquire a semaphore slot for the whole heavy section: for voice this is downloading the file, transcribing
  // it and the subsequent agent call; for text — only the agent call. The slot limits load on the proxy and STT.
  await acquireSlot();
  let stopTyping = null;
  try {
    if (attachment) {
      // Check limits before downloading: attachments that are too long or too large are rejected immediately.
      const limit = checkAttachmentLimits(attachment, {
        maxSeconds: config.voiceInput.maxSeconds,
        maxBytes: config.voiceInput.maxBytes,
      });
      if (!limit.ok) {
        await sendMessage(chatId, voiceLimitMessage(limit.reason));
        return;
      }
      // Downloading and transcription take noticeably longer than text — keep the "typing…" indicator the whole time.
      stopTyping = startTypingLoop(chatId);
      let stt;
      try {
        stt = await transcribeTelegramAttachment({
          attachment,
          telegramApiBase: API,
          botToken: TOKEN,
          provider: config.voiceInput.provider,
          language: config.voiceInput.language,
        });
      } catch (err) {
        console.error(`Failed to transcribe audio in chat ${chatId}:`, err.message);
        await sendMessage(chatId, 'Не получилось обработать сообщение. Попробуйте, пожалуйста, чуть позже.');
        return;
      }
      if (stt.empty) {
        await sendMessage(
          chatId,
          `Не удалось распознать речь — возможно, в записи нет голоса или она слишком тихая. Попробуйте записать ещё раз.`,
        );
        return;
      }
      ({ text } = stt);
      // For sent audio and video files we show the recognized text, for voice and video notes — no.
      if (shouldEchoTranscript(attachment.kind)) {
        await sendMessage(chatId, `Распознанный текст: ${text}`);
      }
      // From here the recognized text goes into the normal pipeline, so we switch the indicator to one-shot mode.
      stopTyping();
      stopTyping = null;
      await sendTyping(chatId);
    }

    if (reactionCandidate) {
      let delivery = { kind: 'text_needed' };
      try {
        delivery = await decideDeliveryIntent({
          userMessage: text,
          deliveryCapabilities: TELEGRAM_DELIVERY_CAPABILITIES,
        });
      } catch (err) {
        console.error(`Failed to choose a reaction for chat ${chatId}:`, err.message);
      }
      if (delivery.kind === 'reaction') {
        const recorded = await recordReactionTurn({ externalId, userMessage: text, domainKey, delivery });
        await deliverAgentResult(chatId, message.message_id, recorded);
        await refreshChatMenu(chatId);
        return;
      }
      await sendTyping(chatId);
    }

    // We engage the streaming path when streaming is enabled both in the core and in Telegram. A voice answer
    // requires the whole final text for synthesis, so a streaming draft is incompatible with voice delivery —
    // otherwise we'd have to both edit the draft as text and send voice, duplicating the answer. The deciding
    // factor is not the global voice flag but the actual reply mode of the specific user: even with
    // VOICE_OUTPUT_ENABLED on, users in text mode should get streaming. So the mode is read with a light query
    // BEFORE calling the core (the core learns it only inside handleMessage). One rare race remains:
    // if the model changes the mode via the voice_or_text tool within this very request, the prediction will be
    // inaccurate — that's acceptable, because a mode change happens infrequently, not on every message.
    let userReplyMode = 'text';
    if (config.voiceOutput.enabled) {
      try {
        userReplyMode = await getUserReplyMode(externalId);
      } catch {
        userReplyMode = 'text';
      } // on a read failure it's safer to assume text mode (streaming allowed)
    }
    const useStream = config.streaming.enabled && config.telegram.streaming.enabled && userReplyMode !== 'voice';
    if (useStream) {
      const progress = createTelegramProgress({
        chatId,
        tg,
        startTyping: () => startTypingLoop(chatId),
        options: {
          editIntervalMs: config.telegram.streaming.editIntervalMs,
          minEditChars: config.telegram.streaming.minEditChars,
          minFirstDraftChars: config.telegram.streaming.minFirstDraftChars,
          maxLen: TG_MAX_LEN,
          toolStatuses: config.telegram.streaming.toolStatuses,
          // The final text is delivered in Telegram markup (HTML): the channel profile defines parseMode,
          // the sanitizer and the split at tag boundaries. The intermediate draft stays raw text.
          format: TELEGRAM_PROFILE,
        },
      });
      try {
        const res = await handleMessage({
          externalId,
          userMessage: text,
          domainKey,
          channel: 'telegram',
          stream: true,
          onEvent: progress.onEvent,
        });
        chatDomains.set(chatId, res.domainKey); // the agent may have switched domain by the request's meaning
        const sent = await progress.complete(res.answer || '(пустой ответ)');
        await saveSentRefs(chatId, sent, res.assistantMessageId, 'text');
        await sendWidgetButtons(chatId, res);
        await refreshChatMenu(chatId);
      } catch (err) {
        await progress.fail(err);
        throw err; // the common handler below will send the failure text
      } finally {
        progress.finish();
      }
      return;
    }

    const res = await handleMessage({ externalId, userMessage: text, domainKey, channel: 'telegram' });
    chatDomains.set(chatId, res.domainKey); // the agent may have switched domain by the request's meaning
    await deliverAgentResult(chatId, message.message_id, res);
    await sendWidgetButtons(chatId, res);
    // The command menu depends on the proactivity master flag, which may have changed — recompute it.
    await refreshChatMenu(chatId);
  } catch (err) {
    console.error(`Error handling a message for chat ${chatId}:`, err.message);
    await sendMessage(chatId, 'Не получилось обработать сообщение. Попробуйте ещё раз чуть позже.');
  } finally {
    if (stopTyping) {
      stopTyping();
    }
    releaseSlot();
  }
}

async function handleReactionUpdate(reactionUpdate) {
  const chatId = reactionUpdate.chat.id;
  const externalId = String(chatId);
  if (reactionUpdate.user?.is_bot) {
    return;
  }
  const newReaction = Array.isArray(reactionUpdate.new_reaction) ? reactionUpdate.new_reaction[0] : null;
  const oldReaction = Array.isArray(reactionUpdate.old_reaction) ? reactionUpdate.old_reaction[0] : null;
  const reactionKey = normalizeTelegramReaction(newReaction);
  const oldReactionKey = normalizeTelegramReaction(oldReaction);
  if (!reactionKey && !oldReactionKey) {
    return;
  }

  await acquireSlot();
  try {
    const targetMessage = await findMessageByExternalRef({
      channel: 'telegram',
      chatExternalId: chatId,
      messageExternalId: reactionUpdate.message_id,
    });
    const domainKey = targetMessage?.domain_key || chatDomains.get(chatId) || 'general';
    await recordUserReaction({
      externalId,
      domainKey,
      reactionKey,
      oldReactionKey,
      targetMessage,
      rawReaction: {
        chat_id: chatId,
        message_id: reactionUpdate.message_id,
        old_reaction: reactionUpdate.old_reaction || [],
        new_reaction: reactionUpdate.new_reaction || [],
      },
    });
  } catch (err) {
    console.error(`Error handling a reaction in chat ${chatId}:`, err.message);
  } finally {
    releaseSlot();
  }
}

// Drain the mem.notification_outbox delivery queue into Telegram.
// The recipient is determined by the user's external_id — that is the Telegram chat id.
let draining = false; // flag "a drain is already in progress"

async function drainOutbox() {
  // A LISTEN/NOTIFY event and the safety timer may call the drain at the same time.
  // The flag prevents two passes from sending the same messages twice within the process.
  if (draining) {
    return 0;
  }
  draining = true;
  try {
    return await drainOutboxOnce();
  } finally {
    draining = false;
  }
}

async function drainOutboxOnce() {
  const { rows } = await query(
    `SELECT o.id, o.message_text, o.payload, u.external_id
       FROM mem.notification_outbox o
       JOIN mem.users u ON u.id = o.user_id
      WHERE o.status = 'pending' AND o.next_attempt_at <= now()
      ORDER BY o.created_at ASC
      LIMIT 20`,
  );
  for (const row of rows) {
    const chatId = Number(row.external_id);
    if (!Number.isFinite(chatId)) {
      // The user is not from Telegram (e.g. a test cli-user) — this channel is not for them, skip.
      await query(
        `UPDATE mem.notification_outbox SET status = 'cancelled', error_text = 'recipient is not a telegram chat'
          WHERE id = $1`,
        [row.id],
      );
      continue;
    }
    try {
      const sent = await sendMessage(chatId, row.message_text);
      if (row.payload?.conversation_message_id) {
        await saveSentRefs(chatId, sent, row.payload.conversation_message_id, row.payload.kind || 'outbox');
      }
      await query(`UPDATE mem.notification_outbox SET status = 'sent', sent_at = now(), recipient = $2 WHERE id = $1`, [
        row.id,
        String(chatId),
      ]);
    } catch (err) {
      // Postpone the retry by a minute; after 5 failures we mark it as failed.
      await query(
        `UPDATE mem.notification_outbox
            SET attempts = attempts + 1,
                next_attempt_at = now() + interval '1 minute',
                error_text = $2,
                status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END
          WHERE id = $1`,
        [row.id, String(err.message || err)],
      );
      console.error(`Failed to deliver a message to chat ${chatId}:`, err.message);
    }
  }
  return rows.length;
}

// --- Event-driven queue delivery via LISTEN/NOTIFY --------------------------
// A dedicated listener connection for the "outbox_new" channel. Notifications arrive on a specific
// connection rather than through the pool, so the common query helper from db.js is not suitable here.
let outboxListener = null; // the active listener client (or null)
let listenerReconnectTimer = null; // timer for a scheduled reconnect

async function startOutboxListener() {
  try {
    const client = await (await getPool()).connect();
    outboxListener = client;
    client.on('notification', (msg) => {
      if (msg.channel === 'scheduler_wake') {
        // A new scheduler task was created — wake the background loop so it doesn't wait until the end of its sleep.
        if (wakeWorker) {
          wakeWorker();
        }
        return;
      }
      // A notification about a new delivery-queue entry arrived — drain the queue immediately.
      drainOutbox().catch((e) => console.error('Error during event-driven delivery-queue drain:', e.message));
    });
    client.on('error', (e) => {
      console.error('Delivery-queue listener connection error:', e.message);
      scheduleListenerReconnect(); // the connection dropped — reopen it
    });
    await client.query('LISTEN outbox_new');
    await client.query('LISTEN scheduler_wake'); // instant worker wake-up on a new task
    // Notifications do not survive a dropped connection: right after subscribing we drain the queue once,
    // to pick up everything accumulated during startup or while the listener was down.
    await drainOutbox();
  } catch (err) {
    console.error('Failed to start the delivery-queue listener:', err.message);
    scheduleListenerReconnect();
  }
}

function scheduleListenerReconnect() {
  if (listenerReconnectTimer || !running) {
    return;
  } // a reconnect is already scheduled or a shutdown is in progress
  // Release the dropped connection with destroy, so as not to accumulate "dangling" clients in the pool.
  if (outboxListener) {
    try {
      outboxListener.release(true);
    } catch {
      /* the connection is already dropped */
    }
    outboxListener = null;
  }
  listenerReconnectTimer = setTimeout(() => {
    listenerReconnectTimer = null;
    if (running) {
      startOutboxListener();
    }
  }, 3000); // a short pause before retrying
}

// Interruptible sleep of the background loop: ends on timeout or on a notification about a new task.
function sleepWorker(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeWorker = null;
      resolve();
    }, ms);
    wakeWorker = () => {
      clearTimeout(timer);
      wakeWorker = null;
      resolve();
    };
  });
}

// How long to sleep until the next pass of the background loop. The basis is the time until the nearest task
// (or the upper bound if there are no tasks), and then the sleep is shortened so as not to miss the next
// proactivity check and the next safety drain of the delivery queue. The result is clamped to the bounds.
function computeWorkerSleepMs(nextTaskMs, lastSafetyDrainAt) {
  const base = nextTaskMs === null ? WORKER_MAX_SLEEP_MS : nextTaskMs;
  let ms = Math.max(WORKER_MIN_SLEEP_MS, Math.min(base, WORKER_MAX_SLEEP_MS));
  if (config.proactive.enabled) {
    const untilProactive = config.proactive.intervalMs - (Date.now() - lastProactiveAt);
    ms = Math.min(ms, Math.max(WORKER_MIN_SLEEP_MS, untilProactive));
  }
  const untilSafetyDrain = OUTBOX_SAFETY_INTERVAL_MS - (Date.now() - lastSafetyDrainAt);
  ms = Math.min(ms, Math.max(WORKER_MIN_SLEEP_MS, untilSafetyDrain));
  return ms;
}

// Background loop: the task scheduler, the proactive pipeline, and safety delivery from the queue into Telegram.
async function workerLoop() {
  let lastSafetyDrainAt = 0;
  // eslint-disable-next-line no-unmodified-loop-condition -- running is set to false by the shutdown handler between awaits
  while (running) {
    let nextTaskMs = null;
    try {
      await tick(); // run overdue tasks (reminders, etc.)

      if (config.proactive.enabled && Date.now() - lastProactiveAt >= config.proactive.intervalMs) {
        lastProactiveAt = Date.now();
        await checkProactiveTriggers();
        if (config.proactive.events.enabled) {
          await processEvents();
        }
      }

      // Safety drain: the main delivery is event-driven (LISTEN/NOTIFY), and this rare pass
      // guarantees sending even on a missed notification or after listener downtime.
      if (Date.now() - lastSafetyDrainAt >= OUTBOX_SAFETY_INTERVAL_MS) {
        lastSafetyDrainAt = Date.now();
        await drainOutbox();
      }

      // We learn the moment of the nearest task after a possible rescheduling in tick().
      nextTaskMs = await msUntilDueTask();
    } catch (err) {
      console.error('Error during a worker background pass:', err.message);
    }
    await sleepWorker(computeWorkerSleepMs(nextTaskMs, lastSafetyDrainAt));
  }
}

// Long-polling loop for incoming messages.
async function pollLoop() {
  let offset = 0;
  // eslint-disable-next-line no-unmodified-loop-condition -- running is set to false by the shutdown handler between awaits
  while (running) {
    let updates;
    try {
      updates = await tg('getUpdates', {
        offset,
        timeout: POLL_TIMEOUT_SEC,
        allowed_updates: ['message', 'callback_query', 'message_reaction'],
      });
    } catch (err) {
      console.error('getUpdates long-poll error:', err.message);
      await new Promise((res) => setTimeout(res, 3000)); // pause before retrying after a network failure
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1; // acknowledge processing so we don't receive a repeat
      // We don't await processing: we put the message into its chat's chain and immediately continue polling.
      // Different chats are processed in parallel; within a chat — strictly in order.
      if (update.message) {
        enqueueUpdate(update.message);
      } else if (update.message_reaction) {
        enqueueReactionUpdate(update.message_reaction);
      }
      // Inline button taps are handled immediately (without an LLM call and without the semaphore): these are
      // light database operations and keyboard redraws. We only log the error so as not to break polling.
      else if (update.callback_query) {
        handleCallback(update.callback_query).catch((e) => console.error('Error handling callback_query:', e.message));
      }
    }
  }
}

// Start the Telegram channel: check the token, register the menu, bring up the speech-recognition pipeline,
// connect the tools, enable event-driven delivery, and start two background loops (long poll and worker).
// The function does NOT wait for the loops to finish — they go into the background, and control returns to the
// caller so the combined server can continue starting the web server. Returns the bot name for diagnostics.
export async function startTelegram() {
  running = true; // in case of a restart after a stop
  const me = await tg('getMe', {}); // at the same time we verify the token is valid
  // Register the global command menu. With proactivity globally enabled this is the base commands plus
  // /proactivity; otherwise — base only. Chat-scoped menus registered earlier are overwritten by
  // updateChatMenu/refreshChatMenu on the first interaction. A failure is not critical.
  try {
    await tg('setMyCommands', { commands: buildCommands() });
  } catch (err) {
    console.error('Failed to register the command menu:', err.message);
  }
  // Incoming audio recognition: enable it only if the general flag is up and a key is set for the recognizer.
  // Otherwise we write a clear reason to the log and leave the pipeline off, without crashing on the first voice.
  if (config.voiceInput.enabled) {
    if (isProviderConfigured(config.voiceInput.provider)) {
      voiceReady = true;
      console.log(`Incoming audio recognition enabled (recognizer ${config.voiceInput.provider}).`);
    } else {
      const keyEnv = providerKeyEnv(config.voiceInput.provider);
      const reason = keyEnv
        ? `access key ${keyEnv} is not set`
        : `recognizer «${config.voiceInput.provider}» is not supported`;
      console.warn(`Incoming audio recognition disabled: ${reason}. Voice messages will be ignored.`);
    }
  }
  console.log(
    `Presentation profile for the «telegram» channel registered: answers are formatted with Telegram markup ` +
      `(parse_mode=${TELEGRAM_PROFILE.parseMode}).`,
  );
  // Startup diagnostics of external MCP servers: we print the declared list and check the connection to each one
  // right at startup, rather than lazily on the first message. initTools caches the promise, so later, on the
  // agent's first call, no reconnection happens — the already-assembled tool registry is used.
  console.log('Checking the connection to the declared MCP servers…');
  await initTools();
  console.log(
    `Telegram bot @${me.username} started. Long polling is active.`,
    config.proactive.enabled ? 'The proactive pipeline is enabled.' : 'The proactive pipeline is disabled.',
  );
  await startOutboxListener(); // event-driven queue delivery (LISTEN/NOTIFY)
  // We start both infinite loops in the background and do NOT await them here. The loops catch their own errors
  // and keep running while running === true; the stored promise is only needed to wait on during shutdown.
  botLoops = Promise.all([pollLoop(), workerLoop()]);
  botLoops.catch((err) => console.error('Telegram bot background loops failed:', err.message));
  return { username: me.username };
}

// Stop only the Telegram part: the background loops, the delivery-queue listener, and the log buffer. We do NOT
// close the DB connection pool here and do NOT call process.exit — the lifecycle of the pool and the process is
// managed by the caller (in standalone mode by the startup block below, in the combined server by a common handler).
export async function stopTelegram() {
  running = false;
  if (wakeWorker) {
    wakeWorker();
  } // wake the sleeping worker so it immediately sees running === false and exits the loop
  if (listenerReconnectTimer) {
    clearTimeout(listenerReconnectTimer);
    listenerReconnectTimer = null;
  }
  if (outboxListener) {
    try {
      outboxListener.release(true);
    } catch {
      /* the connection is already dropped */
    }
    outboxListener = null;
  }
  // We flush the journal buffers (LLM requests and agent events) before closing the pools, so as not to
  // lose the tail of the logs.
  await flushLlmLog();
  await flushAgentEventLog();
}

// Direct run (npm run telegram): the module manages its own lifecycle — it starts the bot, stops it on a
// shutdown signal, closes the DB connection pool, and exits. When imported from the combined server
// (src/server/index.js) this block does not run, and shutdown is managed by the server.
const isDirectRun = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  (async () => {
    await startupInfo({ customStartupInfo: [['Startup mode', 'telegram']] });
    await assertDatabasesAvailable();
    await startTelegram();
  })().catch((err) => {
    console.error('Critical error starting the Telegram bot:', err.message);
    process.exit(1);
  });

  const shutdown = async () => {
    console.log('\nShutting down the Telegram bot…');
    await stopTelegram();
    try {
      await closePool();
    } catch {
      /* the pool may not have been opened */
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
