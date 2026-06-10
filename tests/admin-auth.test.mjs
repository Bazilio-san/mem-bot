// Тесты авторизации админки (src/server/admin-auth.js): валидация подписи Telegram Login Widget,
// сессионный HMAC-токен (включая невзаимозаменяемость с widget-токеном заметок), правило «когда вход
// обязателен», и интеграция: вход → cookie → доступ к защищённому API, 401/403/429, выход.
// Запуск: npm run test:admin-auth.
import assert from 'node:assert/strict';
import express from 'express';
import { config } from '../src/config.js';
import { query, closePool } from '../src/db.js';
import { ensureUser } from '../src/repo.js';
import { issueWidgetToken, verifyWidgetToken } from '../src/notes/widget-token.js';
import {
  validateTelegramLoginData,
  buildSignedLoginData,
  issueAdminSession,
  verifyAdminSession,
  isAdminAuthRequired,
  requireAdminSession,
  createAuthApi,
  SESSION_COOKIE,
} from '../src/server/admin-auth.js';

const savedTgKey = config.telegram.apiKey;
const savedAuth = { ...config.admin.auth };
const savedHost = config.admin.host;
config.telegram.apiKey = '777000:ADMIN-AUTH-TEST-TOKEN';

// ---- 1. Валидация подписи Login Widget -----------------------------------------
{
  const data = buildSignedLoginData({ user: { id: 314159, first_name: 'Админ' }, botToken: config.telegram.apiKey });
  const ok = validateTelegramLoginData(data, config.telegram.apiKey);
  assert.equal(ok.id, 314159);
  assert.equal(ok.firstName, 'Админ');

  assert.equal(validateTelegramLoginData(data, 'другой:токен'), null, 'подпись чужим токеном не проходит');
  assert.equal(
    validateTelegramLoginData({ ...data, first_name: 'Хакер' }, config.telegram.apiKey),
    null,
    'подмена поля ломает подпись',
  );

  const stale = buildSignedLoginData({
    user: { id: 314159 },
    botToken: config.telegram.apiKey,
    authDate: Math.floor(Date.now() / 1000) - 100_000,
  });
  assert.equal(validateTelegramLoginData(stale, config.telegram.apiKey), null, 'старый auth_date отклоняется');
}

// ---- 2. Сессионный токен ----------------------------------------------------------
{
  const token = issueAdminSession({ userId: 'u-1', displayName: 'Слава' });
  const session = verifyAdminSession(token);
  assert.equal(session.userId, 'u-1');
  assert.equal(session.displayName, 'Слава');

  assert.equal(verifyAdminSession(issueAdminSession({ userId: 'u-1', ttlHours: -1 })), null, 'просроченный — null');
  const [body] = token.split('.');
  assert.equal(verifyAdminSession(`${body}.bad-signature`), null, 'битая подпись — null');

  // Токены разных аудиторий не взаимозаменяемы: widget-токен заметок не открывает админку и наоборот.
  const widgetToken = issueWidgetToken({ userId: 'u-1' });
  assert.equal(verifyAdminSession(widgetToken), null, 'widget-токен не является админ-сессией');
  assert.equal(verifyWidgetToken(token), null, 'админ-сессия не является widget-токеном');
}

// ---- 3. Когда вход обязателен -------------------------------------------------------
{
  config.admin.auth.enabled = true;
  assert.equal(isAdminAuthRequired(), true, 'enabled=true — вход всегда обязателен');
  config.admin.auth.enabled = false;
  assert.equal(isAdminAuthRequired(), false, 'enabled=false — вход выключен');
  config.admin.auth.enabled = null;
  config.admin.host = 'localhost';
  assert.equal(isAdminAuthRequired(), false, 'auto: localhost — вход не нужен');
  config.admin.host = '0.0.0.0';
  assert.equal(isAdminAuthRequired(), true, 'auto: внешний адрес — вход обязателен');
  config.admin.host = savedHost;
}

// ---- 4. Интеграция: вход → cookie → защищённый API ----------------------------------
config.admin.auth.enabled = true;

