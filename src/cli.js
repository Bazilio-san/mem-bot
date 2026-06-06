// Интерактивный чат в терминале. Подключается ко всему пайплайну памяти.
// Запуск: npm run chat   (или: node src/cli.js [externalId] [domainKey])
import readline from 'node:readline';
import { handleMessage } from './agent.js';
import { tick } from './pipeline/scheduler.js';
import { fireProactiveNow } from './pipeline/proactive.js';
import { closePool } from './db.js';
import { ensureUser } from './repo.js';
import { isAdmin } from './pipeline/admin.js';
import {
  addGlobalFact, deleteGlobalFact, listGlobalFacts,
  searchGlobalKnowledge, addGlobalKnowledge, deleteGlobalKnowledge,
} from './pipeline/global-memory.js';

const externalId = process.argv[2] || 'cli-user';
let domainKey = process.argv[3] || 'general';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

console.log(`Чат-бот с памятью. Пользователь: ${externalId}, домен: ${domainKey}.`);
console.log('Команды: /domain <key> — сменить домен, /tick — прогнать планировщик, '
  + '/proactive <тип> — запустить проактивный триггер вручную (например, /proactive welcome_back), /exit — выход.');
console.log('Глобальная память (запись — только администратору): /fact-add <текст>, /fact-list, /fact-del <id>, '
  + '/kb-add <текст>, /kb-find <запрос>, /kb-del <id>.\n');

// Проверить, что текущий пользователь — администратор. Возвращает идентификатор пользователя или null.
async function requireAdmin() {
  const user = await ensureUser(externalId);
  if (!(await isAdmin(user.id))) {
    console.log('Команда доступна только администратору. Поставьте пользователю пометку is_admin в базе.');
    return null;
  }
  return user.id;
}

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
    if (input.startsWith('/proactive ')) {
      const type = input.slice(11).trim() || 'welcome_back';
      const r = await fireProactiveNow(externalId, type);
      if (r.ok) console.log(`Проактивный триггер «${type}» сработал — сообщение появилось в истории диалога.`);
      else console.log(`Проактивный триггер «${type}» не сработал: ${r.reason || 'сообщение не сформировано'}.`);
      continue;
    }

    // --- Глобальные факты (всегда-включённые, общие для всех; запись только администратору) ---
    if (input.startsWith('/fact-add ')) {
      const adminId = await requireAdmin();
      if (!adminId) continue;
      const text = input.slice(10).trim();
      if (!text) { console.log('Укажите текст факта: /fact-add <текст>'); continue; }
      const f = await addGlobalFact({ factText: text, createdBy: adminId });
      console.log(`Глобальный факт добавлен. Идентификатор: ${f.id}`);
      continue;
    }
    if (input === '/fact-list') {
      const adminId = await requireAdmin();
      if (!adminId) continue;
      const facts = await listGlobalFacts({ includeDisabled: true });
      if (!facts.length) console.log('Глобальных фактов пока нет.');
      else for (const f of facts) console.log(`  ${f.enabled ? '●' : '○'} ${f.id} (приоритет ${f.priority}): ${f.fact_text}`);
      continue;
    }
    if (input.startsWith('/fact-del ')) {
      const adminId = await requireAdmin();
      if (!adminId) continue;
      const id = input.slice(10).trim();
      const ok = await deleteGlobalFact(id);
      console.log(ok ? 'Глобальный факт удалён.' : 'Факт с таким идентификатором не найден.');
      continue;
    }

    // --- Общая база знаний (RAG): поиск доступен всем, запись только администратору ---
    if (input.startsWith('/kb-add ')) {
      const adminId = await requireAdmin();
      if (!adminId) continue;
      const text = input.slice(8).trim();
      if (!text) { console.log('Укажите текст: /kb-add <текст>'); continue; }
      const k = await addGlobalKnowledge({ content: text, createdBy: adminId });
      console.log(`Текст добавлен в базу знаний. Идентификатор: ${k.id}`);
      continue;
    }
    if (input.startsWith('/kb-find ')) {
      const q = input.slice(9).trim();
      if (!q) { console.log('Укажите запрос: /kb-find <запрос>'); continue; }
      const hits = await searchGlobalKnowledge({ domainKey, query: q });
      if (!hits.length) console.log('Релевантных фрагментов не найдено.');
      else for (const h of hits) console.log(`  ${h.id}: ${h.title ? h.title + ' — ' : ''}${h.content}`);
      continue;
    }
    if (input.startsWith('/kb-del ')) {
      const adminId = await requireAdmin();
      if (!adminId) continue;
      const id = input.slice(8).trim();
      const ok = await deleteGlobalKnowledge(id);
      console.log(ok ? 'Запись базы знаний удалена.' : 'Запись с таким идентификатором не найдена.');
      continue;
    }

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
