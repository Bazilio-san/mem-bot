// Интерактивный чат в терминале. Подключается ко всему пайплайну памяти.
// Запуск: npm run chat   (или: node src/cli.js [externalId] [domainKey])
import readline from 'node:readline';
import { handleMessage } from './agent.js';
import { tick } from './pipeline/scheduler.js';
import { closePool } from './db.js';

const externalId = process.argv[2] || 'cli-user';
let domainKey = process.argv[3] || 'general';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

console.log(`Чат-бот с памятью. Пользователь: ${externalId}, домен: ${domainKey}.`);
console.log('Команды: /domain <key> — сменить домен, /tick — прогнать планировщик, /exit — выход.\n');

// Фоновый проход планировщика раз в 10 секунд, чтобы напоминания реально срабатывали.
const schedulerTimer = setInterval(async () => {
  try {
    const r = await tick();
    if (r.processed > 0) console.log(`\n[планировщик] выполнено задач: ${r.processed}\n> `);
  } catch { /* игнорируем разовые ошибки фонового прохода */ }
}, 10000);

async function main() {
  while (true) {
    const input = (await ask('> ')).trim();
    if (!input) continue;
    if (input === '/exit') break;
    if (input.startsWith('/domain ')) { domainKey = input.slice(8).trim() || 'general'; console.log(`Домен: ${domainKey}`); continue; }
    if (input === '/tick') { const r = await tick(); console.log(`Выполнено задач: ${r.processed}`); continue; }

    try {
      const res = await handleMessage({ externalId, userMessage: input, domainKey });
      domainKey = res.domainKey;
      if (res.toolsUsed.length) {
        console.log(`  [инструменты: ${res.toolsUsed.map((t) => t.name).join(', ')}]`);
      }
      console.log(`bot> ${res.answer}\n`);
    } catch (err) {
      console.error('Ошибка обработки:', err.message);
    }
  }
  clearInterval(schedulerTimer);
  rl.close();
  await closePool();
}

main();
