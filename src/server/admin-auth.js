// Admin panel authorization: sign-in through the official Telegram Login Widget, session — a
// self-contained HMAC cookie. Only users with mem.users.is_admin = true may enter; identity comes from
// Telegram (the widget payload is signed with the bot token), so no passwords are stored anywhere.
//
// When authorization is required: config.admin.auth.enabled === true forces it, === false disables it,
// null (the default) means "automatic" — required whenever admin.host is not a loopback address. This
// preserves the local development workflow (localhost needs no login) while a publicly bound admin
// server demands a session.
//
// The session token is the same self-contained HMAC scheme as the notes widget token, but with an
// explicit audience field aud='admin', so the two token kinds are never interchangeable.
import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { query } from '../db.js';

export const SESSION_COOKIE = 'mb_admin_session';
const LOGIN_MAX_AGE_SECONDS = 24 * 3600; // freshness window of the Login Widget auth_date

// ---- Telegram Login Widget validation ----------------------------------------
// Unlike Mini App initData (secret = HMAC_SHA256(key="WebAppData", bot_token)), the Login Widget uses
// secret_key = SHA256(bot_token); the data-check-string is all fields except hash, sorted, joined by \n.

export function validateTelegramLoginData(data, botToken, { maxAgeSeconds = LOGIN_MAX_AGE_SECONDS } = {}) {
  if (!data || typeof data !== 'object' || !data.hash || !botToken) {
    return null;
  }
  const { hash, ...fields } = data;
  const dataCheckString = Object.keys(fields)
    .filter((k) => fields[k] !== undefined && fields[k] !== null)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const a = Buffer.from(String(hash));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }
  const authDate = Number(data.auth_date || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) {
    return null;
  }
  if (!data.id) {
    return null;
  }
  return { id: data.id, firstName: data.first_name || '', username: data.username || '' };
}

// Helper for tests and tooling: build a correctly signed Login Widget payload for a given bot token.
export function buildSignedLoginData({ user, botToken, authDate = Math.floor(Date.now() / 1000) }) {
  const fields = { ...user, auth_date: authDate };
  const dataCheckString = Object.keys(fields)
    .filter((k) => fields[k] !== undefined && fields[k] !== null)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');
  const secretKey = crypto.createHash('sha256').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return { ...fields, hash };
}

// ---- Session token (HMAC cookie) ----------------------------------------------

function sign(body) {
  return crypto.createHmac('sha256', config.authSecret).update(body).digest('base64url');
}

export function issueAdminSession({ userId, displayName = '', ttlHours = null }) {
  const ttl = ttlHours ?? config.admin.auth?.sessionTtlHours ?? 168;
  const payload = { u: userId, n: displayName, aud: 'admin', exp: Date.now() + ttl * 3_600_000 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

// Returns { userId, displayName } or null. The aud check keeps notes widget tokens (and any other
// HMAC tokens of the project) from being accepted as an admin session.
export function verifyAdminSession(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [body, sig] = parts;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(body));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload?.aud !== 'admin' || !payload.u || typeof payload.exp !== 'number' || payload.exp < Date.now()) {
    return null;
  }
  return { userId: payload.u, displayName: payload.n || '' };
}

// ---- Auth requirement and middleware -------------------------------------------

export function isAdminAuthRequired() {
  const flag = config.admin.auth?.enabled;
  if (flag === true) {
    return true;
  }
  if (flag === false) {
    return false;
  }
  const host = String(config.admin.host || '').toLowerCase();
  return !(host === 'localhost' || host === '127.0.0.1' || host === '::1');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return out;
}

function sessionFromRequest(req) {
  return verifyAdminSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

// Express middleware guarding the admin API. Passes through entirely when auth is not required.
export function requireAdminSession(req, res, next) {
  if (!isAdminAuthRequired()) {
    return next();
  }
  const session = sessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Требуется вход в админку через Telegram.' });
  }
  req.adminSession = session;
  next();
}

// ---- Rate limiting of login attempts --------------------------------------------
// In-memory sliding window: at most LIMIT attempts per WINDOW per client address. Enough against
// signature brute force for a single-process server; resets on restart by design.

const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 5 * 60_000;
const loginAttempts = new Map(); // addr -> array of timestamps

function rateLimited(addr) {
  const now = Date.now();
  const recent = (loginAttempts.get(addr) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  loginAttempts.set(addr, recent);
  if (loginAttempts.size > 10_000) {
    loginAttempts.clear(); // safety valve against memory growth from address spoofing
  }
  return recent.length > RATE_LIMIT;
}

// ---- Routes: /api/auth/* ----------------------------------------------------------

function setSessionCookie(req, res, token) {
  const ttlHours = config.admin.auth?.sessionTtlHours ?? 168;
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: ttlHours * 3_600_000,
    path: '/',
  });
}

export function createAuthApi() {
  const router = express.Router();

  // Session status for the frontend gate. Also tells the login screen which bot to embed in the
  // Telegram Login Widget (the widget needs the bot username, config.telegram.botUsername).
  router.get('/me', (req, res) => {
    const authRequired = isAdminAuthRequired();
    const session = authRequired ? sessionFromRequest(req) : null;
    res.json({
      authRequired,
      authenticated: !authRequired || Boolean(session),
      displayName: session?.displayName || null,
      botUsername: config.telegram.botUsername || null,
    });
  });

  // Sign-in: the body is the payload of the Telegram Login Widget onauth callback.
  router.post('/telegram', async (req, res) => {
    try {
      const addr = req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
      if (rateLimited(String(addr))) {
        return res.status(429).json({ error: 'Слишком много попыток входа. Подождите несколько минут.' });
      }
      const login = validateTelegramLoginData(req.body, config.telegram.apiKey);
      if (!login) {
        return res.status(401).json({ error: 'Подпись Telegram не подтверждена или данные устарели.' });
      }
      const { rows } = await query('SELECT id, display_name, is_admin FROM mem.users WHERE external_id = $1', [
        String(login.id),
      ]);
      const user = rows[0];
      if (!user || user.is_admin !== true) {
        return res.status(403).json({ error: 'Доступ в админку разрешён только администраторам бота.' });
      }
      const displayName = user.display_name || login.firstName || String(login.id);
      setSessionCookie(req, res, issueAdminSession({ userId: user.id, displayName }));
      res.json({ ok: true, displayName });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.post('/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  return router;
}
