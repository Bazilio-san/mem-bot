#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '2026.06.11-0000';
console.log(`Update script version: ${VERSION}`);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Name of this folder
const scriptDirName = path.basename(__dirname);
process.chdir(__dirname);
const CWD = process.cwd();
// Deploy logs live in the parent directory (one level above the project), so they survive a hard reset/clean of
// the working tree. Only the running app's own log stays inside the project directory.
const VON = path.resolve(path.join(CWD, '..'));

const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0].replace('T', '');
const now = () => new Date().toISOString().replace('T', ' ').substring(0, 19) + 'Z';
const runTimeLogFile = path.join(VON, `deploy__${scriptDirName}__processing__${timestamp.slice(2, 14)}.log`);
const cumulativeLogFile = path.join(VON, `deploy__${scriptDirName}__cumulative.log`);
const lastDeployLogFile = path.join(VON, `deploy__${scriptDirName}__last_deploy.log`);
const appRuntimeLogFile = path.join(CWD, `${scriptDirName}-server.log`);

const DEFAULT_CONFIG = {
  branch: 'master',
  serviceName: 'mem-bot',
  serviceStartCommand: 'npm run server',
  serviceNodeEnv: 'production',
  nodeEnv: 'production',
  serviceLogFile: '',
};

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
};

const color = {};
const colorG = {};
['cyan', 'green', 'yellow', 'blue', 'red'].forEach((name) => {
  const short = name[0];
  color[short] = (text) => `${colors.bright}${colors[name]}${text}${colors.reset}`;
  color[`l${short}`] = (text) => `${colors[name]}${text}${colors.reset}`;
  colorG[short] = (text) => `${colors.bright}${colors[name]}${text}${colors.green}`;
  colorG[`l${short}`] = (text) => `${colors[name]}${text}${colors.green}`;
});

const echo = {
  g: (text) => console.log(color.g(text)),
  l: (text) => console.log(color.lg(text)),
  r: (text) => console.error(color.r(text)),
  y: (text) => console.log(color.y(text)),
  b: (text) => console.log(color.b(text)),
  ly: (text) => console.log(color.ly(text)),
  lg_no_newline: (msg) => process.stdout.write(color.lg(msg)),
};

let logBuffer = '';

// NVM environment loaded from .envrc. When present, build/install commands are wrapped with `source .envrc` so they
// run under the Node.js version pinned for this project rather than whatever node happens to be on PATH.
let setupScript = '';
let nodeVersion = null;
const DEFAULT_NODE_VERSION = '22.17.1';

