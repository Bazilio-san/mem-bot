#!/usr/bin/env node

/**
 * Fast dependency gate for the Telegram-Web Playwright harness.
 *
 * The skill runs this first. It checks two things and prints a single machine-readable
 * status line on the last line of output so Claude Code can branch on it:
 *
 *   PLAYWRIGHT_OK         — the `playwright` package and the Chromium browser binary are
 *                           both present; nothing to do, proceed to launching the driver.
 *   PLAYWRIGHT_INSTALLED  — something was missing but this script installed it successfully.
 *   NEED_CLAUDE: <reason> — automatic installation failed; Claude Code must take over and
 *                           finish the installation intelligently (exit code 2).
 *
 * Exit codes: 0 on OK/INSTALLED, 2 when Claude Code must intervene.
 *
 * Usage: node .claude/skills/test-telegram-bot/scripts/ensure.js
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');

function run(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: projectRoot, stdio: 'inherit', shell: process.platform === 'win32' });
  return res.status === 0;
}

/** Returns the Chromium executable path if the `playwright` package resolves, else null. */
async function chromiumExecutable() {
  try {
    const { chromium } = await import('playwright');
    return chromium.executablePath();
  } catch {
    return null;
  }
}

async function status() {
  const exe = await chromiumExecutable();
  if (!exe) {
    return { ok: false, reason: 'playwright package is not installed or not resolvable' };
  }
  if (!fs.existsSync(exe)) {
    return { ok: false, reason: `Chromium binary is missing at ${exe}` };
  }
  return { ok: true, exe };
}

let s = await status();
if (s.ok) {
  console.log(`Chromium ready at ${s.exe}`);
  console.log('PLAYWRIGHT_OK');
  process.exit(0);
}

console.log(`Dependency check failed: ${s.reason}`);
console.log('Attempting automatic installation…');

// Install the npm package first (if that was what was missing), then the browser binary.
const installedPkg = run('npm', ['install', '-D', 'playwright']);
if (!installedPkg) {
  console.log('NEED_CLAUDE: `npm install -D playwright` failed — check the npm output above');
  process.exit(2);
}
const installedBrowser = run('npx', ['playwright', 'install', 'chromium']);
if (!installedBrowser) {
  console.log('NEED_CLAUDE: `npx playwright install chromium` failed — check the output above');
  process.exit(2);
}

s = await status();
if (s.ok) {
  console.log(`Chromium ready at ${s.exe}`);
  console.log('PLAYWRIGHT_INSTALLED');
  process.exit(0);
}

console.log(`NEED_CLAUDE: still not ready after install — ${s.reason}`);
process.exit(2);
