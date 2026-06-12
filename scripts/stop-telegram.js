// Cross-platform shutdown of the Telegram bot and the combined web server.
//
// The bot can run in two modes: as a standalone process `node src/telegram/bot.js` (the
// npm run telegram command) or inside the combined web server `node src/server/index.js` (the npm run
// server command), which serves the admin panel on config.admin.port in the same process. So the script
// stops both targets:
//   1) the Telegram bot process — identified by its command line (entry point src/telegram/bot.js, plus
//      src/server/index.js where the Telegram channel runs embedded);
//   2) the process listening on the TCP port config.admin.port — that is the combined web server; it is
//      found by port regardless of the command line, in case command-line identification failed.
// The found process IDs are merged into a single set (no duplicates), and each process is first sent
// a graceful termination signal, then — after a pause — the survivors are killed forcibly.
//
// Lookup is implemented with a platform-specific system tool:
//   - Windows: PowerShell (Get-CimInstance Win32_Process for command lines, Get-NetTCPConnection for the port);
//   - Linux/macOS: the ps utility (command lines) and lsof (port owner).
// No external dependencies — only built-in Node.js modules are used.
//
// On Linux/macOS a graceful SIGTERM is usually enough: the bot cleanly shuts down its loops, the queue
// listener and the DB connection pool. Windows has no real signals, and a soft taskkill often does nothing
// to a windowless background Node.js process, so it gets stopped by the forced kill instead.
//
// Run:
//   node scripts/stop-telegram.js          — find and stop (gracefully, then forcibly);
//   node scripts/stop-telegram.js --soft   — graceful termination only, no forced kill.

import { execFileSync, spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';
const softOnly = process.argv.includes('--soft');
const selfPid = process.pid;

// The admin port comes from the configuration (honoring the ADMIN_PORT environment variable). If the
// configuration cannot be loaded (e.g. required database settings are missing), fall back to ADMIN_PORT
// or 9019 so that stopping by port still works and does not require a fully valid project configuration.
let adminPort;
try {
  const { config } = await import('../src/config.js');
  adminPort = config.admin?.port;
} catch {
  /* configuration unavailable — use the fallback source below */
}
adminPort = Number(adminPort) || Number(process.env.ADMIN_PORT) || 9019;

// Pattern that identifies the bot process by its command line. Entry points are src/telegram/bot.js
// (standalone mode) and src/server/index.js (combined server with the embedded Telegram channel).
// The pattern matches the path with either directory separator: forward slash on Unix, backslash on Windows.
// The src/ prefix is mandatory: it distinguishes this project from neighboring services with a similar
// entry point (e.g. time-gold on the same server starts as dist/server/index.js and matched the pattern
// without the prefix, so a deploy restarted someone else's service). The word "mem-bot" is absent from
// the command line (the bot is started with a relative path from the project directory), so narrowing
// by project name is impossible.
const MARKER = /src[\\/](?:telegram[\\/]bot|server[\\/]index)\.js/;

// Pause in milliseconds between graceful termination and the check/forced kill.
const GRACE_MS = 5000;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Find bot processes by command line. Returns an array of { pid, commandLine }.
function findBotProcesses() {
  return isWindows ? findProcessesOnWindows() : findProcessesOnUnix();
}

function findProcessesOnWindows() {
  // Get-CimInstance gives the full command line of every Node.js process. We list all node.exe processes
  // and do the marker filtering in JS. Output is produced line by line as "PID<tab>command line".
  const ps = [
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'"',
    '| ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
  ].join(' ');
  let out;
  try {
    out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  } catch (err) {
    // If PowerShell returned a non-zero code but printed something to stdout — use that output.
    out = err.stdout ? String(err.stdout) : '';
  }
  return parseLines(out);
}

function findProcessesOnUnix() {
  // ps prints the process ID and the full command; the -A (all processes) and -o flags set the format.
  let out = '';
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
  } catch (err) {
    out = err.stdout ? String(err.stdout) : '';
  }
  return parseLines(out);
}

// Parse the line-based output of the system utility into a list of bot processes.
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
    // The first "word" of the line is the process ID, the rest is the command line.
    const match = line.match(/^(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const commandLine = match[2];
    if (!Number.isInteger(pid) || pid === selfPid) {
      continue;
    }
    // Safety net: exclude the stop script itself so it can never stop itself under any circumstances.
    if (commandLine.includes('stop-telegram.js')) {
      continue;
    }
    result.push({ pid, commandLine });
  }
  return result;
}

// Find the IDs of processes listening on the given TCP port. Returns an array of numbers (pid).
function findPortPids(port) {
  return isWindows ? findPortPidsOnWindows(port) : findPortPidsOnUnix(port);
}

function findPortPidsOnWindows(port) {
  // Get-NetTCPConnection returns connections in the Listen state on the given port; OwningProcess is the owner.
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
  // lsof lists the IDs of processes listening on the port (-t — pids only, -sTCP:LISTEN — listeners only).
  let out = '';
  try {
    out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  } catch (err) {
    // lsof returns code 1 when nothing is found — that is not an error, just an empty list.
    out = err.stdout ? String(err.stdout) : '';
  }
  return parsePidList(out);
}

// Parse "one pid per line" output into an array of numbers, excluding our own process.
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

// Send a graceful termination signal to the process.
function terminate(pid) {
  if (isWindows) {
    // taskkill without the /F flag asks the process to exit cleanly; /T also closes child processes.
    spawnSync('taskkill', ['/PID', String(pid), '/T'], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGTERM');
  }
}

// Forcibly kill the process (used when graceful termination did not work within the allotted pause).
function kill(pid) {
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

// Check whether a process with the given ID still exists.
function isAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 does nothing, it only checks
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // Collect both targets into a single pid → description map so the same process (the combined server
  // matches both the command-line marker and the port lookup) is not handled twice.
  const targets = new Map();
  for (const { pid, commandLine } of findBotProcesses()) {
    targets.set(pid, commandLine);
  }
  for (const pid of findPortPids(adminPort)) {
    if (!targets.has(pid)) {
      targets.set(pid, `process on admin port ${adminPort}`);
    }
  }

  if (!targets.size) {
    console.log(`No running Telegram bot and no process on port ${adminPort} found — nothing to stop.`);
    return;
  }

  console.log(`Processes found to stop: ${targets.size}. Sending graceful termination signal…`);
  for (const [pid, description] of targets) {
    console.log(`  Stopping process ${pid}: ${description}`);
    try {
      terminate(pid);
    } catch (err) {
      console.error(`  Failed to signal process ${pid}: ${err.message}`);
    }
  }

  if (softOnly) {
    console.log('--soft mode: only the graceful signal was sent. No forced kill is performed.');
    console.log('On Windows a background process may ignore the graceful signal — then run without --soft.');
    return;
  }

  // Wait for clean shutdown, then finish off whoever is still alive.
  console.log(`Waiting ${Math.round(GRACE_MS / 1000)} s for clean shutdown…`);
  await sleep(GRACE_MS);
  const survivors = [...targets.keys()].filter((pid) => isAlive(pid));
  if (!survivors.length) {
    console.log('All processes exited cleanly.');
    return;
  }
  console.log(`Did not exit cleanly: ${survivors.length}. Killing forcibly…`);
  for (const pid of survivors) {
    try {
      kill(pid);
      console.log(`  Process ${pid} killed forcibly.`);
    } catch (err) {
      console.error(`  Failed to stop process ${pid}: ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error('Stop error:', err.message);
  process.exit(1);
});
