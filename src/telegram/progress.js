// Telegram-отображение потоковых событий ядра агента. Это один из возможных потребителей абстрактного
// контракта событий handleMessage (см. src/agent.js): ядро о Telegram не знает, а здесь события
// (assistant.delta, tool.started/completed и т. д.) превращаются в конкретные вызовы Bot API.
//
// Фабрика принимает зависимости извне (функцию вызова API tg, запуск индикатора набора, функцию разбиения
// длинного текста и часы now), поэтому её можно протестировать без реального Telegram и без таймеров.
//
// Базовая UX-модель: пока нет видимого текста — держим индикатор «печатает…»; при первом фрагменте ответа
// создаём один черновик-сообщение и дальше редактируем его с троттлингом; вызовы инструментов показываем
// одним отдельным status-сообщением, которое убираем при появлении ответа или в конце обработки.

// Разбиение по умолчанию: режем по длине на куски не длиннее limit. Telegram-адаптер передаёт сюда свой
// splitText, который дополнительно старается резать по границам строк.
function defaultSplit(text, limit) {
  const parts = [];
  let rest = String(text);
  while (rest.length > limit) {
    parts.push(rest.slice(0, limit));
    rest = rest.slice(limit);
  }
  if (rest.length) parts.push(rest);
  return parts;
}

