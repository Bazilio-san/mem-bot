// Telegram-адаптер: подключает чат-бота с долговременной памятью к Telegram Bot API.
// Входящие сообщения принимаются через длинный опрос (long polling, метод getUpdates),
// ответы агента и проактивные сообщения уходят пользователю методом sendMessage.
// Внешним идентификатором пользователя (external_id) служит идентификатор чата Telegram —
// благодаря этому проактивные сообщения из очереди доставки находят нужный чат.
// Запуск: npm run telegram
import { config } from './config.js';
import { handleMessage, recordReactionTurn, recordUserReaction } from './agent.js';
import { tick } from './pipeline/scheduler.js';
import { checkProactiveTriggers } from './pipeline/proactive.js';
import { processEvents } from './pipeline/events.js';
import { fireProactiveNow } from './pipeline/proactive.js';
import {
  setUserProactivity, getProactivityState, setTrigger,
  saveMessageExternalRef, findMessageByExternalRef,
} from './repo.js';
import { query, getPool, closePool } from './db.js';
import {
  decideDeliveryIntent, normalizeTelegramReaction, shouldConsiderReaction,
} from './pipeline/reactions.js';

const TOKEN = process.env.TELEGRAM_API_KEY;
if (!TOKEN) {
  console.error('Не задана переменная окружения TELEGRAM_API_KEY — токен Telegram-бота. Запуск невозможен.');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const POLL_TIMEOUT_SEC = 30;                                         // длительность одного длинного опроса
const WORKER_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 5000);
const TG_MAX_LEN = 4000;                                            // запас под лимит Telegram в 4096 символов
// Как часто страховочный таймер опустошает очередь доставки. Основной путь — событийный (LISTEN/NOTIFY),
// а этот редкий проход подстраховывает на случай пропущенного уведомления или простоя слушателя.
const OUTBOX_SAFETY_INTERVAL_MS = Number(process.env.OUTBOX_SAFETY_INTERVAL_MS || 30000);
// Предел одновременных тяжёлых обработок входящих сообщений (по сути — одновременных вызовов LLM).
// Общий по всем чатам: ограничивает только параллелизм, порядок внутри чата гарантируется отдельно.
const TELEGRAM_MAX_CONCURRENCY = Number(process.env.TELEGRAM_MAX_CONCURRENCY || 5);
const TELEGRAM_REACTION_EMOJI = {
  like: '👍',
  okay: '👌',
  heart: '❤',
  laugh: '😁',
  fire: '🔥',
  smile: '😊',
  100: '💯',
  sad: '😢',
};
const TELEGRAM_DELIVERY_CAPABILITIES = {
  channel: 'telegram',
  supportsReactions: true,
  reactionKeys: Object.keys(TELEGRAM_REACTION_EMOJI),
};

// Память процесса: выбранный домен общения для каждого чата (по умолчанию «general»).
const chatDomains = new Map();
let lastProactiveAt = 0;
let running = true;

// --- Семафор параллелизма ---------------------------------------------------
// Счётчик свободных слотов и очередь ожидающих. Захват слота откладывает тяжёлую обработку,
// пока число одновременных вызовов LLM не опустится ниже предела TELEGRAM_MAX_CONCURRENCY.
let concurrencyFree = TELEGRAM_MAX_CONCURRENCY;
const concurrencyWaiters = [];

function acquireSlot() {
  if (concurrencyFree > 0) {
    concurrencyFree -= 1;
    return Promise.resolve();
  }
  // Свободных слотов нет — встаём в очередь и ждём, пока кто-нибудь освободит слот.
  return new Promise((resolve) => concurrencyWaiters.push(resolve));
}

function releaseSlot() {
  const next = concurrencyWaiters.shift();
  if (next) next();                                                  // передаём слот ожидающему, счётчик не трогаем
  else concurrencyFree += 1;                                         // ожидающих нет — возвращаем слот в пул
}

// --- Очередь-цепочка обработки на каждый чат --------------------------------
// Для каждого чата храним «хвост» последовательной цепочки обработки. Новое сообщение чата
// подвешивается за хвост и начинает обрабатываться только после завершения предыдущего сообщения
// того же чата — но независимо от других чатов. Так разные чаты идут параллельно, а внутри
// одного чата сохраняются порядок обработки и порядок ответов.
const chatChains = new Map();                                        // chatId -> Promise (хвост цепочки чата)

