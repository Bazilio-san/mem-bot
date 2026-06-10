// Тесты REST API заметок (src/server/notes-api.js): авторизация по widget-токену и по initData
// Telegram Mini App, CRUD с восстановлением, запись мета-событий в историю диалога, изоляция
// пользователей. Поднимается реальный express-роутер на эфемерном порту; БД реальная; эмбеддинги
// подменяются заглушкой. Запуск: npm run test:notes-api.
import assert from 'node:assert/strict';
import express from 'express';
import { config } from '../src/config.js';
import { query, closePool } from '../src/db.js';
import { ensureUser, ensureConversation } from '../src/repo.js';
import { __setEmbedForTests } from '../src/notes/store.js';
import { issueWidgetToken, verifyWidgetToken } from '../src/notes/widget-token.js';
import { validateTelegramInitData, buildSignedInitData } from '../src/notes/telegram-init-data.js';
import { createNotesApi } from '../src/server/notes-api.js';

__setEmbedForTests(async () => null); // эмбеддинги в этих тестах не нужны — REST-слой их не касается

async function freshUser(extId) {
  await query('DELETE FROM mem.users WHERE external_id = $1', [extId]);
  return ensureUser(extId);
}

const u = await freshUser('notes-api-test-main');
const stranger = await freshUser('notes-api-test-stranger');
const conv = await ensureConversation(u.id, 'general');

