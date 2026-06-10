// Short-lived HMAC token of the notes widget. Issued by the notes_show_widget tool, sent by the widget
// in the Authorization header on every REST call. Self-contained (userId + conversationId + expiry inside,
// signature over the payload), so no session table is needed. The signing secret is config.notes.widgetSecret
// with config.authSecret as the fallback, mirroring how other secrets default in this project.
import crypto from 'node:crypto';
import { config } from '../config.js';

function signingSecret() {
  return config.notes.widgetSecret || config.authSecret;
}

function sign(body) {
  return crypto.createHmac('sha256', signingSecret()).update(body).digest('base64url');
}

// Issue a token for the given user. conversationId binds widget CRUD meta-events to the dialog the
// widget was shown in; it may be null (Mini App resolves the active conversation itself).
// The audience field (aud) makes token kinds non-interchangeable: the admin session cookie is signed
// with the same fallback secret (authSecret), and without aud one token kind would validate as the other.
export function issueWidgetToken({ userId, conversationId = null, ttlHours = null }) {
  const ttl = ttlHours ?? config.notes.widgetTokenTtlHours ?? 24;
  const payload = { u: userId, c: conversationId, aud: 'notes-widget', exp: Date.now() + ttl * 3_600_000 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${sign(body)}`;
}

// Verify a token. Returns { userId, conversationId } or null (broken format, bad signature, expired).
export function verifyWidgetToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [body, sig] = parts;
  const expected = sign(body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload?.aud !== 'notes-widget' || !payload.u || typeof payload.exp !== 'number' || payload.exp < Date.now()) {
    return null;
  }
  return { userId: payload.u, conversationId: payload.c || null };
}
