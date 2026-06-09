// Скрипт удаления одного или нескольких пользователей и всех связанных с ними сущностей из БД памяти.
//
// Пользователи ищутся по любому набору критериев: внутренний идентификатор (UUID),
// внешний идентификатор (external_id), отображаемое имя (display_name) или префикс
// внешнего идентификатора. Все совпадения объединяются и дедуплицируются по id.
// Перед удалением выводится отчёт по количеству связанных строк.
//
// Большинство пользовательских таблиц объявлены с правилом ON DELETE CASCADE,
// поэтому удаление строки из mem.users каскадно удаляет диалоги, сообщения,
// сводки, элементы памяти, защищённые записи, задачи планировщика и их запуски,
// уведомления, очередь заданий памяти, темы, триггеры проактивности и журнал событий.
//
// Исключения с правилом ON DELETE SET NULL (строки сохраняются, обнуляется лишь ссылка):
//   - mem.tool_calls.user_id          — журнал вызовов инструментов остаётся для аналитики;
//   - mem.global_facts.created_by     — глобальные факты остаются, теряется только авторство;
//   - mem.global_knowledge.created_by — глобальная база знаний остаётся, теряется авторство.
//
// Запуск (одиночное удаление):
//   node scripts/delete-user.js --external-id sandbox-anna
//   node scripts/delete-user.js --id 7f3c...-uuid
//   node scripts/delete-user.js --name "Анна"
//
// Запуск (пакетное удаление):
//   node scripts/delete-user.js --external-id sandbox-anna,sandbox-dmitry,sandbox-lena
//   node scripts/delete-user.js --external-id a --external-id b --id <uuid>
//   node scripts/delete-user.js --prefix sandbox-          (все, чей external_id начинается с "sandbox-")
//   node scripts/delete-user.js --prefix t --yes           (без интерактивного подтверждения)
//
// Значения можно перечислять через запятую и повторять флаги — всё объединяется.
// Без флага --yes скрипт запрашивает подтверждение и удаляет только при вводе "yes".
// Всё удаление выполняется в одной транзакции: при ошибке изменения откатываются.

import readline from 'node:readline';
import { query, getPool, closePool } from '../src/db.js';

// Разбить значение флага на части по запятой и убрать пустые/пробельные элементы.
function splitList(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Разбор аргументов командной строки. Значения накапливаются в массивы,
// чтобы поддержать и перечисление через запятую, и повторение флагов.
function parseArgs(argv) {
  const args = { ids: [], externalIds: [], names: [], prefixes: [], yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--yes' || token === '-y') {
      args.yes = true;
    } else if (token === '--id') {
      args.ids.push(...splitList(argv[++i]));
    } else if (token === '--external-id' || token === '--ext') {
      args.externalIds.push(...splitList(argv[++i]));
    } else if (token === '--name') {
      args.names.push(...splitList(argv[++i]));
    } else if (token === '--prefix') {
      args.prefixes.push(...splitList(argv[++i]));
    }
  }
  return args;
}

// Найти всех пользователей по объединённому набору критериев. Возвращает массив
// уникальных строк (дедупликация по id). Бросает ошибку, если критерии не заданы.
async function findUsers({ ids, externalIds, names, prefixes }) {
  if (!ids.length && !externalIds.length && !names.length && !prefixes.length) {
    throw new Error('Не указан ни один критерий поиска. Используйте --id, --external-id, --name или --prefix.');
  }

  const byId = new Map();
  const addRows = (rows) => rows.forEach((r) => byId.set(r.id, r));

  if (ids.length) {
    const { rows } = await query('SELECT * FROM mem.users WHERE id = ANY($1::uuid[])', [ids]);
    addRows(rows);
  }
  if (externalIds.length) {
    const { rows } = await query('SELECT * FROM mem.users WHERE external_id = ANY($1::text[])', [externalIds]);
    addRows(rows);
  }
  if (names.length) {
    const { rows } = await query('SELECT * FROM mem.users WHERE display_name = ANY($1::text[])', [names]);
    addRows(rows);
  }
  for (const prefix of prefixes) {
    // Экранируем спецсимволы LIKE (% и _), чтобы префикс трактовался буквально.
    const escaped = prefix.replace(/([%_\\])/g, '\\$1');
    const { rows } = await query("SELECT * FROM mem.users WHERE external_id LIKE $1 ESCAPE '\\'", [`${escaped}%`]);
    addRows(rows);
  }

  return [...byId.values()];
}

