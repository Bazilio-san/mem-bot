// Модульные тесты подготовки текста к доставке в Telegram: санитайзер разметки и разбивка по границам тегов.
// Чистые функции без БД и сети.
import assert from 'node:assert/strict';
import { telegramPostProcess, telegramSplit } from '../src/telegram/format.js';

// Простой парсер баланса тегов: проверяет, что в куске нет незакрытых или лишних закрывающих тегов
// (учитываются только теги разметки Telegram). Возвращает true, если разметка сбалансирована.
function tagsBalanced(html) {
  const stack = [];
  const re = /<(\/?)([A-Za-z][A-Za-z0-9-]*)[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (closing) {
      if (stack.pop() !== name) {
        return false;
      }
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

// === Санитайзер ===

// 1. Разрешённые теги сохраняются.
{
  const out = telegramPostProcess('<b>жирный</b> и <i>курсив</i>');
  assert.equal(out, '<b>жирный</b> и <i>курсив</i>');
}

// 2. Недопустимый тег экранируется, а не выкидывается (текст доходит как написано).
{
  const out = telegramPostProcess('текст <div>блок</div> и <h1>заголовок</h1>');
  assert.ok(!/<div>|<h1>/.test(out), 'недопустимые теги не остаются разметкой');
  assert.ok(out.includes('&lt;div&gt;'), 'недопустимый тег экранирован и виден как текст');
}

// 3. Одиночные спецсимволы в обычном тексте экранируются.
{
  const out = telegramPostProcess('если 1 < 2 и 3 > 2, то всё & хорошо');
  assert.ok(
    out.includes('&lt;') && out.includes('&gt;') && out.includes('&amp;'),
    'символы <, > и & экранированы для parse_mode=HTML',
  );
}

// 4. Содержимое блока кода сохраняется как код.
{
  const out = telegramPostProcess('<pre><code>const x = 1 &lt; 2;</code></pre>');
  assert.ok(out.includes('<pre>') && out.includes('<code>'), 'теги pre/code сохранены');
}

// 5. Опасная схема ссылки отбрасывается.
{
  const out = telegramPostProcess('<a href="javascript:alert(1)">клик</a>');
  assert.ok(!/javascript:/.test(out), 'javascript-ссылка отсечена');
}

// === Разбивка по границам тегов ===

// 6. Короткий текст возвращается одной частью.
{
  const parts = telegramSplit('<b>привет</b>', 100);
  assert.equal(parts.length, 1);
  assert.equal(parts[0], '<b>привет</b>');
}

// 7. Длинный размеченный текст режется так, что каждая часть сбалансирована по тегам.
{
  const inner = 'слово '.repeat(60); // ~360 символов внутри одного тега
  const html = `<b>${inner}</b>`;
  const parts = telegramSplit(html, 100);
  assert.ok(parts.length > 1, 'длинный текст разбит на несколько частей');
  for (const p of parts) {
    assert.ok(p.length <= 100 + 20, `часть в пределах лимита с запасом на разметку: ${p.length}`);
    assert.ok(tagsBalanced(p), `часть сбалансирована по тегам: ${p}`);
    assert.ok(!/<[^>]*$/.test(p), 'часть не обрывается на середине тега');
  }
}

// 8. Открытый тег переносится в следующую часть (реоткрытие разметки).
{
  const inner = 'X'.repeat(50);
  const parts = telegramSplit(`пролог <b>${inner}${inner}</b> эпилог`, 60);
  assert.ok(parts.length > 1);
  // Часть, начавшаяся внутри жирного, должна сама открыть <b> и сама его закрыть.
  const middle = parts.find((p) => p.includes('X') && !p.includes('пролог'));
  assert.ok(middle && tagsBalanced(middle), 'перенесённая часть открывает и закрывает свой тег');
}

console.log('telegram-format.test.mjs: ok');
