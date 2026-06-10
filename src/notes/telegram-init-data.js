// Validation of Telegram Mini App initData (the standard algorithm from the Bot API documentation:
// secret_key = HMAC_SHA256(key="WebAppData", message=bot_token); the "hash" field of initData must equal
// hex(HMAC_SHA256(key=secret_key, message=data_check_string)), where data_check_string is all key=value
// pairs except hash, sorted by key and joined with \n). On success returns the parsed "user" object and
// auth_date; any deviation (bad signature, stale auth_date, missing fields) returns null.
import crypto from 'node:crypto';

const DEFAULT_MAX_AGE_SECONDS = 24 * 3600;

export function validateTelegramInitData(initData, botToken, { maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS } = {}) {
  if (!initData || !botToken) {
    return null;
  }
  let params;
  try {
    params = new URLSearchParams(String(initData));
  } catch {
    return null;
  }
  const hash = params.get('hash');
  if (!hash) {
    return null;
  }
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const a = Buffer.from(hash);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) {
    return null;
  }

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return null;
  }
  if (!user?.id) {
    return null;
  }
  return { user, authDate };
}

// Helper for tests and tooling: build a correctly signed initData string for the given bot token.
export function buildSignedInitData({ user, botToken, authDate = Math.floor(Date.now() / 1000) }) {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(user));
  params.set('auth_date', String(authDate));
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}
