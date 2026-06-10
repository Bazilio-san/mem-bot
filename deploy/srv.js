#!/usr/bin/env node

/**
 * srv.cjs - Unified systemd service management script (Node.js version)
 * Analog of deploy/srv.sh
 * Can be run from project root or from deploy/ directory
 */
const version = '2025-11-26-08:46';

/* Colors for output */
const c = '\x1b[1;36m', lc = '\x1b[0;36m';
const g = '\x1b[1;32m', lg = '\x1b[0;32m';
const m = '\x1b[1;35m', lm = '\x1b[0;35m';
const r = '\x1b[1;31m', lr = '\x1b[0;31m';
const y = '\x1b[1;33m', ly = '\x1b[0;33m';
const c0 = '\x1b[0m';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn, spawnSync } = require('child_process');

/* Script configuration */
const SCRIPT_DIR = __dirname; // deploy/
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..'); // Project root
process.chdir(PROJECT_ROOT);

let SERVICE_NAME = '';
let NODE_VERSION = '';
let PORT = '';
let COMMAND = '';

const trim = (v) => String(v || '').trim();

/* Helpers */
function log (...args) { console.log(...args); }

function err (...args) { console.error(...args); }

function sh (cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch (e) {
    // Attach stderr to error message for easier diagnosis
    const stderr = e.stderr ? e.stderr.toString() : '';
    const stdout = e.stdout ? e.stdout.toString() : '';
    const msg = stderr || stdout || e.message;
    const errObj = new Error(msg);
    errObj.code = e.status;
    throw errObj;
  }
}

function showUsage () {
  const usage = `
Usage:
  ${process.argv[1]} i|install [-n <service_name>] [-v <node_version>]
  ${process.argv[1]} d|delete  [-n <service_name>] [-p <port>]
  ${process.argv[1]} r|reinstall [-n <service_name>] [-p <port>] [-v <node_version>]

Commands:
  i, install    - Install and start systemd service
  d, delete     - Stop and remove systemd service
  r, reinstall  - Reinstall service (delete + install)

Options:
  -n <name>     - Alternative service name (default: from package.json)
  -v <version>  - Node.js version (default: auto-detected)
  -p <port>     - Port number for service cleanup (default: auto-detected)

Working directories:
  Script location: ${SCRIPT_DIR}
  Project root: ${PROJECT_ROOT}
`.trim();
  log(usage);
}

function serviceExists (name) {
  try {
    const cmd = `systemctl list-units --all -t service --full --no-legend ${name}.service`;
    const out = sh(cmd, { shell: '/bin/bash' });
    const re = new RegExp(`\\b${name}\\.service\\b`);
    return re.test(out);
  } catch {
    return false;
  }
}

