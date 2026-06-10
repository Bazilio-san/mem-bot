# 07. Secure Memory and Privacy

## [SEC-1] Encryption and Redaction

Encryption is placed in the recommended module `src/pipeline/secure.js`: it encrypts a value using the AES-256-GCM
algorithm. The key is deterministically derived from the secret `config.authSecret` via SHA-256. The ciphertext format
is twelve bytes of initialization vector, sixteen bytes of authentication tag, and the ciphertext itself. Only a
redacted summary is stored in regular memory and passed to the prompt: the record type and the last two digits.

```js
const KEY = crypto.createHash('sha256').update(config.authSecret).digest(); // 32 bytes for AES-256

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);                 // [IV][tag][ciphertext]
}

export function redact(recordType, rawValue) {
  const v = String(rawValue).replace(/\s+/g, '');
  const tail = v.slice(-2);
  return `сохранён ${recordType}, оканчивается на ...${tail}; полное значение не раскрывать без необходимости`;
}
```

---

## [SEC-2] Consent and Access to Full Value

By default, consent is unknown (`consent_status = 'unknown'`): data can be stored in encrypted form, but it is
flagged as requiring confirmation. Access to the full value (`getSecureValue`) is permitted only when two conditions
are met simultaneously: a meaningful purpose is provided (`purpose`) and consent has been set to `granted`. Every
access records the time of use.

```js
export async function getSecureValue(secureRecordId, purpose) {
  if (!purpose || purpose.trim().length < 3)
    throw new Error('Для доступа к защищённым данным требуется указать цель (purpose).');
  const { rows } = await query('SELECT * FROM mem.secure_records WHERE id = $1', [secureRecordId]);
  const rec = rows[0];
  if (!rec) throw new Error('Защищённая запись не найдена.');
  if (rec.consent_status !== 'granted')
    throw new Error('Нет согласия пользователя на использование этих данных.');
  await query('UPDATE mem.secure_records SET last_used_at = now() WHERE id = $1', [secureRecordId]);
  return { value: decrypt(rec.encrypted_payload), record_type: rec.record_type, purpose };
}
```

This satisfies two privacy criteria (`CRIT-7`, `CRIT-8`): full protected data never appears in regular responses
(only `redacted_summary` is passed to the prompt), and disclosure is only possible for a specific action and with
user consent.

---

## [SEC-3] What the Privacy Tests Verify

The privacy layer tests cover all four branches: summary without the full value; rejection without consent; success
after consent is granted; rejection when the purpose is insufficient; and the absence of data leaks.

---

## [SEC-4] Recognizing Secrets During Extraction

When extracting memory candidates, the model marks passports, phone numbers, addresses, dates of birth, payment data,
and medical data as sensitive (`sensitivity = high` or `secret`, `requires_confirmation = true`) and places only a
safe summary in `memory_text`. Such a candidate is not saved as a regular fact. Writing a secret to `secure_records`
is performed by the `saveSecureRecord` function after the user's consent has been confirmed.

---

## [SEC-5] Relationship to Proactivity

Proactive messages and the interlocutor's context do not expose protected data: they carry only regular facts and
safe summaries, just like the main `MEMORY_CONTEXT`. This preserves privacy when proactivity is enabled.

---


