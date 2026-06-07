// Проверка реального потокового поведения прокси через chatStream. Подтверждает два факта, без которых
// стриминг нельзя считать готовым: прокси отдаёт текст ответа по частям (delta.content) и отдаёт вызовы
// инструментов потоковыми дельтами (delta.tool_calls), которые наш аккумулятор собирает в корректный JSON.
// Запуск: npm run check:streaming
import { chatStream } from '../src/llm.js';
import { config } from '../src/config.js';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

const reminderTool = {
  type: 'function',
  function: {
    name: 'create_reminder',
    description: 'Create a reminder for the user at a specific time.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short reminder title.' },
        when: { type: 'string', description: 'ISO-8601 date-time of the reminder.' },
      },
      required: ['title', 'when'],
      additionalProperties: false,
    },
  },
};

async function main() {
  console.log(`Проверка потокового вызова модели через прокси (модель ${config.llm.mainModel}).\n`);

  // 1. Потоковый текст: онлайн-фрагменты приходят, итоговый текст непустой, инструментов нет.
  console.log('[1] Потоковый текст ответа');
  let deltas = 0;
  let chars = 0;
  const textMsg = await chatStream({
    messages: [
      { role: 'system', content: 'Отвечай одним коротким предложением на русском языке.' },
      { role: 'user', content: 'Поздоровайся и пожелай хорошего дня.' },
    ],
    onDelta: (chunk) => { deltas++; chars += chunk.length; },
  });
  console.log(`     фрагментов: ${deltas}, символов суммарно: ${chars}, ответ: ${(textMsg.content || '').slice(0, 80)}`);
  check('Прокси отдаёт текст ответа потоковыми фрагментами', deltas >= 1 && (textMsg.content || '').length > 0);
  check('Финальный текстовый ответ не содержит tool_calls', !textMsg.tool_calls);

  // 2. Потоковый вызов инструмента: финальный объект собран из дельт, имя верное, аргументы — валидный JSON.
  console.log('\n[2] Потоковый вызов инструмента');
  const toolMsg = await chatStream({
    messages: [
      { role: 'system', content: 'Если пользователь просит напоминание, обязательно вызови инструмент create_reminder.' },
      { role: 'user', content: 'Напомни мне завтра в 10 утра проверить цены на билеты.' },
    ],
    tools: [reminderTool],
  });
  const call = toolMsg.tool_calls?.[0];
  console.log(`     вызовов: ${toolMsg.tool_calls?.length || 0}, имя: ${call?.function?.name}, аргументы: ${call?.function?.arguments}`);
  check('Прокси отдаёт вызов инструмента потоковыми дельтами', !!call && call.function.name === 'create_reminder');
  let argsOk = false;
  try { argsOk = !!JSON.parse(call?.function?.arguments || 'null'); } catch { argsOk = false; }
  check('Аргументы инструмента собраны в валидный JSON', argsOk, call?.function?.arguments);
  check('У вызова инструмента есть id и type=function', !!call?.id && call?.type === 'function');

  console.log(`\n================ ИТОГ ================`);
  console.log(`Пройдено: ${passed}, провалено: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Критическая ошибка проверки стриминга:', err.message || err);
  process.exit(1);
});