export function createTelegramProgress({ chatId, tg, startTyping = null, options = {} }) {
  const editIntervalMs = options.editIntervalMs ?? 500;     // не чаще одного редактирования за это время
  const minEditChars = options.minEditChars ?? 20;          // и не реже, чем накопится столько новых символов
  const minFirstDraftChars = options.minFirstDraftChars ?? 50; // первый черновик — только когда текста накопилось столько
  const maxLen = options.maxLen ?? 4000;                     // предел длины одного сообщения Telegram
  const toolStatuses = options.toolStatuses !== false;      // показывать ли статус вызова инструмента
  const splitText = options.splitText || defaultSplit;
  const now = options.now || (() => Date.now());

  const state = {
    typingStop: null,     // функция остановки индикатора «печатает…»
    draftId: null,        // message_id черновика ответа (создаётся при первом фрагменте текста)
    statusId: null,       // message_id status-сообщения вызова инструмента
    buffer: '',           // накопленный текст ответа
    lastEditAt: 0,        // момент последнего редактирования черновика
    lastEditLen: 0,       // длина буфера на момент последнего редактирования
    lastEditText: null,   // последний отправленный текст (чтобы не повторять идентичный edit)
    closed: false,        // обработка завершена (complete/fail вызваны)
    sent: [],             // отправленные сообщения ответа — для сохранения внешних ссылок
  };

  function clip(text) {
    return text.length > maxLen ? text.slice(0, maxLen) : text;
  }

  function ensureTyping() {
    if (!state.typingStop && startTyping) state.typingStop = startTyping();
  }

  function stopTyping() {
    if (state.typingStop) {
      try { state.typingStop(); } catch { /* остановка индикатора необязательна */ }
      state.typingStop = null;
    }
  }

  // Показать или обновить одно status-сообщение «Вызываю инструмент: …». Пока идёт показ ответа
  // (черновик уже создан), статус инструмента не смешиваем с текстом ответа.
  async function showToolStatus(title) {
    if (!toolStatuses || state.draftId !== null) return;
    const text = `Вызываю инструмент: ${title}`;
    if (state.statusId === null) {
      const res = await tg('sendMessage', { chat_id: chatId, text });
      state.statusId = res?.message_id ?? null;
    } else {
      try { await tg('editMessageText', { chat_id: chatId, message_id: state.statusId, text }); }
      catch { /* «не изменено» или сообщение недоступно — не критично */ }
    }
  }

  // Убрать status-сообщение инструмента. Делается при появлении ответа и в конце обработки.
  async function clearToolStatus() {
    if (state.statusId === null) return;
    const id = state.statusId;
    state.statusId = null;
    try { await tg('deleteMessage', { chat_id: chatId, message_id: id }); }
    catch { /* сообщение уже могло быть удалено */ }
  }

  // Редактирование черновика с троттлингом: не чаще editIntervalMs и не менее чем на minEditChars новых
  // символов, кроме принудительного финального flush.
  async function maybeEdit(force) {
    if (state.draftId === null) return;
    const text = clip(state.buffer);
    if (!force) {
      const elapsed = now() - state.lastEditAt;
      const grew = state.buffer.length - state.lastEditLen;
      if (elapsed < editIntervalMs || grew < minEditChars) return;
    }
    if (text === state.lastEditText) return;
    try {
      await tg('editMessageText', { chat_id: chatId, message_id: state.draftId, text });
      state.lastEditAt = now();
      state.lastEditLen = state.buffer.length;
      state.lastEditText = text;
    } catch {
      // Ошибки редактирования (текст не изменился, сообщение недоступно) не должны ронять ответ:
      // финальный текст всё равно будет гарантированно доставлен методом complete().
    }
  }

  // Принять очередной фрагмент текста ответа. Черновик создаётся не на первом же символе, а когда накопился
  // осмысленный объём текста (minFirstDraftChars): иначе пользователь видит мигающий пузырь из одной-двух букв,
  // который сразу переписывается. Пока порог не достигнут, держим индикатор «печатает…». Короткий ответ, который
  // завершится не дойдя до порога, доставит целиком метод complete() — отдельного черновика для него не будет.
  async function appendDelta(text) {
    if (!text) return;
    state.buffer += text;
    if (state.draftId === null) {
      if (state.buffer.trim().length < minFirstDraftChars) return;   // ждём, пока накопится осмысленный объём
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

  // Единая точка приёма абстрактных событий ядра.
  async function onEvent(event) {
    if (!event || state.closed) return;
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
      // tool.completed, assistant.completed, agent.completed обрабатываются методом complete():
      // финальный текст — источник правды, поэтому промежуточные сигналы завершения не дублируем.
      default:
        break;
    }
  }

  // Принудительно дописать финальный текст: гарантирует, что пользователь получил полный ответ целиком,
  // включая длинный ответ, который не помещается в одно сообщение.
  async function complete(finalText) {
    state.closed = true;
    stopTyping();
    await clearToolStatus();
    const parts = splitText(String(finalText ?? ''), maxLen);
    const head = parts.length ? parts[0] : '';
    const tail = parts.slice(1);

    if (state.draftId === null) {
      // Текстовых фрагментов не было (например, ответ пришёл целиком после инструментов) — шлём заново.
      const first = await tg('sendMessage', { chat_id: chatId, text: head });
      state.sent = first ? [first] : [];
    } else {
      // Черновик есть — финальным редактированием приводим его к началу полного ответа.
      state.buffer = head;
      try {
        await tg('editMessageText', { chat_id: chatId, message_id: state.draftId, text: head });
        state.lastEditText = head;
      } catch {
        const m = await tg('sendMessage', { chat_id: chatId, text: head });
        if (m) state.sent.push(m);
      }
    }
    for (const part of tail) {
      const m = await tg('sendMessage', { chat_id: chatId, text: part });
      if (m) state.sent.push(m);
    }
    return state.sent;
  }

  // Обработка сбоя: гасим индикатор и убираем статус инструмента. Сам текст ошибки отправляет вызывающая
  // сторона (Telegram-адаптер), потому что формулировка сбоя — забота канала.
  async function fail() {
    state.closed = true;
    stopTyping();
    await clearToolStatus();
  }

  // Окончательная очистка ресурсов (на случай, если complete/fail не были вызваны).
  function finish() {
    stopTyping();
  }

  function getSentMessages() {
    return state.sent;
  }

  return { startTyping: ensureTyping, onEvent, complete, fail, finish, getSentMessages };
}
