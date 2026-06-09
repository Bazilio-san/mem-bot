# 07. Защищённая память и приватность

## [SEC-1] Шифрование и маскирование

Шифрование размещается в рекомендованном модуле `src/pipeline/secure.js`: оно шифрует значение алгоритмом AES-256-GCM.
Ключ детерминированно выводится из секрета
`config.authSecret` через SHA-256. Формат шифртекста — двенадцать байт вектора инициализации, шестнадцать байт тега
аутентификации и собственно шифртекст. В обычную память и в промпт попадает только замаскированное резюме: тип записи и
две последние цифры.

```js
const KEY = crypto.createHash('sha256').update(config.authSecret).digest(); // 32 байта для AES-256

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

## [SEC-2] Согласие и доступ к полному значению

По умолчанию согласие неизвестно (`consent_status = 'unknown'`): данные можно хранить зашифрованно, но они помечены как
требующие подтверждения. Доступ к полному значению (`getSecureValue`) разрешён только при двух условиях одновременно:
указана осмысленная цель (`purpose`) и согласие переведено в `granted`. Любой доступ фиксирует время использования.

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

Так закрываются два критерия приватности (`CRIT-7`, `CRIT-8`): полные защищённые данные не попадают в обычные ответы
(в промпт идёт только `redacted_summary`), а раскрытие возможно только под конкретное действие и с согласия.

---

## [SEC-3] Что проверяют тесты приватности

Тесты слоя приватности проверяют все четыре ветки: резюме без полного значения; отказ без согласия; успех после согласия;
отказ при недостаточной цели; и отсутствие утечек.

---

## [SEC-4] Распознавание секретов при извлечении

При извлечении кандидатов в память паспорт, телефон, адрес, дату рождения, платёжные и медицинские данные модель помечает
как чувствительные (`sensitivity = high` или `secret`, `requires_confirmation = true`) и кладёт в `memory_text` только
безопасное резюме. Такой кандидат не сохраняется как обычный факт. Запись секрета в `secure_records` выполняет функция
`saveSecureRecord` после подтверждения согласия пользователя.

---

## [SEC-5] Связь с проактивностью

Проактивные сообщения и контекст собеседника не раскрывают защищённые данные: в них идут только обычные факты и безопасные
резюме, как и в основном `MEMORY_CONTEXT`. Это сохраняет приватность при включённой проактивности.

---


