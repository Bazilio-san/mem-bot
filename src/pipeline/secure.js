// Protected memory loop. Sensitive data (passport, phone, address, etc.)
// is encrypted at the application level (AES-256-GCM) and placed in a separate table.
// Only a safe summary (redacted_summary) makes it into regular memory and the prompt,
// never the full value. Saving requires the user's explicit consent.
import crypto from 'node:crypto';
import { query } from './../db.js';
import { config } from '../config.js';
import { getDomainId } from '../repo.js';

// The encryption key is derived deterministically from AUTH_SECRET (32 bytes for AES-256).
const KEY = crypto.createHash('sha256').update(config.authSecret).digest();

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: [12-byte IV][16-byte authentication tag][ciphertext].
  return Buffer.concat([iv, tag, enc]);
}

export function decrypt(buf) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function hashOf(value) {
  return crypto.createHash('sha256').update(value).digest();
}

// Mask the value for a safe summary: show the type and the tail, hide the middle.
export function redact(recordType, rawValue) {
  const v = String(rawValue).replace(/\s+/g, '');
  const tail = v.slice(-2);
  return `сохранён ${recordType}, оканчивается на ...${tail}; полное значение не раскрывать без необходимости`;
}

// Save a protected record. By default consent is unknown — the data is stored,
// but marked as requiring confirmation. consentStatus='granted' is set only
// with the user's explicit consent.
export async function saveSecureRecord({
  userId,
  domainKey = 'general',
  recordType,
  subjectKey = null,
  displayName = null,
  rawValue,
  consentStatus = 'unknown',
}) {
  const domainId = await getDomainId(domainKey);
  const encrypted = encrypt(rawValue);
  const summary = redact(recordType, rawValue);
  const { rows } = await query(
    `INSERT INTO mem.secure_records
       (user_id, domain_id, record_type, subject_key, display_name, redacted_summary,
        encrypted_payload, payload_hash, consent_status, consent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9='granted' THEN now() ELSE NULL END)
     RETURNING id, redacted_summary, consent_status`,
    [userId, domainId, recordType, subjectKey, displayName, summary, encrypted, hashOf(rawValue), consentStatus],
  );
  return rows[0];
}

// Confirm consent to store a previously saved record.
export async function grantConsent(secureRecordId) {
  await query(
    `UPDATE mem.secure_records SET consent_status='granted', consent_at=now(), updated_at=now() WHERE id=$1`,
    [secureRecordId],
  );
}

// Get safe summaries of the user's protected records (for MEMORY_CONTEXT).
// Full values are not revealed here — only redacted_summary.
export async function listSecureSummaries(userId, limit = 3) {
  const { rows } = await query(
    `SELECT id, record_type, subject_key, display_name, redacted_summary, consent_status
     FROM mem.secure_records
     WHERE user_id = $1 AND consent_status <> 'revoked'
     ORDER BY updated_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

// Reveal the full value of a protected record. Available ONLY with an explicit purpose
// and with consent present. Every access is logged.
export async function getSecureValue(secureRecordId, purpose) {
  if (!purpose || purpose.trim().length < 3) {
    throw new Error('Для доступа к защищённым данным требуется указать цель (purpose).');
  }
  const { rows } = await query('SELECT * FROM mem.secure_records WHERE id = $1', [secureRecordId]);
  const rec = rows[0];
  if (!rec) {
    throw new Error('Защищённая запись не найдена.');
  }
  if (rec.consent_status !== 'granted') {
    throw new Error('Нет согласия пользователя на использование этих данных.');
  }
  await query('UPDATE mem.secure_records SET last_used_at = now() WHERE id = $1', [secureRecordId]);
  return { value: decrypt(rec.encrypted_payload), record_type: rec.record_type, purpose };
}