async function freshUser(extId) {
  await query('DELETE FROM mem.users WHERE external_id = $1', [extId]);
  return ensureUser(extId);
}
// external_id админки — это Telegram id, поэтому тестовые пользователи создаются с числовыми id.

const app = express();
app.use(express.json());
app.use('/api/auth', createAuthApi());
app.use('/api', requireAdminSession, (req, res) => res.json({ secret: 'data', who: req.adminSession?.displayName }));
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = `http://127.0.0.1:${server.address().port}`;

const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

// Без сессии защищённый API закрыт, а /auth/me честно сообщает статус.
assert.equal((await fetch(`${base}/api/users`)).status, 401);
const meAnon = await (await fetch(`${base}/api/auth/me`)).json();
assert.deepEqual([meAnon.authRequired, meAnon.authenticated], [true, false]);

// Не-администратор с валидной подписью получает 403.
await freshUser('555001');
const res403 = await post(
  '/api/auth/telegram',
  buildSignedLoginData({
    user: { id: 555001, first_name: 'Юзер' },
    botToken: config.telegram.apiKey,
  }),
);
assert.equal(res403.status, 403, 'не-админ не входит');

// Битая подпись — 401.
const badSig = buildSignedLoginData({ user: { id: 555002 }, botToken: 'другой:токен' });
assert.equal((await post('/api/auth/telegram', badSig)).status, 401);

// Администратор входит, получает cookie, защищённый API открывается.
const adminNumeric = await freshUser('555003');
await query('UPDATE mem.users SET is_admin = true, display_name = $2 WHERE id = $1', [adminNumeric.id, 'Слава']);
const loginRes = await post(
  '/api/auth/telegram',
  buildSignedLoginData({
    user: { id: 555003, first_name: 'Слава' },
    botToken: config.telegram.apiKey,
  }),
);
assert.equal(loginRes.status, 200);
const setCookie = loginRes.headers.get('set-cookie') || '';
assert.ok(setCookie.includes(`${SESSION_COOKIE}=`), 'выставлена сессионная cookie');
assert.match(setCookie, /HttpOnly/i, 'cookie недоступна из JS');
const cookie = setCookie.split(';')[0];

const protectedRes = await fetch(`${base}/api/users`, { headers: { Cookie: cookie } });
assert.equal(protectedRes.status, 200);
assert.equal((await protectedRes.json()).who, 'Слава', 'middleware кладёт сессию в req.adminSession');

const meAuthed = await (await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } })).json();
assert.deepEqual([meAuthed.authRequired, meAuthed.authenticated, meAuthed.displayName], [true, true, 'Слава']);

// Выход: cookie очищается (повторный запрос со старой cookie всё ещё валиден до истечения — токен
// самодостаточный, это осознанное свойство схемы; «выход» — это удаление cookie на клиенте).
const logoutRes = await post('/api/auth/logout', {}, { Cookie: cookie });
assert.equal(logoutRes.status, 200);
assert.match(logoutRes.headers.get('set-cookie') || '', new RegExp(`${SESSION_COOKIE}=;`), 'cookie стёрта');

// ---- 5. Rate limit: после 10 попыток — 429 -------------------------------------------
{
  let last = 0;
  for (let i = 0; i < 12; i++) {
    last = (await post('/api/auth/telegram', { id: 1, hash: 'x', auth_date: 1 })).status;
  }
  assert.equal(last, 429, 'перебор подписей упирается в лимит попыток');
}

// ---- 6. enabled=false: API открыт без сессии -------------------------------------------
config.admin.auth.enabled = false;
assert.equal((await fetch(`${base}/api/users`)).status, 200, 'без авторизации API доступен (локальный режим)');

config.admin.auth.enabled = savedAuth.enabled;
config.admin.auth.sessionTtlHours = savedAuth.sessionTtlHours;
config.telegram.apiKey = savedTgKey;
await new Promise((resolve) => server.close(resolve));
await closePool();
console.log('admin-auth.test.mjs: ok');