function enqueueUpdate(message) {
  const chatId = message.chat.id;
  const prev = chatChains.get(chatId) || Promise.resolve();
  // Игнорируем ошибку предыдущего звена, чтобы один сбой не оборвал всю цепочку чата.
  const next = prev.catch(() => {}).then(() => handleUpdate(message));
  chatChains.set(chatId, next);
  // Когда это звено завершилось и осталось последним в цепочке — убираем ключ, чтобы Map не рос.
  // Глотаем ошибку звена в ветке очистки, иначе отклонение последнего звена цепочки осталось бы
  // необработанным (unhandled rejection): сам next в pollLoop не дожидается и не обрабатывается.
  next.catch(() => {}).finally(() => { if (chatChains.get(chatId) === next) chatChains.delete(chatId); });
}

function enqueueReactionUpdate(reactionUpdate) {
  const chatId = reactionUpdate.chat.id;
  const prev = chatChains.get(chatId) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => handleReactionUpdate(reactionUpdate));
  chatChains.set(chatId, next);
  next.catch(() => {}).finally(() => { if (chatChains.get(chatId) === next) chatChains.delete(chatId); });
}

// Базовый список команд для меню бота (кнопка «Меню» рядом с полем ввода и подсказки при наборе «/»).
// Описания видны пользователю, поэтому они краткие и на русском языке. Команды управления проактивностью
// добавляются к этому набору динамически, в зависимости от глобального флага и состояния пользователя.
// Имена команд Telegram допускают только строчные латинские буквы, цифры и подчёркивание, поэтому здесь
// используются proactivity_on / proactivity_off, а не варианты с дефисом.
const BOT_COMMANDS = [
  { command: 'start', description: 'Запустить бота и показать справку' },
  { command: 'help', description: 'Показать справку и список команд' },
  { command: 'domain', description: 'Сменить домен общения, например work или personal' },
  { command: 'proactive', description: 'Вручную запустить проактивный триггер' },
];

// Русские подписи поводов проактивности для подменю. Технические ключи триггеров остаются в базе и в
// callback_data, а пользователю показываются только эти читаемые названия (с галочкой текущего состояния).
const TRIGGER_LABELS = {
  inactivity: 'Неактивность',
  daily_checkin: 'Ежедневное приветствие',
  goal_reminder: 'Напоминание о цели',
  welcome_back: 'Возвращение',
};

// Собрать список команд меню под конкретное состояние пользователя.
// Глобально выключено — только базовые команды. Глобально включено: если мастер-флаг пользователя выключен,
// предлагаем включить проактивность; если включён — предлагаем выключить и открыть настройку поводов.
function buildCommands(masterEnabled) {
  if (!config.proactive.enabled) return BOT_COMMANDS;
  if (masterEnabled) {
    return [
      ...BOT_COMMANDS,
      { command: 'proactivity_off', description: 'Выключить проактивность' },
      { command: 'proactivity', description: 'Настроить поводы проактивности' },
    ];
  }
  return [...BOT_COMMANDS, { command: 'proactivity_on', description: 'Включить проактивность' }];
}

// Инлайн-клавиатура подменю проактивности: по кнопке на каждый повод (нажатие переключает его) и отдельная
// кнопка выключения всей проактивности. Галочка отражает текущее состояние повода.
function proactivityKeyboard(triggers) {
  const rows = triggers.map((t) => [{
    text: `${t.enabled ? '✅' : '⬜'} ${TRIGGER_LABELS[t.trigger_type] || t.trigger_type}`,
    callback_data: `pa:t:${t.trigger_type}`,
  }]);
  rows.push([{ text: '🚫 Выключить проактивность', callback_data: 'pa:off' }]);
  return { inline_keyboard: rows };
}

// Перерегистрировать команды меню для конкретного чата под его текущее состояние проактивности.
// Меню необязательно, поэтому ошибку регистрации только логируем и продолжаем работу.
async function updateChatMenu(chatId, masterEnabled) {
  try {
    await tg('setMyCommands', {
      commands: buildCommands(masterEnabled),
      scope: { type: 'chat', chat_id: chatId },
    });
  } catch (err) {
    console.error(`Не удалось обновить меню команд чата ${chatId}:`, err.message);
  }
}

