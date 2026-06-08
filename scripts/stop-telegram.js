// Кроссплатформенная остановка Telegram-бота (процесса `node src/telegram/bot.js`).
//
// Скрипт находит все запущенные процессы Node.js, в командной строке которых упоминается
// `src/telegram/bot.js`, и посылает им сигнал мягкого завершения. В файле
// src/telegram/bot.js предусмотрена обработка SIGINT/SIGTERM: бот останавливает циклы опроса
// и фонового воркера, закрывает соединение-слушатель и пул соединений с базой и только
// после этого выходит. Поэтому здесь используется именно мягкое завершение, а не принудительное.
//
// Поиск процессов реализован для каждой платформы отдельным системным средством:
//   - Windows: PowerShell с запросом Get-CimInstance Win32_Process (видит полную командную строку);
//   - Linux/macOS: стандартная утилита ps.
// Внешних зависимостей нет — используется только встроенный модуль node:child_process.
//
// Порядок остановки: сначала всем процессам бота посылается сигнал мягкого завершения, затем после паузы
// проверяется, кто остался жив, и эти процессы останавливаются принудительно. Так бот надёжно завершается
// на всех платформах. В Linux/macOS обычно достаточно мягкого сигнала SIGTERM (с закрытием базы и слушателя
// очереди). В Windows настоящих сигналов нет: мягкий taskkill фоновому процессу Node.js без окна не помогает,
// поэтому его останавливает уже принудительная добивка.
//
// Запуск:
//   node scripts/stop-telegram.js          — найти и остановить бота (мягко, затем принудительно);
//   node scripts/stop-telegram.js --soft   — только мягкое завершение, без принудительной добивки.

import { execFileSync, spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';
const softOnly = process.argv.includes('--soft');
const selfPid = process.pid;

// Образец, по которому опознаётся процесс бота в его командной строке. Точка входа адаптера —
// файл src/telegram/bot.js, поэтому образец сопоставляет путь «telegram/bot.js» с любым разделителем
// каталогов: прямой слеш в Unix и обратный слеш в Windows.
const MARKER = /telegram[\\/]bot\.js/;

// Пауза в миллисекундах между мягким завершением и проверкой/принудительной добивкой.
const GRACE_MS = 5000;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Найти идентификаторы процессов бота. Возвращает массив { pid, commandLine }.
// Собственный процесс этого скрипта исключается, чтобы он не остановил сам себя.
function findBotProcesses() {
  return isWindows ? findOnWindows() : findOnUnix();
}

function findOnWindows() {
  // Get-CimInstance даёт полную командную строку каждого процесса Node.js. Фильтруем по маркеру.
  // Вывод формируется построчно в формате «PID<табуляция>командная строка».
  const ps = [
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\"",
    "| Where-Object { $_.CommandLine -like '*bot.js*' }",
    "| ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
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

function findOnUnix() {
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
    if (!line) continue;
    if (!MARKER.test(line)) continue;
    // Первое «слово» строки — идентификатор процесса, остаток — командная строка.
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const commandLine = match[2];
    if (!Number.isInteger(pid) || pid === selfPid) continue;
    // Подстраховка: исключаем сам скрипт остановки, чтобы он ни при каких условиях не остановил себя.
    if (commandLine.includes('stop-telegram.js')) continue;
    result.push({ pid, commandLine });
  }
  return result;
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

// Принудительно убить процесс (используется только в режиме --force, если мягкое завершение не сработало).
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
    process.kill(pid, 0);                                             // сигнал 0 ничего не делает, только проверяет
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const procs = findBotProcesses();
  if (!procs.length) {
    console.log('Запущенный Telegram-бот не найден — останавливать нечего.');
    return;
  }

  console.log(`Найдено процессов бота: ${procs.length}. Отправляю сигнал мягкого завершения…`);
  for (const { pid, commandLine } of procs) {
    console.log(`  Останавливаю процесс ${pid}: ${commandLine}`);
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
  const survivors = procs.filter(({ pid }) => isAlive(pid));
  if (!survivors.length) {
    console.log('Все процессы бота завершились штатно.');
    return;
  }
  console.log(`Не завершились штатно: ${survivors.length}. Останавливаю принудительно…`);
  for (const { pid } of survivors) {
    try {
      kill(pid);
      console.log(`  Процесс ${pid} остановлен принудительно.`);
    } catch (err) {
      console.error(`  Не удалось остановить процесс ${pid}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('Ошибка остановки Telegram-бота:', err.message);
  process.exit(1);
});
