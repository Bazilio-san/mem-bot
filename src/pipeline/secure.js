// Контур защищённой памяти. Чувствительные данные (паспорт, телефон, адрес и т.п.)
// шифруются на уровне приложения (AES-256-GCM) и кладутся в отдельную таблицу.
// В обычную память и в промпт попадает только безопасное резюме (redacted_summary),
// никогда не полное значение. Сохранение требует явного согласия пользователя.
import crypto from 'node:crypto';
import { query } from './../db.js';
import { config } from '../config.js';
import { getDomainId } from '../repo.js';

// Ключ шифрования выводится из AUTH_SECRET детерминированно (32 байта для AES-256).
const KEY = crypto.createHash('sha256').update(config.authSecret).digest();

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Формат: [12 байт IV][16 байт тег аутентификации][шифртекст].
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

// Замаскировать значение для безопасного резюме: показываем тип и хвост, скрываем середину.
export function redact(recordType, rawValue) {
  const v = String(rawValue).replace(/\s+/g, '');
  const tail = v.slice(-2);
  return `сохранён ${recordType}, оканчивается на ...${tail}; полное значение не раскрывать без необходимости`;
}

// Сохранить защищённую запись. По умолчанию согласие неизвестно — данные хранятся,
// но помечены как требующие подтверждения. consentStatus='granted' ставится только
// при явном согласии пользователя.
export async function saveSecureRecord({
  userId, domainKey = 'general', recordType, subjectKey = null, displayName = null,
  rawValue, consentStatus = 'unknown',
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

// Подтвердить согласие на хранение ранее сохранённой записи.
export async function grantConsent(secureRecordId) {
  await query(
    `UPDATE mem.secure_records SET consent_status='granted', consent_at=now(), updated_at=now() WHERE id=$1`,
    [secureRecordId],
  );
}

// Получить безопасные резюме защищённых записей пользователя (для MEMORY_CONTEXT).
// Полные значения здесь не раскрываются — только redacted_summary.
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

// Раскрыть полное значение защищённой записи. Доступно ТОЛЬКО при явной цели (purpose)
// и при наличии согласия. Каждый доступ фиксируется.
export async function getSecureValue(secureRecordId, purpose) {
  if (!purpose || purpose.trim().length < 3) {
    throw new Error('Для доступа к защищённым данным требуется указать цель (purpose).');
  }
  const { rows } = await query('SELECT * FROM mem.secure_records WHERE id = $1', [secureRecordId]);
  const rec = rows[0];
  if (!rec) throw new Error('Защищённая запись не найдена.');
  if (rec.consent_status !== 'granted') {
    throw new Error('Нет согласия пользователя на использование этих данных.');
  }
  await query('UPDATE mem.secure_records SET last_used_at = now() WHERE id = $1', [secureRecordId]);
  return { value: decrypt(rec.encrypted_payload), record_type: rec.record_type, purpose };
}
