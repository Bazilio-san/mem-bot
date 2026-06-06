// Telegram-адаптер: подключает чат-бота с долговременной памятью к Telegram Bot API.
// Входящие сообщения принимаются через длинный опрос (long polling, метод getUpdates),
// ответы агента и проактивные сообщения уходят пользователю методом sendMessage.
// Внешним идентификатором пользователя (external_id) служит идентификатор чата Telegram —
// благодаря этому проактивные сообщения из очереди доставки находят нужный чат.
// Запуск: npm run telegram
import { config } from './config.js';
import { handleMessage } from './agent.js';
import { tick } from './pipeline/scheduler.js';
import { checkProactiveTriggers } from './pipeline/proactive.js';
import { processEvents } from './pipeline/events.js';
import { fireProactiveNow } from './pipeline/proactive.js';
import { query, closePool } from './db.js';

const TOKEN = process.env.TELEGRAM_API_KEY;
if (!TOKEN) {
  console.error('Не задана переменная окружения TELEGRAM_API_KEY — токен Telegram-бота. Запуск невозможен.');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;
const POLL_TIMEOUT_SEC = 30;                                         // длительность одного длинного опроса
const WORKER_INTERVAL_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 5000);
const TG_MAX_LEN = 4000;                                            // запас под лимит Telegram в 4096 символов

// Память процесса: выбранный домен общения для каждого чата (по умолчанию «general»).
const chatDomains = new Map();
let lastProactiveAt = 0;
let running = true;

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
  for (const chunk of splitText(text, TG_MAX_LEN)) {
    await tg('sendMessage', { chat_id: chatId, text: chunk });
  }
}

// Показать индикатор «печатает…», пока агент думает над ответом.
async function sendTyping(chatId) {
  try { await tg('sendChatAction', { chat_id: chatId, action: 'typing' }); }
  catch { /* индикатор необязателен */ }
}

// Обработка служебных команд. Возвращает true, если сообщение было командой и уже обработано.
async function handleCommand(chatId, externalId, text) {
  if (text === '/start' || text === '/help') {
    await sendMessage(chatId,
      'Привет! Я чат-бот с долговременной памятью. Просто пишите мне — я запоминаю важное и отвечаю с учётом '
      + 'прошлых разговоров.\n\nКоманды:\n'
      + '/domain <ключ> — сменить домен общения (например, work или personal);\n'
      + '/proactive <тип> — вручную запустить проактивный триггер (например, /proactive welcome_back).');
    return true;
  }
  if (text.startsWith('/domain')) {
    const key = text.slice(7).trim() || 'general';
    chatDomains.set(chatId, key);
    await sendMessage(chatId, `Домен общения переключён на «${key}».`);
    return true;
  }
  if (text.startsWith('/proactive')) {
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

// Обработка одного текстового сообщения пользователя.
async function handleUpdate(message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();
  if (!text) return;
  const externalId = String(chatId);

  if (text.startsWith('/') && await handleCommand(chatId, externalId, text)) return;

  const domainKey = chatDomains.get(chatId) || 'general';
  await sendTyping(chatId);
  try {
    const res = await handleMessage({ externalId, userMessage: text, domainKey });
    chatDomains.set(chatId, res.domainKey);                        // агент мог сменить домен по смыслу запроса
    await sendMessage(chatId, res.answer || '(пустой ответ)');
  } catch (err) {
    console.error(`Ошибка обработки сообщения чата ${chatId}:`, err.message);
    await sendMessage(chatId, 'Не получилось обработать сообщение. Попробуйте ещё раз чуть позже.');
  }
}

// Слив очереди доставки mem.notification_outbox в Telegram.
// Получатель определяется по external_id пользователя — это идентификатор чата Telegram.
async function drainOutbox() {
  const { rows } = await query(
    `SELECT o.id, o.message_text, u.external_id
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
      await sendMessage(chatId, row.message_text);
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

// Фоновый цикл: планировщик задач, проактивный контур и доставка из очереди в Telegram.
async function workerLoop() {
  while (running) {
    try {
      await tick();                                                 // выполнить просроченные задачи (напоминания и т.п.)

      if (config.proactive.enabled && Date.now() - lastProactiveAt >= config.proactive.intervalMs) {
        lastProactiveAt = Date.now();
        await checkProactiveTriggers();
        if (config.proactive.events.enabled) await processEvents();
      }

      await drainOutbox();                                          // отправить накопившиеся уведомления наружу
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
      updates = await tg('getUpdates', { offset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ['message'] });
    } catch (err) {
      console.error('Ошибка длинного опроса getUpdates:', err.message);
      await new Promise((res) => setTimeout(res, 3000));            // пауза перед повтором после сбоя сети
      continue;
    }
    for (const update of updates) {
      offset = update.update_id + 1;                                // подтверждаем обработку, чтобы не получить повтор
      if (update.message) await handleUpdate(update.message);
    }
  }
}

async function main() {
  const me = await tg('getMe', {});                                 // заодно проверяем валидность токена
  console.log(`Telegram-бот @${me.username} запущен. Длинный опрос активен.`,
    config.proactive.enabled ? 'Проактивный контур включён.' : 'Проактивный контур выключен.');
  await Promise.all([pollLoop(), workerLoop()]);
}

// Аккуратное завершение по Ctrl+C: останавливаем циклы и закрываем пул соединений с БД.
async function shutdown() {
  console.log('\nЗавершение работы Telegram-бота…');
  running = false;
  try { await closePool(); } catch { /* пул мог быть не открыт */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  console.error('Критическая ошибка запуска Telegram-бота:', err.message);
  process.exit(1);
});
