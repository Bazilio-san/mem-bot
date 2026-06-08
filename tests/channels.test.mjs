// Модульные тесты реестра профилей представления каналов. Реестр — чистый модуль без побочных эффектов,
// поэтому проверяется без БД и без сети.
import assert from 'node:assert/strict';
import { registerChannelProfile, getChannelProfile } from '../src/pipeline/channels.js';

// 1. Неизвестный канал отдаёт профиль по умолчанию: без разметки и без инструкции.
{
  const p = getChannelProfile('no-such-channel');
  assert.equal(p.instruction, null, 'у неизвестного канала нет инструкции форматирования');
  assert.equal(p.parseMode, null, 'у неизвестного канала нет режима разметки');
  assert.equal(p.postProcess, null);
  assert.equal(p.split, null);
}

// 2. Зарегистрированный профиль возвращается по ключу, а недостающие поля дополняются значениями по умолчанию.
{
  registerChannelProfile('unit-telegram', { instruction: 'форматируй в HTML', parseMode: 'HTML' });
  const p = getChannelProfile('unit-telegram');
  assert.equal(p.instruction, 'форматируй в HTML');
  assert.equal(p.parseMode, 'HTML');
  assert.equal(p.postProcess, null, 'не указанное поле дополнено значением по умолчанию');
  assert.equal(p.split, null);
}

// 3. Повторная регистрация под тем же ключом заменяет профиль целиком.
{
  registerChannelProfile('unit-x', { instruction: 'первый' });
  registerChannelProfile('unit-x', { parseMode: 'HTML' });
  const p = getChannelProfile('unit-x');
  assert.equal(p.instruction, null, 'старая инструкция не сохраняется после повторной регистрации');
  assert.equal(p.parseMode, 'HTML');
}

console.log('channels.test.mjs: ok');
