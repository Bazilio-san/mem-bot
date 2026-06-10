#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');

const VERSION = '2026.06.10-0200';
console.log(`Update script version: ${VERSION}`);

// Name of this folder
const scriptDirName = path.basename(__dirname);
process.chdir(__dirname);
const CWD = process.cwd();

const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0].replace('T', '');
const now = () => new Date().toISOString().replace('T', ' ').substring(0, 19) + 'Z';
const runTimeLogFile = path.join(CWD, `deploy__${scriptDirName}__processing__${timestamp.slice(2, 14)}.log`);
const cumulativeLogFile = path.join(CWD, `deploy__${scriptDirName}__cumulative.log`);
const lastDeployLogFile = path.join(CWD, `deploy__${scriptDirName}__last_deploy.log`);
const appRuntimeLogFile = path.join(CWD, `${scriptDirName}-server.log`);

const DEFAULT_CONFIG = {
  branch: 'main',
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
 * Execute shell command.
 */
function execCommand (command, options = {}) {
  return execSync(command, {
    encoding: 'utf8',
    stdio: options.silent ? 'inherit' : 'pipe',
    shell: '/bin/bash',
    ...options,
  });
}

/**
 * Parse command line arguments.
 */
function parseArgs () {
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

function showHelp () {
  console.log(`
================================================================================
    MEM-BOT server deployment

    Usage:
        node update.js [Options]

    Options:

    -b|--branch <name>
        Git branch to deploy (default: main)
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

function readDotEnv () {
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

function getPackageName () {
  try {
    const packageJson = JSON.parse(fs.readFileSync(path.join(CWD, 'package.json'), 'utf8'));
    return packageJson.name || DEFAULT_CONFIG.serviceName;
  } catch {
    return DEFAULT_CONFIG.serviceName;
  }
}

function toBool (value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function loadConfig () {
  const envFromFile = readDotEnv();
  const env = { ...process.env, ...envFromFile };
  const packageName = getPackageName();

  const cfg = {
    ...DEFAULT_CONFIG,
    branch: env.DEPLOY_BRANCH || DEFAULT_CONFIG.branch,
    nodeEnv: env.NODE_ENV || DEFAULT_CONFIG.nodeEnv,
    serviceName: env.SERVICE_NAME || packageName,
    serviceStartCommand: env.SERVICE_START_COMMAND || DEFAULT_CONFIG.serviceStartCommand,
    serviceNodeEnv: env.SERVICE_NODE_ENV || env.NODE_ENV || DEFAULT_CONFIG.serviceNodeEnv,
    serviceLogFile: env.SERVICE_LOG_FILE || '',
    runMigrations: toBool(env.DEPLOY_RUN_MIGRATIONS || '0'),
    email: env.DEPLOY_NOTIFY_EMAIL || '',
  };

  return cfg;
}

function getDeploymentConfig (config) {
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

function systemctlServiceExists (name) {
  try {
    const serviceName = `${name}.service`;
    const output = execCommand(`systemctl list-unit-files --type=service "${serviceName}" --no-legend --no-pager`);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function getPm2Apps () {
  try {
    const output = execCommand('pm2 jlist');
    return Array.isArray(JSON.parse(output)) ? JSON.parse(output) : [];
  } catch {
    return [];
  }
}

function pm2ServiceExists (name) {
  return getPm2Apps().some((app) => app && app.name === name);
}

function getRepoInfo () {
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

function printCurrentBranch () {
  const info = getRepoInfo();
  logIt(
    `Current branch: ${colorG.lg(info.branch)}
Last commit: ${colorG.lg(info.headHash)}, date: ${colorG.lg(info.headDate)}
Commit message: ${colorG.lg(info.headCommitMessage)}`,
  );
  return info;
}

function getRemoteHash (branch) {
  return execCommand(`git rev-parse --verify origin/${branch}`).trim();
};

function reinstallDependencies () {
  logIt('INSTALL ROOT DEPENDENCIES', true);
  execCommand('npm ci');

  if (fs.existsSync(path.join(CWD, 'web', 'package.json'))) {
    execIt('npm --prefix web ci');
  }
}

function execIt (command) {
  return execCommand(command, { silent: true });
}

function buildProject () {
  if (!fs.existsSync(path.join(CWD, 'web', 'package.json'))) {
    logIt('Web package not found. Skipping web build.');
    return;
  }

  logIt('BUILD FRONTEND (web)', true);
  execCommand('npm --prefix web run build', { silent: true });
  logIt('Web build completed');
}

function runMigrations () {
  logIt('RUN DATABASE MIGRATIONS', true);
  execCommand('npm run migrate', { silent: true });
  logIt('Migrations completed');
}

function restartViaSystemctl (serviceName) {
  logIt(`Restarting service "${serviceName}" via systemctl`);
  execCommand(`systemctl restart "${serviceName}"`);
}

function restartViaPM2 (serviceName) {
  logIt(`Restarting process "${serviceName}" via pm2`);
  execCommand(`pm2 restart "${serviceName}" --update-env`);
}

function startFallbackProcess (deploymentConfig) {
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

function restartService (deploymentConfig) {
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

async function main () {
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
  const expectedBranch = args.expectedBranch || config.branch;

  logIt(`<status>MEM-BOT update <y>${colorG.y(deploymentConfig.serviceNamePM)}</y> ${now()}`);
  logIt(`Working directory: ${colorG.y(CWD)}`);
  logIt(`Service candidates: ${colorG.y(deploymentConfig.serviceCandidates.join(', '))}`);
  logIt(`Expected branch: ${colorG.y(expectedBranch)}`);
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

    if (before.branch !== expectedBranch) {
      needUpdate = true;
      reason += `${reason ? '. ' : ''}branch != expected (${before.branch} != ${expectedBranch})`;
      logIt(`Current branch is ${before.branch}. Switching to ${expectedBranch}.`);
      execCommand(`git fetch origin ${expectedBranch} --prune`);
      execCommand(`git checkout -B ${expectedBranch} origin/${expectedBranch}`);
      execCommand(`git reset --hard origin/${expectedBranch}`);
      execCommand('git clean -fd');
      printCurrentBranch();
    } else {
      logIt(`Pulling latest from origin/${expectedBranch}...`);
      execCommand(`git fetch origin ${expectedBranch} --prune`);
      const upstream = getRemoteHash(expectedBranch);
      if (before.headHash !== upstream) {
        needUpdate = true;
        reason += `${reason ? '. ' : ''}new commit in remote`;
        logIt('Remote commit changed. Hard reset to origin branch.');
        execCommand(`git checkout -B ${expectedBranch} origin/${expectedBranch}`);
        execCommand(`git reset --hard origin/${expectedBranch}`);
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
    } else {
      logIt('No changes detected. Update skipped.');
    }
  } catch (error) {
    const message = String(error.message).includes(error.stderr) ? error.message : [error.stderr, error.message].join('\n');
    logError(message);
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

main().then(() => {
  process.exit(0);
}).catch((error) => {
  logError(error.message);
  process.exit(1);
});
