// Кроссплатформенная остановка Telegram-бота и объединённого веб-сервера.
//
// Бот может работать в двух режимах: как отдельный процесс `node src/telegram/bot.js` (команда
// npm run telegram) либо внутри объединённого веб-сервера `node src/server/index.js` (команда npm run
// server), который в том же процессе обслуживает админку на порту config.admin.port. Поэтому скрипт
// останавливает обе мишени:
//   1) процесс Telegram-бота — опознаётся по командной строке (точка входа src/telegram/bot.js, а также
//      src/server/index.js, в котором канал Telegram запущен встроенно);
//   2) процесс, слушающий TCP-порт config.admin.port, — это объединённый веб-сервер; он находится по порту
//      независимо от командной строки, на случай если опознать его по командной строке не удалось.
// Найденные идентификаторы процессов объединяются в единое множество (без повторов), и каждому процессу
// сначала посылается сигнал мягкого завершения, а затем — после паузы — выжившие добиваются принудительно.
//
// Поиск реализован для каждой платформы отдельным системным средством:
//   - Windows: PowerShell (Get-CimInstance Win32_Process для командных строк, Get-NetTCPConnection для порта);
//   - Linux/macOS: утилиты ps (командные строки) и lsof (владелец порта).
// Внешних зависимостей нет — используются только встроенные модули Node.js.
//
// В Linux/macOS обычно достаточно мягкого сигнала SIGTERM: бот штатно закрывает циклы, слушатель очереди и пул
// соединений с базой. В Windows настоящих сигналов нет, и мягкий taskkill фоновому процессу Node.js без окна
// часто не помогает, поэтому его останавливает уже принудительная добивка.
//
// Запуск:
//   node scripts/stop-telegram.js          — найти и остановить (мягко, затем принудительно);
//   node scripts/stop-telegram.js --soft   — только мягкое завершение, без принудительной добивки.

import { execFileSync, spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';
const softOnly = process.argv.includes('--soft');
const selfPid = process.pid;

// Порт админки берём из конфигурации (с учётом переменной окружения ADMIN_PORT). Если загрузить конфигурацию
// не удалось (например, не заданы обязательные параметры базы данных), откатываемся на ADMIN_PORT или 3001,
// чтобы остановка по порту всё равно работала и не требовала полной валидной конфигурации проекта.
let adminPort;
try {
  const { config } = await import('../src/config.js');
  adminPort = config.admin?.port;
} catch {
  /* конфигурация недоступна — используем запасной источник ниже */
}
adminPort = Number(adminPort) || Number(process.env.ADMIN_PORT) || 3001;

// Образец, по которому опознаётся процесс бота в его командной строке. Точки входа — файл src/telegram/bot.js
// (отдельный режим) и src/server/index.js (объединённый сервер, где канал Telegram запущен встроенно).
// Образец сопоставляет путь с любым разделителем каталогов: прямой слеш в Unix и обратный слеш в Windows.
const MARKER = /(?:telegram[\\/]bot|server[\\/]index)\.js/;

// Пауза в миллисекундах между мягким завершением и проверкой/принудительной добивкой.
const GRACE_MS = 5000;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Найти процессы бота по командной строке. Возвращает массив { pid, commandLine }.
function findBotProcesses() {
  return isWindows ? findProcessesOnWindows() : findProcessesOnUnix();
}

function findProcessesOnWindows() {
  // Get-CimInstance даёт полную командную строку каждого процесса Node.js. Перечисляем все процессы node.exe,
  // а отбор по маркеру делаем в JS. Вывод формируется построчно в формате «PID<табуляция>командная строка».
  const ps = [
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'"',
    '| ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
  ].join(' ');
  let out;
  try {
    out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  } catch (err) {
    // Если PowerShell вернул ненулевой код, но что-то напечатал в stdout — используем этот вывод.
    out = err.stdout ? String(err.stdout) : '';
  }
  return parseLines(out);
}

function findProcessesOnUnix() {
  // ps печатает идентификатор процесса и полную команду; ключи -A (все процессы) и -o задают формат.
  let out = '';
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  } catch (err) {
    out = err.stdout ? String(err.stdout) : '';
  }
  return parseLines(out);
}