// Поднимаем минимальное приложение с роутером заметок на эфемерном порту.
const app = express();
app.use(express.json());
app.use('/api/notes', createNotesApi());
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}/api/notes`;

const token = issueWidgetToken({ userId: u.id, conversationId: conv.id });
const strangerToken = issueWidgetToken({ userId: stranger.id });

async function call(method, path, { body, headers = {} } = {}) {
  const options = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, options);
  return { status: res.status, json: await res.json().catch(() => null) };
}
const authed = (method, path, opts = {}) =>
  call(method, path, { ...opts, headers: { Authorization: `Bearer ${token}`, ...opts.headers } });

// ---- 1. Авторизация ------------------------------------------------------------
assert.equal((await call('GET', '/')).status, 401, 'без авторизации — 401');
assert.equal((await call('GET', '/', { headers: { Authorization: 'Bearer garbage-token' } })).status, 401);

// Просроченный токен отклоняется.
const expired = issueWidgetToken({ userId: u.id, ttlHours: -1 });
assert.equal((await call('GET', '/', { headers: { Authorization: `Bearer ${expired}` } })).status, 401);
assert.equal(verifyWidgetToken(expired), null);
assert.ok(verifyWidgetToken(token), 'живой токен проходит проверку');

// ---- 2. CRUD через токен ---------------------------------------------------------
const createRes = await authed('POST', '/', { body: { title: 'Покупки', body: 'Купить молоко', tags: ['Дом'] } });
assert.equal(createRes.status, 201);
const noteId = createRes.json.note.id;
assert.equal(createRes.json.note.title, 'Покупки');
assert.deepEqual(createRes.json.note.tags, ['дом'], 'теги нормализованы');

// Валидация: пустое тело — 400 с понятным сообщением.
const badCreate = await authed('POST', '/', { body: { body: '   ' } });
assert.equal(badCreate.status, 400);
assert.match(badCreate.json.error, /не может быть пустым/);

const getRes = await authed('GET', `/${noteId}`);
assert.equal(getRes.status, 200);
assert.equal(getRes.json.note.body, 'Купить молоко');

const patchRes = await authed('PATCH', `/${noteId}`, { body: { body: 'Купить молоко и хлеб', pinned: true } });
assert.equal(patchRes.status, 200);
assert.deepEqual(patchRes.json.changed.sort(), ['body', 'pinned']);

const listRes = await authed('GET', '/?limit=10');
assert.equal(listRes.status, 200);
assert.equal(listRes.json.total, 1);
assert.equal(String(listRes.json.items[0].id), String(noteId));

// ---- 3. Изоляция: чужой токен не видит и не трогает заметку ----------------------
const strangerGet = await call('GET', `/${noteId}`, { headers: { Authorization: `Bearer ${strangerToken}` } });
assert.equal(strangerGet.status, 404);
const strangerDel = await call('DELETE', `/${noteId}`, { headers: { Authorization: `Bearer ${strangerToken}` } });
assert.equal(strangerDel.status, 404);

// ---- 4. Удаление и восстановление -------------------------------------------------
assert.equal((await authed('DELETE', `/${noteId}`)).status, 200);
assert.equal((await authed('GET', `/${noteId}`)).status, 404, 'удалённая заметка не читается');
const restoreRes = await authed('POST', `/${noteId}/restore`);
assert.equal(restoreRes.status, 200);
assert.equal((await authed('GET', `/${noteId}`)).status, 200, 'после restore заметка вернулась');
assert.equal((await authed('POST', `/${noteId}/restore`)).status, 404, 'повторный restore — 404');

// ---- 5. Мета-события в истории диалога ---------------------------------------------
const { rows: events } = await query(
  `SELECT content, metadata FROM mem.conversation_messages
   WHERE conversation_id = $1 AND role = 'system' AND metadata->>'source' = 'notes_widget'
   ORDER BY created_at`,
  [conv.id],
);
const actions = events.map((e) => e.metadata.action);
assert.deepEqual(actions, ['create', 'update', 'delete', 'restore'], 'все четыре события записаны по порядку');
assert.match(events[0].content, /создал заметку #\d+ «Покупки»/);
assert.match(events[1].content, /изменено — текст, закрепление/);
assert.ok(events.every((e) => e.metadata.note_id === Number(noteId)));

// ---- 6. Авторизация Telegram Mini App (initData) ------------------------------------
const savedTgKey = config.telegram.apiKey;
config.telegram.apiKey = '12345:TEST-BOT-TOKEN';
const tgUser = await freshUser('314159265'); // external_id = telegram id
const initData = buildSignedInitData({ user: { id: 314159265, first_name: 'Тест' }, botToken: config.telegram.apiKey });

// Юнит-проверки валидатора: подпись, чужой токен, протухший auth_date.
assert.ok(validateTelegramInitData(initData, config.telegram.apiKey));
assert.equal(validateTelegramInitData(initData, 'другой:токен'), null, 'подпись чужим токеном не проходит');
const stale = buildSignedInitData({
  user: { id: 314159265 },
  botToken: config.telegram.apiKey,
  authDate: Math.floor(Date.now() / 1000) - 100_000,
});
assert.equal(validateTelegramInitData(stale, config.telegram.apiKey), null, 'старый auth_date отклоняется');

// Через API: создание заметки от имени Telegram-пользователя.
const tgCreate = await call('POST', '/', {
  body: { body: 'Заметка из Mini App' },
  headers: { 'X-Tg-Init-Data': initData },
});
assert.equal(tgCreate.status, 201);
const { rows: tgNotes } = await query('SELECT user_id FROM mem.notes WHERE id = $1', [tgCreate.json.note.id]);
assert.equal(tgNotes[0].user_id, tgUser.id, 'заметка привязана к пользователю по external_id');

// Неизвестный Telegram-пользователь (нет в mem.users) получает 401.
const ghostInit = buildSignedInitData({ user: { id: 999999999001 }, botToken: config.telegram.apiKey });
assert.equal((await call('GET', '/', { headers: { 'X-Tg-Init-Data': ghostInit } })).status, 401);

// Мета-событие Mini App ушло в активный диалог пользователя (создан автоматически).
const { rows: tgEvents } = await query(
  `SELECT content FROM mem.conversation_messages
   WHERE user_id = $1 AND role = 'system' AND metadata->>'source' = 'notes_widget'`,
  [tgUser.id],
);
assert.equal(tgEvents.length, 1);
assert.match(tgEvents[0].content, /создал заметку/);

config.telegram.apiKey = savedTgKey;

// ---- 7. Флаг notes.enabled ----------------------------------------------------------
config.notes.enabled = false;
assert.equal((await authed('GET', '/')).status, 503, 'выключенный инструментарий отвечает 503');
config.notes.enabled = true;

__setEmbedForTests(null);
await new Promise((resolve) => server.close(resolve));
await closePool();
console.log('notes-api.test.mjs: ok');
