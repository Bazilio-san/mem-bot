// Telegram rendering of the agent core's streaming events. This is one possible consumer of the abstract
// handleMessage event contract (see src/agent.js): the core knows nothing about Telegram, and here the events
// (assistant.delta, tool.started/completed, etc.) are turned into concrete Bot API calls.
//
// The factory takes its dependencies from outside (the tg API-call function, the typing-indicator starter, the
// long-text splitting function, and the now clock), so it can be tested without a real Telegram and without timers.
//
// Basic UX model: while there is no visible text we keep the "typing…" indicator; on the first answer fragment
// we create a single draft message and then edit it with throttling; tool calls are shown as one separate status
// message, which we remove when the answer appears or at the end of processing.

// Default splitting: cut by length into chunks no longer than limit. The Telegram adapter passes in its own
// splitText, which additionally tries to cut at line boundaries.
function defaultSplit(text, limit) {
  const parts = [];
  let rest = String(text);
  while (rest.length > limit) {
    parts.push(rest.slice(0, limit));
    rest = rest.slice(limit);
  }
  if (rest.length) {
    parts.push(rest);
  }
  return parts;
}

export function createTelegramProgress({ chatId, tg, startTyping = null, options = {} }) {
  const editIntervalMs = options.editIntervalMs ?? 500; // at most one edit within this interval
  const minEditChars = options.minEditChars ?? 20; // and at least once this many new chars accumulate
  const minFirstDraftChars = options.minFirstDraftChars ?? 50; // first draft only once this much text has accumulated
  const maxLen = options.maxLen ?? 4000; // length limit of a single Telegram message
  const toolStatuses = options.toolStatuses !== false; // whether to show the tool-call status
  const now = options.now || (() => Date.now());

  // Formatting profile for the final answer. The intermediate draft and tool statuses always go as raw text
  // (parseMode is not applied): an unclosed tag during incremental editing would break the display. Markup is
  // applied only to the whole final text in complete().
  const format = options.format || {};
  const finalParseMode = format.parseMode || null; // markup mode for the final ('HTML' or null)
  const finalPostProcess = format.postProcess || ((t) => t); // sanitizer for the final text
  const finalSplit = format.split || options.splitText || defaultSplit; // split the final at tag boundaries

  const state = {
    typingStop: null, // function that stops the "typing…" indicator
    draftId: null, // message_id of the answer draft (created on the first text fragment)
    statusId: null, // message_id of the tool-call status message
    buffer: '', // accumulated answer text
    lastEditAt: 0, // time of the last draft edit
    lastEditLen: 0, // buffer length at the time of the last edit
    lastEditText: null, // last sent text (to avoid repeating an identical edit)
    closed: false, // processing finished (complete/fail called)
    sent: [], // sent answer messages — for storing external references
  };

  function clip(text) {
    return text.length > maxLen ? text.slice(0, maxLen) : text;
  }

  function ensureTyping() {
    if (!state.typingStop && startTyping) {
      state.typingStop = startTyping();
    }
  }

  function stopTyping() {
    if (state.typingStop) {
      try {
        state.typingStop();
      } catch {
        /* stopping the indicator is optional */
      }
      state.typingStop = null;
    }
  }

  // Show or update a single tool status message. While the answer is being shown
  // (the draft already exists), we don't mix the tool status with the answer text.
  async function showToolStatus(title) {
    if (!toolStatuses || state.draftId !== null) {
      return;
    }
    const text = String(title);
    if (state.statusId === null) {
      const res = await tg('sendMessage', { chat_id: chatId, text });
      state.statusId = res?.message_id ?? null;
    } else {
      try {
        await tg('editMessageText', { chat_id: chatId, message_id: state.statusId, text });
      } catch {
        /* "not modified" or the message is unavailable — not critical */
      }
    }
  }

  // Remove the tool status message. Done when the answer appears and at the end of processing.
  async function clearToolStatus() {
    if (state.statusId === null) {
      return;
    }
    const id = state.statusId;
    state.statusId = null;
    try {
      await tg('deleteMessage', { chat_id: chatId, message_id: id });
    } catch {
      /* the message may already have been deleted */
    }
  }

  // Throttled draft editing: no more often than editIntervalMs and not for fewer than minEditChars new
  // characters, except for a forced final flush.
  async function maybeEdit(force) {
    if (state.draftId === null) {
      return;
    }
    const text = clip(state.buffer);
    if (!force) {
      const elapsed = now() - state.lastEditAt;
      const grew = state.buffer.length - state.lastEditLen;
      if (elapsed < editIntervalMs || grew < minEditChars) {
        return;
      }
    }
    if (text === state.lastEditText) {
      return;
    }
    try {
      await tg('editMessageText', { chat_id: chatId, message_id: state.draftId, text });
      state.lastEditAt = now();
      state.lastEditLen = state.buffer.length;
      state.lastEditText = text;
    } catch {
      // Edit errors (text unchanged, message unavailable) must not bring down the answer:
      // the final text will be delivered for sure by the complete() method anyway.
    }
  }

  // Accept the next fragment of answer text. The draft is created not on the very first character but once a
  // meaningful amount of text has accumulated (minFirstDraftChars): otherwise the user sees a flickering bubble of
  // one or two letters that is immediately rewritten. Until the threshold is reached we keep the "typing…"
  // indicator. A short answer that ends before reaching the threshold is delivered in full by complete() — there
  // will be no separate draft for it.
  async function appendDelta(text) {
    if (!text) {
      return;
    }
    state.buffer += text;
    if (state.draftId === null) {
      if (state.buffer.trim().length < minFirstDraftChars) {
        return;
      } // wait until a meaningful amount has accumulated
      stopTyping();
      await clearToolStatus();
      const res = await tg('sendMessage', { chat_id: chatId, text: clip(state.buffer) });
      state.draftId = res?.message_id ?? null;
      state.sent = res ? [res] : [];
      state.lastEditAt = now();
      state.lastEditLen = state.buffer.length;
      state.lastEditText = clip(state.buffer);
      return;
    }
    await maybeEdit(false);
  }

  // Single entry point for accepting the core's abstract events.
  async function onEvent(event) {
    if (!event || state.closed) {
      return;
    }
    switch (event.type) {
      case 'agent.started':
      case 'stage.started':
        ensureTyping();
        break;
      case 'tool.started':
        ensureTyping();
        await showToolStatus(event.toolTitle || event.toolName);
        break;
      case 'assistant.delta':
        await appendDelta(event.text);
        break;
      // tool.completed, assistant.completed, agent.completed are handled by the complete() method:
      // the final text is the source of truth, so we don't duplicate intermediate completion signals.
      default:
        break;
    }
  }

  // Send the final chunk in the channel's markup, falling back to raw text on a markup parse error.
  async function sendFinal(text) {
    if (!finalParseMode) {
      return tg('sendMessage', { chat_id: chatId, text });
    }
    try {
      return await tg('sendMessage', { chat_id: chatId, text, parse_mode: finalParseMode });
    } catch {
      return tg('sendMessage', { chat_id: chatId, text }); // last resort: no markup
    }
  }

  // Turn the draft into the final chunk by editing. Returns true on success. First we try with markup, on a
  // parse error — without it; if it failed entirely, we report failure to the caller.
  async function editFinal(messageId, text) {
    if (finalParseMode) {
      try {
        await tg('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: finalParseMode });
        return true;
      } catch {
        /* markup was rejected — we try without it below */
      }
    }
    try {
      await tg('editMessageText', { chat_id: chatId, message_id: messageId, text });
      return true;
    } catch {
      return false;
    }
  }

  // Force-write the final text: guarantees the user received the complete answer in full, including a long
  // answer that does not fit in a single message. The final is the only place where the channel's markup is
  // applied: the text is cleaned by the sanitizer and cut at tag boundaries.
  async function complete(finalText) {
    state.closed = true;
    stopTyping();
    await clearToolStatus();
    const clean = finalPostProcess(String(finalText ?? ''));
    // An empty final with no draft is legitimate (e.g. the whole answer is a generated photo delivered by the
    // channel adapter) — there is simply nothing to send, and Telegram rejects empty message text anyway.
    if (!clean.trim() && state.draftId === null) {
      return state.sent;
    }
    const parts = finalSplit(clean, maxLen);
    const head = parts.length ? parts[0] : '';
    const tail = parts.slice(1);

    if (state.draftId === null) {
      // There were no text fragments (e.g. the answer arrived whole after the tools) — send anew.
      const first = await sendFinal(head);
      state.sent = first ? [first] : [];
    } else {
      // There is a draft — with a final edit we bring it to the start of the full answer with markup.
      state.buffer = head;
      const ok = await editFinal(state.draftId, head);
      state.lastEditText = head;
      if (!ok) {
        const m = await sendFinal(head);
        if (m) {
          state.sent.push(m);
        }
      }
    }
    for (const part of tail) {
      const m = await sendFinal(part);
      if (m) {
        state.sent.push(m);
      }
    }
    return state.sent;
  }

  // Failure handling: stop the indicator and remove the tool status. The error text itself is sent by the
  // caller (the Telegram adapter), because the wording of a failure is the channel's concern.
  async function fail() {
    state.closed = true;
    stopTyping();
    await clearToolStatus();
  }

  // Final resource cleanup (in case complete/fail were not called).
  function finish() {
    stopTyping();
  }

  function getSentMessages() {
    return state.sent;
  }

  return { startTyping: ensureTyping, onEvent, complete, fail, finish, getSentMessages };
}