// Таблицы, удаляемые каскадно вместе с пользователем. Используются для отчёта;
// само удаление выполняет каскад на уровне внешних ключей БД.
const CASCADE_TABLES = [
  ['mem.conversations', 'диалоги'],
  ['mem.conversation_messages', 'сообщения диалогов'],
  ['mem.conversation_summaries', 'сводки диалогов'],
  ['mem.memory_items', 'элементы памяти'],
  ['mem.secure_records', 'защищённые записи'],
  ['mem.scheduled_tasks', 'задачи планировщика'],
  ['mem.notification_outbox', 'уведомления в очереди'],
  ['mem.memory_jobs', 'задания обработки памяти'],
  ['mem.topic_mentions', 'упоминания тем'],
  ['mem.proactive_triggers', 'триггеры проактивности'],
  ['mem.event_deliveries', 'доставленные события'],
];

// Таблицы, где ссылка на пользователя будет обнулена (строки сохранятся).
const SET_NULL_TABLES = [
  ['mem.tool_calls', 'user_id', 'вызовы инструментов'],
  ['mem.global_facts', 'created_by', 'глобальные факты (авторство)'],
  ['mem.global_knowledge', 'created_by', 'глобальная база знаний (авторство)'],
];

// Посчитать связанные строки сразу для всех удаляемых пользователей и вывести отчёт.
async function reportRelated(userIds) {
  console.log('\nБудут удалены следующие связанные сущности (каскадом, суммарно по всем пользователям):');
  let totalDeleted = 0;
  for (const [table, label] of CASCADE_TABLES) {
    const { rows } = await query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = ANY($1::uuid[])`, [userIds]);
    const { n } = rows[0];
    totalDeleted += n;
    if (n > 0) {
      console.log(`  - ${label}: ${n}`);
    }
  }
  if (totalDeleted === 0) {
    console.log('  (связанных строк нет)');
  }

  console.log('\nУ следующих сущностей ссылка на пользователя будет обнулена (строки сохранятся):');
  let totalNulled = 0;
  for (const [table, column, label] of SET_NULL_TABLES) {
    const { rows } = await query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} = ANY($1::uuid[])`, [
      userIds,
    ]);
    const { n } = rows[0];
    totalNulled += n;
    if (n > 0) {
      console.log(`  - ${label}: ${n}`);
    }
  }
  if (totalNulled === 0) {
    console.log('  (таких строк нет)');
  }
}

// Запросить подтверждение в консоли. Возвращает true только при вводе "yes".
function confirm(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(promptText, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'yes');
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const users = await findUsers(args);

  if (users.length === 0) {
    console.log('Пользователи по заданным критериям не найдены. Ничего не удалено.');
    return;
  }

  console.log(`Найдено пользователей к удалению: ${users.length}`);
  for (const u of users) {
    const ext = u.external_id || '—';
    const name = u.display_name || '—';
    console.log(`  - ${u.id}  external_id=${ext}  name=${name}`);
  }

  const userIds = users.map((u) => u.id);
  await reportRelated(userIds);

  if (!args.yes) {
    const word = users.length === 1 ? 'этого пользователя' : `этих пользователей (${users.length})`;
    const ok = await confirm(`\nУдалить ${word} и все связанные данные? Введите "yes" для подтверждения: `);
    if (!ok) {
      console.log('Отмена. Ничего не удалено.');
      return;
    }
  }

  // Всё удаление — в одной транзакции. Каскадные внешние ключи убирают связанные строки,
  // правила SET NULL обнуляют ссылки в сохраняемых таблицах.
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query('DELETE FROM mem.users WHERE id = ANY($1::uuid[])', [userIds]);
    await client.query('COMMIT');
    console.log(`\nГотово. Удалено пользователей: ${rowCount}. Связанные данные удалены каскадом.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

main()
  .catch((err) => {
    console.error('Ошибка удаления:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