const clearColors = (text) => text.replace(/\x1B\[[0-9;]*[mGKH]/g, '');
const clearHtmlColors = (text) => text.replace(/<\/?(red|y|g|r|status)>/g, '');

const logIt = (msg, isTitle = false) => {
  if (isTitle) {
    const length = msg.length + 2;
    const side = Math.max(0, Math.floor((60 - length) / 2));
    const paddingLeft = '─'.repeat(side);
    const paddingRight = '─'.repeat(Math.max(0, 60 - length - side));
    msg = `${paddingLeft} ${msg} ${paddingRight}`;
  }
  const msgForConsole = clearHtmlColors(msg);
  echo.g(msgForConsole);
  logBuffer += `${msg}\n`;
  fs.appendFileSync(runTimeLogFile, `${clearColors(msgForConsole)}\n`);
};

const logError = (msg) => {
  const formatted = `[ERROR] ${msg}`;
  console.error(color.r(formatted));
  logBuffer += `<red>${formatted}</red>\n`;
  fs.appendFileSync(cumulativeLogFile, `${formatted}\n`);
};

const truncateCumulativeLogIfNeeded = () => {
  const maxSize = 2 * 1024 * 1024;
  const keepTail = 10 * 1024;
  try {
    if (!fs.existsSync(cumulativeLogFile)) {
      return;
    }
    const stats = fs.statSync(cumulativeLogFile);
    if (stats.size <= maxSize) {
      return;
    }
    const fd = fs.openSync(cumulativeLogFile, 'r');
    const buffer = Buffer.alloc(keepTail);
    fs.readSync(fd, buffer, 0, keepTail, stats.size - keepTail);
    fs.closeSync(fd);
    const tail = buffer.toString('utf8').replace(/^[\r\n]*/, '');
    fs.writeFileSync(cumulativeLogFile, tail);
  } catch (error) {
    logError(`Failed to truncate cumulative log: ${error.message}`);
  }
};

const logTryUpdate = (updateReason = '') => {
  truncateCumulativeLogIfNeeded();
  const message = updateReason ? `Update reason: ${updateReason}` : now();
  fs.appendFileSync(cumulativeLogFile, `${message}\n`);
};

/**
 * Execute shell command. When withSetupScript is true and an .envrc was loaded, the command is prefixed with
 * `source .envrc &&` so it runs inside the project's NVM environment.
 */
function execCommand(command, options = {}, withSetupScript = false) {
  const fullCommand = setupScript && withSetupScript ? `${setupScript} && ${command}` : command;
  return execSync(fullCommand, {
    encoding: 'utf8',
    stdio: options.silent ? 'inherit' : 'pipe',
    shell: '/bin/bash',
    ...options,
  });
}

/**
 * Execute a command inside the loaded NVM environment (used for install/build/migrate steps).
 */
function execWithNODE(command, options = {}) {
  return execCommand(command, options, true);
}

/**
 * Load the NVM environment from .envrc, extracting the pinned Node.js version for logging. If there is no .envrc,
 * setupScript stays empty and execWithNODE behaves exactly like execCommand.
 */
function loadNVMEnvironment() {
  try {
    if (fs.existsSync('.envrc')) {
      const envrcContent = fs.readFileSync('.envrc', 'utf8');
      const nodeVersionMatch = envrcContent.match(/nvm use\s+([0-9.]+)/);
      if (nodeVersionMatch) {
        nodeVersion = nodeVersionMatch[1];
      }
      setupScript = 'source .envrc';
    }
  } catch (error) {
    logError(`Error loading .envrc file: ${error.message}`);
    throw error;
  }
}

/**
 * Parse command line arguments.
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    expectedBranch: null,
    force: false,
    migrate: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === '-b' || arg === '--branch') && i + 1 < args.length) {
      out.expectedBranch = args[++i];
    } else if (arg === '-f' || arg === '--force') {
      out.force = true;
    } else if (arg === '-m' || arg === '--migrate') {
      out.migrate = true;
    } else if (arg === '-?' || arg === '--help') {
      out.help = true;
    }
  }

  return out;
}

function showHelp() {
  console.log(`
================================================================================
    MEM-BOT server deployment

    Usage:
        node update.js [Options]

    Options:

    -b|--branch <name>
        Git branch to deploy (default: project default / remote branch)
    -f|--force
        Force reinstall, rebuild and restart even if there are no new commits
    -m|--migrate
        Run migrations after build
    -?|--help
        Display help

    Example:
        node update.js -b main --force --migrate
================================================================================
`);
}

function readDotEnv() {
  const envPath = path.join(CWD, '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }

  const values = {};
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (!text || text.startsWith('#')) {
      continue;
    }
    const match = text.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    let value = match[2].trim();
    const quoted = value.match(/^(['"])(.*)\1$/);
    if (quoted) {
      value = quoted[2];
    }
    values[key] = value;
  }
  return values;
}

function getPackageName() {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(CWD, 'package.json'), 'utf8'));
    return packageJson.name || DEFAULT_CONFIG.serviceName;
  } catch {
    return DEFAULT_CONFIG.serviceName;
  }
}

function toBool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

/**
 * Parse a minimal YAML file consisting of `key: value` pairs (no nesting). Quotes are stripped and the literals
 * `null`/`~` become an empty string. Enough for deploy/config.yml, which only holds flat scalar settings.
 */
function parseSimpleYAML(content) {
  const config = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const match = trimmed.match(/^\s*([^:]+?)\s*:\s*(.*)\s*$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    let value = (match[2] || '').replace(/^(['"])(.*)\1$/, '$2');
    if (value === 'null' || value === '~') {
      value = '';
    }
    config[key] = value;
  }
  return config;
}

/**
 * Read deploy/config.yml if it exists. Returns an empty object when the file is missing or unparseable. The .env
 * and process.env take precedence over these values in loadConfig.
 */
function readYamlConfig() {
  const configFile = path.join(CWD, 'deploy', 'config.yml');
  if (!fs.existsSync(configFile)) {
    return {};
  }
  try {
    return parseSimpleYAML(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    logError(`Could not parse config file ${configFile}: ${error.message}`);
    return {};
  }
}

function loadConfig() {
  // Load the NVM environment first so nodeVersion is known before any build command runs.
  loadNVMEnvironment();
  const envFromFile = readDotEnv();
  const env = { ...process.env, ...envFromFile };
  const yaml = readYamlConfig();
  const packageName = getPackageName();

  return {
    ...DEFAULT_CONFIG,
    branch: env.DEPLOY_BRANCH || yaml.branch || DEFAULT_CONFIG.branch,
    nodeEnv: env.NODE_ENV || DEFAULT_CONFIG.nodeEnv,
    serviceName: env.SERVICE_NAME || packageName,
    serviceStartCommand: env.SERVICE_START_COMMAND || DEFAULT_CONFIG.serviceStartCommand,
    serviceNodeEnv: env.SERVICE_NODE_ENV || env.NODE_ENV || DEFAULT_CONFIG.serviceNodeEnv,
    serviceLogFile: env.SERVICE_LOG_FILE || '',
    runMigrations: toBool(env.DEPLOY_RUN_MIGRATIONS || '0'),
    email: env.DEPLOY_NOTIFY_EMAIL || yaml.email || '',
    nodeVersion: yaml.nodeVersion || '',
  };
}

function getDeploymentConfig(config) {
  const serviceName = config.serviceName || DEFAULT_CONFIG.serviceName;
  const instance = (config.SERVICE_INSTANCE || '').trim();
  const serviceWithInstance = instance ? `${serviceName}--${instance}` : serviceName;
  const candidates = [
    serviceWithInstance,
    `${serviceName}-server`,
    `${serviceName}-bot`,
    `${serviceName}_server`,
    `${serviceName}_bot`,
  ];
  const uniq = [...new Set(candidates.filter(Boolean))];

  return {
    serviceCandidates: uniq,
    startCommand: config.serviceStartCommand,
    startNodeEnv: config.serviceNodeEnv || config.nodeEnv || 'production',
    runtimeLogFile: config.serviceLogFile || appRuntimeLogFile,
    migrateOnUpdate: toBool(config.runMigrations),
    serviceName,
    serviceNamePM: serviceWithInstance,
  };
}

function systemctlServiceExists(name) {
  try {
    const serviceName = `${name}.service`;
    const output = execCommand(`systemctl list-unit-files --type=service "${serviceName}" --no-legend --no-pager`);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function getPm2Apps() {
  try {
    const output = execCommand('pm2 jlist');
    return Array.isArray(JSON.parse(output)) ? JSON.parse(output) : [];
  } catch {
    return [];
  }
}

function pm2ServiceExists(name) {
  return getPm2Apps().some((app) => app && app.name === name);
}

function getRepoInfo() {
  const branch = execCommand('git rev-parse --abbrev-ref HEAD').trim();
  const headHash = execCommand('git rev-parse HEAD').trim();
  const headCommitMessage = execCommand(`git log -n 1 --pretty=format:%s ${headHash}`).trim();
  const headDate = execCommand(`git log -n 1 --format=%ci ${headHash}`).trim();
  return {
    branch,
    headHash,
    headCommitMessage,
    headDate,
  };
}

function printCurrentBranch() {
  const info = getRepoInfo();
  logIt(
    `Current branch: ${colorG.lg(info.branch)}
Last commit: ${colorG.lg(info.headHash)}, date: ${colorG.lg(info.headDate)}
Commit message: ${colorG.lg(info.headCommitMessage)}`,
  );
  return info;
}

function getRemoteHash(branch) {
  return execCommand(`git rev-parse --verify origin/${branch}`).trim();
}

function installWithFallback(label, primaryCommand, fallbackCommand) {
  try {
    logIt(`${label}: trying ${primaryCommand}`);
    execWithNODE(primaryCommand, { silent: true });
  } catch (error) {
    const shortError = String(error.message).replace(/\n/g, ' ');
    logIt(`${label}: ${primaryCommand} failed (${shortError})`);
    logIt(`${label}: trying ${fallbackCommand}`);
    execWithNODE(fallbackCommand, { silent: true });
  }
}

function getRemoteBranches() {
  const output = execCommand('git ls-remote --heads origin').trim();
  if (!output) {
    return [];
  }

  return output
    .split('\n')
    .map((line) => {
      const match = line.match(/\srefs\/heads\/(.+)$/);
      return match ? match[1] : '';
    })
    .filter(Boolean);
}

function resolveDeployBranch(requestedBranch) {
  const remoteBranches = getRemoteBranches();
  if (remoteBranches.includes(requestedBranch)) {
    return requestedBranch;
  }

  const remoteDefault = (() => {
    try {
      const remoteHead = execCommand('git symbolic-ref refs/remotes/origin/HEAD', { silent: true }).trim();
      return remoteHead ? remoteHead.replace(/^refs\/remotes\/origin\//, '') : '';
    } catch {
      return '';
    }
  })();

  if (remoteDefault && remoteBranches.includes(remoteDefault)) {
    return remoteDefault;
  }

  let localBranch = '';
  try {
    localBranch = execCommand('git rev-parse --abbrev-ref HEAD').trim();
  } catch {
    localBranch = '';
  }

  if (localBranch && remoteBranches.includes(localBranch)) {
    return localBranch;
  }

  if (remoteBranches.length > 0) {
    return remoteBranches[0];
  }

  throw new Error(`Remote branch "${requestedBranch}" not found in origin`);
}

function reinstallDependencies() {
  logIt('INSTALL ROOT DEPENDENCIES', true);
  installWithFallback('root', 'npm ci', 'npm install');

  const webDir = path.join(CWD, 'web');
  const webLock = path.join(webDir, 'package-lock.json');
  const hasWebLock = fs.existsSync(webLock);
  if (fs.existsSync(path.join(webDir, 'package.json'))) {
    if (hasWebLock) {
      installWithFallback('web', 'npm --prefix web ci', 'npm --prefix web install');
    } else {
      logIt('web: root workspace lockfile not found, running npm install');
      installWithFallback('web', 'npm --prefix web install', 'npm --prefix web install');
    }
  }
}

function buildProject() {
  if (!fs.existsSync(path.join(CWD, 'web', 'package.json'))) {
    logIt('Web package not found. Skipping web build.');
    return;
  }

  logIt('BUILD FRONTEND (web)', true);
  execWithNODE('npm --prefix web run build', { silent: true });
  logIt('Web build completed');
}

function runMigrations() {
  logIt('RUN DATABASE MIGRATIONS', true);
  execWithNODE('npm run migrate', { silent: true });
  logIt('Migrations completed');
}

function restartViaSystemctl(serviceName) {
  logIt(`Restarting service "${serviceName}" via systemctl`);
  execCommand(`systemctl restart "${serviceName}"`);
}

function restartViaPM2(serviceName) {
  logIt(`Restarting process "${serviceName}" via pm2`);
  execCommand(`pm2 restart "${serviceName}" --update-env`);
}

function startFallbackProcess(deploymentConfig) {
  logIt('No managed service found. Starting app as detached process.');
  try {
    if (fs.existsSync(path.join(CWD, 'scripts', 'stop-telegram.js'))) {
      execCommand('node scripts/stop-telegram.js --soft', { silent: true });
    }
  } catch (error) {
    logIt(`Could not run stop script before restart: ${error.message}`);
  }

  const logFile = deploymentConfig.runtimeLogFile || appRuntimeLogFile;
  const shellCommand = `${deploymentConfig.startCommand} >> "${logFile}" 2>&1`;
  const child = spawn('bash', ['-lc', shellCommand], {
    detached: true,
    stdio: 'ignore',
    cwd: CWD,
    env: {
      ...process.env,
      NODE_ENV: deploymentConfig.startNodeEnv,
    },
  });
  child.unref();
  logIt(`Started fallback process with PID ${child.pid}`);
}

function restartService(deploymentConfig) {
  for (const serviceName of deploymentConfig.serviceCandidates) {
    if (systemctlServiceExists(serviceName)) {
      restartViaSystemctl(serviceName);
      return;
    }
  }

  for (const serviceName of deploymentConfig.serviceCandidates) {
    if (pm2ServiceExists(serviceName)) {
      restartViaPM2(serviceName);
      return;
    }
  }

  startFallbackProcess(deploymentConfig);
}

/**
 * Expand the internal <red>/<y>/<g>/<r> markup (and [ERROR]) used in the log buffer into inline-styled HTML spans
 * for the email body, so the notification keeps the colour highlighting the terminal log has.
 */
const colorizeHTML = (text) =>
  text
    .replace(/<red>/g, '<span style="color:#ff0000;">')
    .replace(/<\/red>/g, '</span>')
    .replace(/<y>/g, '<span style="background-color:#ffff00;">')
    .replace(/<\/y>/g, '</span>')
    .replace(/<g>/g, '<span style="background-color:#00ff00;">')
    .replace(/<\/g>/g, '</span>')
    .replace(/<r>/g, '<span style="background-color:#ff0000; color:#ffffff;">')
    .replace(/<\/r>/g, '</span>')
    .replace(/\[ERROR]/g, '<span style="color:#ffffff; background-color: #ff0000">[ERROR]</span>');

/**
 * Send the build/deploy notification email to one or more comma-separated addresses via the system `mail` command.
 * Does nothing when no addresses are configured. Each address is attempted independently; a failure for one address
 * is logged and does not abort the others.
 */
async function sendBuildNotification(emails, status, body, serviceName) {
  if (!emails) {
    return;
  }
  let statusMark = '';
  if (status === 'FAIL') {
    statusMark = `<r>FAIL</r> `;
  } else if (status === 'SUCCESS') {
    statusMark = `<g>SUCCESS</g> `;
  }
  body = body.replace('<status>', statusMark);

  const hostname = os.hostname();
  const htmlContent = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "https://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
    <meta content="text/html; charset=UTF-8" http-equiv="Content-Type">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${status} Update ${serviceName} (on ${hostname})</title>
</head>
<body>
<pre>
${colorizeHTML(clearColors(body))}
</pre></body></html>`;

  const emailArray = emails
    .split(',')
    .map((email) => email.trim())
    .filter((email) => email);

  for (let i = 0; i < emailArray.length; i++) {
    const emailAddress = emailArray[i];
    try {
      logIt(`Sending update notification to: ${emailAddress}`);
      const subject = `${status} Update: ${serviceName} (on ${hostname})`;
      const command = `mail -a "Content-Type: text/html; charset=UTF-8" -s "${subject.replace(/"/g, '\\"')}" "${emailAddress}"`;
      const child = spawn('/bin/bash', ['-lc', command], { stdio: ['pipe', 'inherit', 'inherit'] });
      child.stdin.write(htmlContent);
      child.stdin.end();

      await new Promise((resolve, reject) => {
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`mail exit code ${code}`))));
        child.on('error', reject);
      });
    } catch (error) {
      logError(`Failed to send email to ${emailAddress}: ${error.message}`);
    }
  }
}

