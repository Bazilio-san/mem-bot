// Модульные тесты снятия разметки перед синтезом речи. Озвучиваться должен чистый текст без тегов и знаков
// Markdown, иначе бот зачитает разметку вслух.
import assert from 'node:assert/strict';
import { stripMarkup } from '../src/voice/tts.js';

// 1. HTML-теги Telegram удаляются, остаётся только текст.
{
  assert.equal(stripMarkup('<b>привет</b>, <i>мир</i>'), 'привет, мир');
}

// 2. Экранированные сущности возвращаются к обычным символам.
{
  assert.equal(stripMarkup('1 &lt; 2 &amp; 3 &gt; 0'), '1 < 2 & 3 > 0');
}

// 3. Знаки Markdown снимаются: жирный, курсив, код, заголовок, цитата.
{
  assert.equal(stripMarkup('**важно** и _курсив_'), 'важно и курсив');
  assert.equal(stripMarkup('`код`'), 'код');
  assert.equal(stripMarkup('## Заголовок'), 'Заголовок');
  assert.equal(stripMarkup('> цитата'), 'цитата');
}

// 4. Обычный текст без разметки не меняется.
{
  assert.equal(stripMarkup('Просто текст без разметки.'), 'Просто текст без разметки.');
}

console.log('tts-strip.test.mjs: ok');