// Разобрать построчный вывод системной утилиты в список процессов бота.
function parseLines(out) {
  const result = [];
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (!MARKER.test(line)) {
      continue;
    }
    // Первое «слово» строки — идентификатор процесса, остаток — командная строка.
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const commandLine = match[2];
    if (!Number.isInteger(pid) || pid === selfPid) {
      continue;
    }
    // Подстраховка: исключаем сам скрипт остановки, чтобы он ни при каких условиях не остановил себя.
    if (commandLine.includes('stop-telegram.js')) {
      continue;
    }
    result.push({ pid, commandLine });
  }
  return result;
}

// Найти идентификаторы процессов, слушающих заданный TCP-порт. Возвращает массив чисел (pid).
function findPortPids(port) {
  return isWindows ? findPortPidsOnWindows(port) : findPortPidsOnUnix(port);
}

function findPortPidsOnWindows(port) {
  // Get-NetTCPConnection возвращает соединения в состоянии Listen на нужном порту; OwningProcess — владелец.
  const ps = [
    `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
    '| Select-Object -ExpandProperty OwningProcess -Unique',
  ].join(' ');
  let out = '';
  try {
    out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  } catch (err) {
    out = err.stdout ? String(err.stdout) : '';
  }
  return parsePidList(out);
}

function findPortPidsOnUnix(port) {
  // lsof перечисляет идентификаторы процессов, слушающих порт (-t — только pid, -sTCP:LISTEN — только слушатели).
  let out = '';
  try {
    out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  } catch (err) {
    // lsof возвращает код 1, когда ничего не найдено, — это не ошибка, просто пустой список.
    out = err.stdout ? String(err.stdout) : '';
  }
  return parsePidList(out);
}

// Разобрать вывод «по одному pid в строке» в массив чисел, исключая собственный процесс.
function parsePidList(out) {
  const pids = [];
  for (const raw of out.split('\n')) {
    const pid = Number(raw.trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== selfPid) {
      pids.push(pid);
    }
  }
  return pids;
}

// Послать процессу сигнал мягкого завершения.
function terminate(pid) {
  if (isWindows) {
    // taskkill без ключа /F просит процесс завершиться штатно; /T заодно закрывает дочерние процессы.
    spawnSync('taskkill', ['/PID', String(pid), '/T'], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGTERM');
  }
}

// Принудительно убить процесс (используется, если мягкое завершение не сработало за отведённую паузу).
function kill(pid) {
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

// Проверить, существует ли ещё процесс с данным идентификатором.
function isAlive(pid) {
  try {
    process.kill(pid, 0); // сигнал 0 ничего не делает, только проверяет
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // Собираем обе мишени в единую карту pid → описание, чтобы один и тот же процесс (объединённый сервер
  // попадает и под маркер командной строки, и под поиск по порту) не обрабатывался дважды.
  const targets = new Map();
  for (const { pid, commandLine } of findBotProcesses()) {
    targets.set(pid, commandLine);
  }
  for (const pid of findPortPids(adminPort)) {
    if (!targets.has(pid)) {
      targets.set(pid, `процесс на порту админки ${adminPort}`);
    }
  }

  if (!targets.size) {
    console.log(`Запущенный Telegram-бот и процесс на порту ${adminPort} не найдены — останавливать нечего.`);
    return;
  }

  console.log(`Найдено процессов для остановки: ${targets.size}. Отправляю сигнал мягкого завершения…`);
  for (const [pid, description] of targets) {
    console.log(`  Останавливаю процесс ${pid}: ${description}`);
    try {
      terminate(pid);
    } catch (err) {
      console.error(`  Не удалось послать сигнал процессу ${pid}: ${err.message}`);
    }
  }

  if (softOnly) {
    console.log('Режим --soft: послан только мягкий сигнал. Принудительная остановка не выполняется.');
    console.log('В Windows фоновый процесс может не отреагировать на мягкий сигнал — тогда запустите без --soft.');
    return;
  }

  // Ждём штатного завершения, затем добиваем тех, кто остался жив.
  console.log(`Жду штатного завершения ${Math.round(GRACE_MS / 1000)} с…`);
  await sleep(GRACE_MS);
  const survivors = [...targets.keys()].filter((pid) => isAlive(pid));
  if (!survivors.length) {
    console.log('Все процессы завершились штатно.');
    return;
  }
  console.log(`Не завершились штатно: ${survivors.length}. Останавливаю принудительно…`);
  for (const pid of survivors) {
    try {
      kill(pid);
      console.log(`  Процесс ${pid} остановлен принудительно.`);
    } catch (err) {
      console.error(`  Не удалось остановить процесс ${pid}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('Ошибка остановки:', err.message);
  process.exit(1);
});