// Пересчитать меню чата после обычного сообщения: набор команд зависит от мастер-флага пользователя,
// который мог измениться. Делаем это только при глобально включённой проактивности.
async function refreshChatMenu(chatId, externalId) {
  if (!config.proactive.enabled) return;
  try {
    const state = await getProactivityState(externalId);
    await updateChatMenu(chatId, state?.enabled === true);
  } catch (err) {
    console.error(`Не удалось пересчитать меню чата ${chatId}:`, err.message);
  }
}

// Вызов произвольного метода Telegram Bot API. Бросает исключение, если Telegram вернул ошибку.
async function tg(method, body) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

// Разбить длинный текст на части не длиннее limit, по возможности по границам строк.
function splitText(text, limit) {
  const parts = [];
  let rest = String(text);
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;                            // нет удобного переноса — режем жёстко
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length) parts.push(rest);
  return parts;
}

// Отправить сообщение в чат, разбивая его на части при превышении лимита Telegram.
async function sendMessage(chatId, text) {
  const sent = [];
  for (const chunk of splitText(text, TG_MAX_LEN)) {
    sent.push(await tg('sendMessage', { chat_id: chatId, text: chunk }));
  }
  return sent;
}

async function saveSentRefs(chatId, sentMessages, conversationMessageId, kind = 'text') {
  if (!conversationMessageId) return;
  for (const msg of sentMessages || []) {
    if (!msg?.message_id) continue;
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
  const emoji = TELEGRAM_REACTION_EMOJI[reactionKey];
  if (!emoji) throw new Error(`Unknown reaction key: ${reactionKey}`);
  await tg('setMessageReaction', {
    chat_id: chatId,
    message_id: messageId,
    reaction: [{ type: 'emoji', emoji }],
  });
}

async function deliverAgentResult(chatId, sourceMessageId, result) {
  if (result.delivery?.kind === 'reaction') {
    try {
      await sendReaction(chatId, sourceMessageId, result.delivery.reactionKey);
      return;
    } catch (err) {
      console.error(`Не удалось поставить реакцию в чате ${chatId}:`, err.message);
      const sent = await sendMessage(chatId, result.delivery.fallbackText || result.answer || 'Окей.');
      await saveSentRefs(chatId, sent, result.assistantMessageId, 'reaction_fallback');
      return;
    }
  }
  const sent = await sendMessage(chatId, result.answer || '(пустой ответ)');
  await saveSentRefs(chatId, sent, result.assistantMessageId, 'text');
}

// Показать индикатор «печатает…», пока агент думает над ответом.
async function sendTyping(chatId) {
  try { await tg('sendChatAction', { chat_id: chatId, action: 'typing' }); }
  catch { /* индикатор необязателен */ }
}

// Обработка служебных команд. Возвращает true, если сообщение было командой и уже обработано.
async function handleCommand(chatId, externalId, text) {
  if (text === '/start' || text === '/help') {
    let help = 'Привет! Я чат-бот с долговременной памятью. Просто пишите мне — я запоминаю важное и отвечаю '
      + 'с учётом прошлых разговоров.\n\nКоманды:\n'
      + '/domain <ключ> — сменить домен общения (например, work или personal);\n'
      + '/proactive <тип> — вручную запустить проактивный триггер (например, /proactive welcome_back).';
    if (config.proactive.enabled) {
      help += '\n\nПроактивность (бот сам пишет первым по уместному поводу):\n'
        + '/proactivity_on — включить проактивность;\n'
        + '/proactivity_off — выключить проактивность;\n'
        + '/proactivity — выбрать, по каким поводам бот может писать первым.';
    }
    await sendMessage(chatId, help);
    return true;
  }
  if (text.startsWith('/domain')) {
    const key = text.slice(7).trim() || 'general';
    chatDomains.set(chatId, key);
    await sendMessage(chatId, `Домен общения переключён на «${key}».`);
    return true;
  }
  // Команды управления проактивностью разбираются ДО общей /proactive, иначе её startsWith('/proactive')
  // перехватил бы и /proactivity_on, и /proactivity.
  if (text === '/proactivity_on') {
    if (!config.proactive.enabled) {
      await sendMessage(chatId, 'Проактивность сейчас выключена глобально администратором, включить её нельзя.');
      return true;
    }
    await setUserProactivity(externalId, true);
    await updateChatMenu(chatId, true);
    await sendMessage(chatId,
      'Проактивность включена. Пока ни один повод не активирован, поэтому бот ещё ничего сам не пришлёт. '
      + 'Откройте команду /proactivity и выберите поводы, по которым бот может писать первым.');
    return true;
  }
  if (text === '/proactivity_off') {
    await setUserProactivity(externalId, false);
    await updateChatMenu(chatId, false);
    await sendMessage(chatId, 'Проактивность выключена. Бот больше не будет писать первым.');
    return true;
  }
  if (text === '/proactivity') {
    if (!config.proactive.enabled) {
      await sendMessage(chatId, 'Проактивность сейчас выключена глобально администратором.');
      return true;
    }
    const state = await getProactivityState(externalId);
    if (!state || !state.enabled) {
      await sendMessage(chatId,
        'Проактивность у вас выключена. Сначала включите её командой /proactivity_on, затем настройте поводы.');
      return true;
    }
    await tg('sendMessage', {
      chat_id: chatId,
      text: 'Выберите поводы, по которым бот может писать первым (нажатие переключает повод):',
      reply_markup: proactivityKeyboard(state.triggers),
    });
    return true;
  }
  if (text === '/proactive' || text.startsWith('/proactive ')) {
    const type = text.slice(10).trim() || 'welcome_back';
    const r = await fireProactiveNow(externalId, type);
    if (!r.ok) {
      await sendMessage(chatId,
        `Проактивный триггер «${type}» не сработал: ${r.reason || 'сообщение не сформировано'}. `
        + 'Возможно, проактивный контур выключен или для этого чата ещё нет триггеров — сначала напишите боту.');
    }
    // При успехе сообщение уйдёт само через очередь доставки на следующем проходе воркера.
    return true;
  }
  return false;
}

// Обработка нажатия инлайн-кнопки подменю проактивности (приходит как callback_query).
// Коды callback_data: «pa:off» — выключить мастер-флаг; «pa:t:<тип>» — переключить один повод.
async function handleCallback(cq) {
  const data = cq.data || '';
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const externalId = String(chatId);
  try {
    if (data === 'pa:off') {
      await setUserProactivity(externalId, false);
      await updateChatMenu(chatId, false);
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Проактивность выключена.' });
      await tg('editMessageText', {
        chat_id: chatId, message_id: messageId,
        text: 'Проактивность выключена. Бот больше не будет писать первым. '
          + 'Чтобы снова включить — команда /proactivity_on.',
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
        chat_id: chatId, message_id: messageId,
        reply_markup: proactivityKeyboard(updated ? updated.triggers : []),
      });
      return;
    }
    // Неизвестный код — просто закрываем «часики» на кнопке, чтобы клиент не ждал.
    await tg('answerCallbackQuery', { callback_query_id: cq.id });
  } catch (err) {
    console.error(`Ошибка обработки нажатия кнопки в чате ${chatId}:`, err.message);
    try { await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Не получилось, попробуйте ещё раз.' }); }
    catch { /* «часики» закроются сами по тайм-ауту */ }
  }
}

// Обработка одного текстового сообщения пользователя.
async function handleUpdate(message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();
  if (!text) return;
  const externalId = String(chatId);

  if (text.startsWith('/') && await handleCommand(chatId, externalId, text)) return;

  const domainKey = chatDomains.get(chatId) || 'general';
  const reactionCandidate = shouldConsiderReaction(text);
  if (!reactionCandidate) await sendTyping(chatId);
  // Захватываем слот семафора на время вызова агента: индикатор «печатает…» уже показан,
  // а сам тяжёлый вызов LLM ждёт, пока освободится слот, ограничивая нагрузку на прокси.
  await acquireSlot();
  try {
    if (reactionCandidate) {
      let delivery = { kind: 'text_needed' };
      try {
        delivery = await decideDeliveryIntent({
          userMessage: text,
          deliveryCapabilities: TELEGRAM_DELIVERY_CAPABILITIES,
        });
      } catch (err) {
        console.error(`Не удалось выбрать реакцию для чата ${chatId}:`, err.message);
      }
      if (delivery.kind === 'reaction') {
        const recorded = await recordReactionTurn({ externalId, userMessage: text, domainKey, delivery });
        await deliverAgentResult(chatId, message.message_id, recorded);
        await refreshChatMenu(chatId, externalId);
        return;
      }
      await sendTyping(chatId);
    }
    const res = await handleMessage({ externalId, userMessage: text, domainKey });
    chatDomains.set(chatId, res.domainKey);                        // агент мог сменить домен по смыслу запроса
    await deliverAgentResult(chatId, message.message_id, res);
    // Меню команд зависит от мастер-флага проактивности, который мог измениться, — пересчитываем его.
    await refreshChatMenu(chatId, externalId);
  } catch (err) {
    console.error(`Ошибка обработки сообщения чата ${chatId}:`, err.message);
    await sendMessage(chatId, 'Не получилось обработать сообщение. Попробуйте ещё раз чуть позже.');
  } finally {
    releaseSlot();
  }
}

async function handleReactionUpdate(reactionUpdate) {
  const chatId = reactionUpdate.chat.id;
  const externalId = String(chatId);
  if (reactionUpdate.user?.is_bot) return;
  const newReaction = Array.isArray(reactionUpdate.new_reaction) ? reactionUpdate.new_reaction[0] : null;
  const oldReaction = Array.isArray(reactionUpdate.old_reaction) ? reactionUpdate.old_reaction[0] : null;
  const reactionKey = normalizeTelegramReaction(newReaction);
  const oldReactionKey = normalizeTelegramReaction(oldReaction);
  if (!reactionKey && !oldReactionKey) return;

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
    console.error(`Ошибка обработки реакции в чате ${chatId}:`, err.message);
  } finally {
    releaseSlot();
  }
}

// Слив очереди доставки mem.notification_outbox в Telegram.
// Получатель определяется по external_id пользователя — это идентификатор чата Telegram.
let draining = false;                                                // флаг «слив очереди уже идёт»

async function drainOutbox() {
  // Событие LISTEN/NOTIFY и страховочный таймер могут позвать слив одновременно.
  // Флаг не даёт двум проходам отправить одни и те же сообщения дважды в рамках процесса.
  if (draining) return 0;
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
      LIMIT 20`);
  for (const row of rows) {
    const chatId = Number(row.external_id);
    if (!Number.isFinite(chatId)) {
      // Пользователь не из Telegram (например, тестовый cli-user) — этот канал не для него, пропускаем.
      await query(
        `UPDATE mem.notification_outbox SET status = 'cancelled', error_text = 'recipient is not a telegram chat'
          WHERE id = $1`, [row.id]);
      continue;
    }
    try {
      const sent = await sendMessage(chatId, row.message_text);
      if (row.payload?.conversation_message_id) {
        await saveSentRefs(chatId, sent, row.payload.conversation_message_id, row.payload.kind || 'outbox');
      }
      await query(
        `UPDATE mem.notification_outbox SET status = 'sent', sent_at = now(), recipient = $2 WHERE id = $1`,
        [row.id, String(chatId)]);
    } catch (err) {
      // Откладываем повторную попытку на минуту; после 5 неудач помечаем как проваленную.
      await query(
        `UPDATE mem.notification_outbox
            SET attempts = attempts + 1,
                next_attempt_at = now() + interval '1 minute',
                error_text = $2,
                status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END
          WHERE id = $1`, [row.id, String(err.message || err)]);
      console.error(`Не удалось доставить сообщение в чат ${chatId}:`, err.message);
    }
  }
  return rows.length;
}

// --- Событийная доставка очереди через LISTEN/NOTIFY ------------------------
// Выделенное соединение-слушатель канала «outbox_new». Уведомления приходят на конкретное
// соединение, а не через пул, поэтому общий хелпер query из db.js здесь не подходит.
let outboxListener = null;                                           // активный клиент-слушатель (или null)
let listenerReconnectTimer = null;                                   // таймер запланированного переподключения

async function startOutboxListener() {
  try {
    const client = await getPool().connect();
    outboxListener = client;
    client.on('notification', () => {
      // Пришло уведомление о новой записи — опустошаем очередь немедленно.
      drainOutbox().catch((e) => console.error('Ошибка событийного слива очереди доставки:', e.message));
    });
    client.on('error', (e) => {
      console.error('Ошибка соединения-слушателя очереди доставки:', e.message);
      scheduleListenerReconnect();                                   // соединение разорвано — переоткрываем
    });
    await client.query('LISTEN outbox_new');
    // Уведомления не переживают обрыв соединения: сразу после подписки один раз опустошаем очередь,
    // чтобы забрать всё, что накопилось за время запуска или простоя слушателя.
    await drainOutbox();
  } catch (err) {
    console.error('Не удалось запустить слушатель очереди доставки:', err.message);
    scheduleListenerReconnect();
  }
}

function scheduleListenerReconnect() {
  if (listenerReconnectTimer || !running) return;                    // переподключение уже запланировано или идёт остановка
  // Освобождаем отвалившееся соединение с уничтожением, чтобы не копить «висящих» клиентов в пуле.
  if (outboxListener) {
    try { outboxListener.release(true); } catch { /* соединение уже разорвано */ }
    outboxListener = null;
  }
  listenerReconnectTimer = setTimeout(() => {
    listenerReconnectTimer = null;
    if (running) startOutboxListener();
  }, 3000);                                                          // небольшая пауза перед повторной попыткой
}

// Фоновый цикл: планировщик задач, проактивный контур и страховочная доставка из очереди в Telegram.
async function workerLoop() {
  let lastSafetyDrainAt = 0;
  while (running) {
    try {
      await tick();                                                 // выполнить просроченные задачи (напоминания и т.п.)

      if (config.proactive.enabled && Date.now() - lastProactiveAt >= config.proactive.intervalMs) {
        lastProactiveAt = Date.now();
        await checkProactiveTriggers();
        if (config.proactive.events.enabled) await processEvents();
      }

      // Страховочный слив: основная доставка событийная (LISTEN/NOTIFY), а этот редкий проход
      // гарантирует отправку даже при пропущенном уведомлении или после простоя слушателя.
      if (Date.now() - lastSafetyDrainAt >= OUTBOX_SAFETY_INTERVAL_MS) {
        lastSafetyDrainAt = Date.now();
        await drainOutbox();
      }
    } catch (err) {
      console.error('Ошибка фонового прохода воркера:', err.message);
    }
    await new Promise((res) => setTimeout(res, WORKER_INTERVAL_MS));
  }
}

// Цикл длинного опроса входящих сообщений.
async function pollLoop() {
  let offset = 0;
  while (running) {
    let updates;
    try {
      updates = await tg('getUpdates', {
        offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ['message', 'callback_query', 'message_reaction'],
      });
    } catch (err) {
      console.error('Ошибка длинного опроса getUpdates:', err.message);
      await new Promise((res) => setTimeout(res, 3000));            // пауза перед повтором после сбоя сети
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;                                // подтверждаем обработку, чтобы не получить повтор
      // Не ждём обработку: ставим сообщение в цепочку его чата и сразу продолжаем опрос.
      // Разные чаты обрабатываются параллельно, внутри чата — строго по порядку.
      if (update.message) enqueueUpdate(update.message);
      else if (update.message_reaction) enqueueReactionUpdate(update.message_reaction);
      // Нажатия инлайн-кнопок обрабатываем сразу (без вызова LLM и без семафора): это лёгкие операции
      // с базой и перерисовкой клавиатуры. Ошибку только логируем, чтобы не оборвать опрос.
      else if (update.callback_query) {
        handleCallback(update.callback_query)
          .catch((e) => console.error('Ошибка обработки callback_query:', e.message));
      }
    }
  }
}

async function main() {
  const me = await tg('getMe', {});                                 // заодно проверяем валидность токена
  // Регистрируем глобальное меню команд как запасной набор по умолчанию (для чатов без своего меню).
  // При глобально включённой проактивности это базовые команды плюс /proactivity_on; иначе — только базовые.
  // Меню конкретного чата уточняется динамически в updateChatMenu/refreshChatMenu. Сбой не критичен.
  try { await tg('setMyCommands', { commands: buildCommands(false) }); }
  catch (err) { console.error('Не удалось зарегистрировать меню команд:', err.message); }
  console.log(`Telegram-бот @${me.username} запущен. Длинный опрос активен.`,
    config.proactive.enabled ? 'Проактивный контур включён.' : 'Проактивный контур выключен.');
  await startOutboxListener();                                       // событийная доставка очереди (LISTEN/NOTIFY)
  await Promise.all([pollLoop(), workerLoop()]);
}

// Аккуратное завершение по Ctrl+C: останавливаем циклы и закрываем пул соединений с БД.
async function shutdown() {
  console.log('\nЗавершение работы Telegram-бота…');
  running = false;
  if (listenerReconnectTimer) { clearTimeout(listenerReconnectTimer); listenerReconnectTimer = null; }
  if (outboxListener) {
    try { outboxListener.release(true); } catch { /* соединение уже разорвано */ }
    outboxListener = null;
  }
  try { await closePool(); } catch { /* пул мог быть не открыт */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('Критическая ошибка запуска Telegram-бота:', err.message);
  process.exit(1);
});