function readFileSafe (p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function detectNodeVersion () {
  let version = '';
  if (NODE_VERSION) {
    version = NODE_VERSION;
    err(`${c}**** Using provided Node.js version: ${g}${version}${c} ****${c0}`);
  } else {
    const envrc = path.join(PROJECT_ROOT, '.envrc');
    if (fs.existsSync(envrc)) {
      const content = readFileSafe(envrc);
      const m = content.match(/^\s*nvm\s+use\s+([0-9]+\.[0-9]+\.[0-9]+)/m);
      if (m) {
        version = m[1];
        err(`${c}**** Found Node.js version in .envrc: ${g}${version}${c} ****${c0}`);
      }
    }
  }
  if (!version) {
    try {
      const v = sh('node -v 2>/dev/null', { shell: '/bin/bash' });
      version = v.replace(/^v/, '');
      if (version) {
        err(`${c}**** Using current Node.js version: ${g}${version}${c} ****${c0}`);
      }
    } catch {
      // ignore
    }
  }
  if (!version) {
    err(`${r}**** Error: Could not detect Node.js version ****${c0}`);
    process.exit(1);
  }
  return version;
}

function findNodePath (version) {
  // Try NVM path first
  const nvmPath = path.join(os.homedir(), '.nvm', 'versions', 'node', `v${version}`, 'bin', 'node');
  if (fs.existsSync(nvmPath)) {
    err(`${c}**** Found Node.js at NVM path: ${g}${nvmPath}${c} ****${c0}`);
    return nvmPath;
  }
  // Try system node
  try {
    const whichNode = sh('which node 2>/dev/null', { shell: '/bin/bash' });
    if (whichNode) {
      let currentVersion = '';
      try { currentVersion = sh('node -v 2>/dev/null', { shell: '/bin/bash' }).replace(/^v/, ''); } catch {}
      if (currentVersion === version) {
        err(`${c}**** Found Node.js at system path: ${g}${whichNode}${c} ****${c0}`);
      } else {
        const warn = `
${y}**** Warning: System Node.js version (${currentVersion}) differs from target (${version}) ****${c0}
${c}**** Using system path anyway: ${g}${whichNode}${c} ****${c0}
`.trim();
        err(warn);
      }
      return whichNode;
    }
  } catch {
    // ignore
  }
  err(`${r}**** Error: Could not find Node.js binary ****${c0}`);
  process.exit(1);
}

function parsePackageJson (field) {
  const packageFile = path.join(PROJECT_ROOT, 'package.json');
  if (!fs.existsSync(packageFile)) {
    err(`${r}**** Error: package.json not found at ${packageFile} ****${c0}`);
    process.exit(1);
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    const value = pkg[field] || '';
    if (!value) throw new Error('empty');
    return value;
  } catch {
    err(`${r}**** Error: Could not parse ${field} from package.json ****${c0}`);
    process.exit(1);
  }
}

// Parse .env in project root to extract variables
function parseDotEnvVars () {
  const envPath = path.join(PROJECT_ROOT, '.env');
  const result = {};
  if (!fs.existsSync(envPath)) return result;
  try {
    const content = fs.readFileSync(envPath, 'utf8');
    // Simple line parser, ignores comments and empty lines
    for (const line of content.split(/\r?\n/)) {
      if (!line || /^\s*#/.test(line)) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      // remove surrounding quotes if present
      let val = m[2];
      const q = val[0];
      if ((q === '"' || q === '\'') && val[val.length - 1] === q) {
        val = val.slice(1, -1);
      }
      result[key] = val;
    }
  } catch {}
  return result;
}

// Return full service name aligned with update.cjs logic: base name plus optional "--<instance>"
function getServiceName () {
  // Highest priority: CLI parameter (-n)
  let baseName = trim(SERVICE_NAME);
  if (baseName) {
    return baseName;
  }
  let instance = '';

  const envVars = parseDotEnvVars();

  // If base name not provided via CLI, try from .env, then from package.json
  if (!baseName) {
    baseName = trim(envVars.SERVICE_NAME);
  }
  if (!baseName) {
    baseName = parsePackageJson('name');
  }

  // Instance suffix from .env if present
  const rawInstance = trim(envVars.SERVICE_INSTANCE);
  if (rawInstance) {
    instance = `--${rawInstance}`;
  }

  return `${baseName}${instance}`;
}

async function detectPort () {
  if (PORT) return PORT;
  // Try to load config from project root
  try {
    // Ensure module resolution relative to project root
    const createRequire = require('module').createRequire;
    const projectRequire = createRequire(path.join(PROJECT_ROOT, 'package.json'));
    let cfg;
    try {
      cfg = projectRequire('config');
    } catch (e) {
      // Try dynamic import
      cfg = await new Function('p', 'return import(p)')('config');
      cfg = cfg.default || cfg;
    }
    const port = cfg?.webServer?.port || cfg?.server?.port;
    if (port && String(port).match(/^[0-9]{2,5}$/)) return String(port);
  } catch (e) {
    // ignore, will fail below
  }
  err(`${r}**** Error: Could not detect port from config ****${c0}`);
  process.exit(1);
}

function generateUnitFile (serviceName, nodePath, mainFile) {
  const workingDir = PROJECT_ROOT;
  const serviceFile = `/etc/systemd/system/${serviceName}.service`;
  const content = `
[Unit]
Description=${serviceName}
After=network.target
# https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html#StartLimitIntervalSec=interval
StartLimitIntervalSec=0

[Service]
User=root
WorkingDirectory=${workingDir}
EnvironmentFile=${workingDir}/.env
ExecStart=${nodePath} ${mainFile}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`.trimStart();
  fs.writeFileSync(serviceFile, content, 'utf8');
  const info = `
${c}**** Generated unit file for ${g}${serviceName}${c} ****${c0}
${lc}   WorkingDirectory: ${g}${workingDir}${c0}
${lc}   ExecStart: ${g}${nodePath} ${mainFile}${c0}
${lc}   View Service file: ${g}cat ${serviceFile}${c0}
`.trim();
  err(info);
}

function systemctl (args, inherit = false) {
  if (inherit) {
    const p = spawn('systemctl', args.split(/\s+/).filter(Boolean), { stdio: 'inherit' });
    return new Promise((resolve, reject) => {
      p.on('exit', code => code === 0 ? resolve() : reject(new Error(`systemctl ${args} exited with ${code}`)));
    });
  } else {
    sh(`systemctl ${args}`);
  }
}

async function installService () {
  log(`${c}**** Installing service ****${c0}`);
  const nodeVersion = detectNodeVersion();
  const nodePath = findNodePath(nodeVersion);
  const mainFile = parsePackageJson('main');
  const serviceName = getServiceName();

  const cfgInfo = `
${c}**** Service configuration ****${c0}
${lc}   Service name: ${g}${serviceName}${c0}
${lc}   Node.js version: ${g}${nodeVersion}${c0}
${lc}   Node.js path: ${g}${nodePath}${c0}
${lc}   Main file: ${g}${mainFile}${c0}
${lc}   Project root: ${g}${PROJECT_ROOT}${c0}
`.trim();
  err(cfgInfo);

  if (serviceExists(serviceName)) {
    err(`${c}**** Service ${g}${serviceName}${c} already installed ****${c0}`);
    return;
  }

  generateUnitFile(serviceName, nodePath, mainFile);

  // Reload systemd and enable service
  sh('systemctl daemon-reload');
  try {
    sh(`systemctl enable --now ${serviceName}`);
  } catch (e) {
    const msg = `
${r}**** Error: Failed to install service ${serviceName} ****${c0}
${e.message || String(e)}
`.trim();
    err(msg);
    process.exit(1);
  }

  const post = `
${c}**** Service ${g}${serviceName}${c} installed and started ****${c0}

${m}View status: ${y}systemctl -l status ${serviceName}${c0}
${m}View logs: ${y}journalctl -o cat -xefu ${serviceName}${c0}
`.trim();
  log(post);
}

async function deleteService () {
  const serviceName = getServiceName();
  const port = await detectPort();
  log(`${c}**** Removing service ${g}${serviceName}${c} listening on port ${g}${port}${c} ****${c0}`);

  if (!serviceExists(serviceName)) {
    log(`${c}**** Service ${g}${serviceName}${c} not found ****${c0}`);
    return;
  }

  try { sh(`systemctl stop ${serviceName}`); } catch {}
  try { sh(`systemctl disable ${serviceName}`); } catch {}

  try { fs.unlinkSync(`/etc/systemd/system/${serviceName}.service`); } catch {}

  // Kill any remaining process on the port
  try {
    const out = sh(`lsof -i tcp:${port} 2>/dev/null | grep ${port} | awk '{print $2}' | head -1`, { shell: '/bin/bash' });
    if (out) {
      log(`${c}**** Killing process ${g}${out}${c} on port ${g}${port}${c} ****${c0}`);
      try { sh(`kill -9 ${out}`); } catch {}
    }
  } catch {}

  try { sh('systemctl daemon-reload'); } catch {}
  log(`${c}**** Service ${g}${serviceName}${c} removed ****${c0}`);
}

async function reinstallService () {
  log(`${c}**** Reinstalling service ****${c0}`);
  await deleteService();
  await installService();
  const serviceName = getServiceName();
  log(`${c}**** Service ${g}${serviceName}${c} reinstalled ****${c0}`);

  try {
    await systemctl(`status ${serviceName}`, true);
  } catch {}
  log(`\n${m}Following logs (Ctrl+C to exit): ${y}journalctl -o cat -xefu ${serviceName}${c0}`);
  // Follow logs until user interrupts
  const p = spawn('journalctl', ['-o', 'cat', '-xefu', serviceName], { stdio: 'inherit' });
  await new Promise(resolve => p.on('exit', resolve));
}

/* Argument parsing */
async function main () {
  if (process.argv.length <= 2) {
    showUsage();
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const cmd = args.shift();
  switch (cmd) {
    case 'i':
    case 'install':
      COMMAND = 'install';
      break;
    case 'd':
    case 'delete':
      COMMAND = 'delete';
      break;
    case 'r':
    case 'reinstall':
      COMMAND = 'reinstall';
      break;
    default:
      err(`${r}**** Error: Unknown command '${cmd}' ****${c0}`);
      showUsage();
      process.exit(1);
  }

  // Parse options
  while (args.length > 0) {
    const a = args.shift();
    switch (a) {
      case '-n':
        SERVICE_NAME = args.shift() || '';
        break;
      case '-v':
        NODE_VERSION = args.shift() || '';
        break;
      case '-p':
        PORT = args.shift() || '';
        break;
      default:
        err(`${r}**** Error: Unknown option '${a}' ****${c0}`);
        showUsage();
        process.exit(1);
    }
  }

  switch (COMMAND) {
    case 'install':
      await installService();
      break;
    case 'delete':
      await deleteService();
      break;
    case 'reinstall':
      await reinstallService();
      break;
  }
}

main().then(() => {
  process.exit(0);
}).catch(e => {
  err(String(e && e.message ? e.message : e));
  process.exit(1);
});