async function main() {
  truncateCumulativeLogIfNeeded();
  fs.writeFileSync(runTimeLogFile, '');
  logTryUpdate();

  const args = parseArgs();
  if (args.help) {
    showHelp();
    return;
  }

  const config = loadConfig();
  const deploymentConfig = getDeploymentConfig(config);

  // Decide which Node.js version label to report: .envrc wins, then deploy/config.yml, then the built-in default.
  let nodeVersionFrom = ' DEFAULT';
  if (nodeVersion) {
    nodeVersionFrom = ' .envrc';
  } else if (config.nodeVersion) {
    ({ nodeVersion } = config);
    nodeVersionFrom = ' deploy/config.yml';
  }
  logIt(`Using Node.js version: ${colorG.y(nodeVersion || DEFAULT_NODE_VERSION)}${nodeVersionFrom}`);

  const expectedBranch = args.expectedBranch || config.branch;
  const deployBranch = resolveDeployBranch(expectedBranch);
  if (expectedBranch !== deployBranch) {
    logIt(`Remote branch "${expectedBranch}" not found. Using "${deployBranch}" instead.`);
  }

  logIt(`<status>MEM-BOT update <y>${colorG.y(deploymentConfig.serviceNamePM)}</y> ${now()}`);
  logIt(`Working directory: ${colorG.y(CWD)}`);
  logIt(`Service candidates: ${colorG.y(deploymentConfig.serviceCandidates.join(', '))}`);
  logIt(`Expected branch: ${colorG.y(deployBranch)}`);
  logIt(`Start command: ${colorG.y(deploymentConfig.startCommand)} (${deploymentConfig.startNodeEnv})`);

  let runDeployedLogFile = false;
  try {
    const status = execCommand('git status --porcelain').trim();
    if (status.length > 0) {
      logIt('Found uncommitted changes. Cleaning working tree...');
      execCommand('git reset --hard HEAD');
      execCommand('git clean -fd');
    }

    const before = getRepoInfo();
    let needUpdate = args.force;
    let reason = args.force ? 'force' : '';

    if (before.branch !== deployBranch) {
      needUpdate = true;
      reason += `${reason ? '. ' : ''}branch != expected (${before.branch} != ${deployBranch})`;
      logIt(`Current branch is ${before.branch}. Switching to ${deployBranch}.`);
      execCommand(`git fetch origin ${deployBranch} --prune`);
      execCommand(`git checkout -B ${deployBranch} origin/${deployBranch}`);
      execCommand(`git reset --hard origin/${deployBranch}`);
      execCommand('git clean -fd');
      printCurrentBranch();
    } else {
      logIt(`Pulling latest from origin/${deployBranch}...`);
      execCommand(`git fetch origin ${deployBranch} --prune`);
      const upstream = getRemoteHash(deployBranch);
      if (before.headHash !== upstream) {
        needUpdate = true;
        reason += `${reason ? '. ' : ''}new commit in remote`;
        logIt('Remote commit changed. Hard reset to origin branch.');
        execCommand(`git checkout -B ${deployBranch} origin/${deployBranch}`);
        execCommand(`git reset --hard origin/${deployBranch}`);
        execCommand('git clean -fd');
        printCurrentBranch();
      }
    }

    if (needUpdate) {
      logTryUpdate(reason);
      reinstallDependencies();
      buildProject();

      if (args.migrate || deploymentConfig.migrateOnUpdate) {
        runMigrations();
      }

      restartService(deploymentConfig);
      runDeployedLogFile = true;
      logIt(`Update completed at ${new Date().toISOString().replace('T', ' ').substring(0, 19)}`);
      if (config.email) {
        await sendBuildNotification(config.email, 'SUCCESS', logBuffer, deploymentConfig.serviceName);
      } else {
        logIt('EMAIL not configured');
      }
    } else {
      logIt('No changes detected. Update skipped.');
    }
  } catch (error) {
    const message = String(error.message).includes(error.stderr)
      ? error.message
      : [error.stderr, error.message].join('\n');
    logError(message);
    if (config.email) {
      await sendBuildNotification(config.email, 'FAIL', logBuffer, deploymentConfig.serviceName);
    }
    throw error;
  } finally {
    logIt('#FINISH#');
    if (runDeployedLogFile) {
      fs.copyFileSync(runTimeLogFile, lastDeployLogFile);
    }
    execCommand(`rm -f "${runTimeLogFile}"`);
  }
}

process.on('SIGINT', () => {
  console.log('\nUpdate process interrupted');
  process.exit(1);
});

process.on('SIGTERM', () => {
  console.log('\nUpdate process terminated');
  process.exit(1);
});

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    logError(error.message);
    process.exit(1);
  });
