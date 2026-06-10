# srv.cjs
Universal script for managing systemd services of Node.js applications.

## Features

- ✅ **Universal invocation**: Works the same when run from the project root or from the `deploy/` folder
- ✅ **Automatic Node.js version detection**: Priority is CLI param → .envrc → current version
- ✅ **Smart Node.js lookup**: NVM paths → system paths
- ✅ **Automatic config reading**: package.json, config for port
- ✅ **systemd unit generation**: Correct paths and settings
- ✅ **Process management**: Stops processes bound to ports on deletion
- ✅ **Instance support**: Service name can be extended with suffix `--<instance>` from `.env` (variable `SERVICE_INSTANCE`)

## Requirements and how to run

- The file is executable: `deploy/srv.cjs` has a shebang `#!/usr/bin/env node`. On the server, make sure the file has execute permissions:

```bash
chmod +x deploy/srv.cjs
```

- You can run it in two equivalent ways:

```bash
# From the project root or from the deploy/ folder
./deploy/srv.cjs <command> [options]

# Or via node
node deploy/srv.cjs <command> [options]
```

## Commands

### Install service

```bash
# Basic install (auto-detect everything)
./deploy/srv.cjs install
./deploy/srv.cjs i

# With a custom service name
./deploy/srv.cjs install -n my-custom-service

# With a specific Node.js version
./deploy/srv.cjs install -v 20.10.0

# Combined params
./deploy/srv.cjs i -n custom-service -v 22.17.1
```

**What happens:**
1. Node.js version and path to the binary are determined
2. `package.json` is read to get `main` and `name`
3. A systemd unit file is generated at `/etc/systemd/system/<service_name>.service`
4. `systemctl daemon-reload` is executed
5. `systemctl enable --now <service_name>` is executed

### Delete service

```bash
# Auto-detect port from config
./deploy/srv.cjs delete
./deploy/srv.cjs d

# With a custom service name
./deploy/srv.cjs delete -n custom-service

# With a specific port
./deploy/srv.cjs delete -p 1234

# Combined params
./deploy/srv.cjs d -n custom-service -p 1234
```

**What happens:**
1. Port is determined from config or CLI param
2. `systemctl stop <service_name>` is executed
3. `systemctl disable <service_name>` is executed
4. Unit file `/etc/systemd/system/<service_name>.service` is removed
5. Process on the specified port is terminated (if exists)
6. `systemctl daemon-reload` is executed

### Reinstall service

```bash
# Full reinstall
./deploy/srv.cjs reinstall
./deploy/srv.cjs r

# With params
./deploy/srv.cjs r -n custom-service -v 22.17.1 -p 1234
```

**What happens:**
1. Performs a full deletion (as in `delete`)
2. Performs a full installation (as in `install`)
3. Shows status and starts tailing logs

## How it works

### Resolving working directories

The script computes directories by itself (within Node.js runtime):

```javascript
// deploy/srv.cjs
const SCRIPT_DIR = __dirname;           // /path/to/project/deploy/
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..'); // /path/to/project/
process.chdir(PROJECT_ROOT);
```

**Result**: Regardless of where it's launched, the script always uses the project root for:
- Reading `package.json`
- Reading `.envrc`
- Reading configuration
- Setting `WorkingDirectory` in the systemd unit

### Node.js version detection algorithm

1. **CLI param `-v <version>`** (highest priority)
   ```bash
   ./deploy/srv.cjs install -v 20.10.0
   ```

2. **`.envrc` file in the project root**
   ```bash
   # Looks for a line like:
   nvm use 22.17.1
   # Extracts: 22.17.1
   ```

3. **Current Node.js version** (fallback)
   ```bash
   node -v  # For example: v22.17.1 → 22.17.1
   ```

### Node.js binary path lookup

1. **NVM path** (priority)
   ```bash
   $HOME/.nvm/versions/node/v22.17.1/bin/node
   ```

2. **System path** (fallback)
   ```bash
   which node  # For example: /usr/bin/node
   ```

### Service name resolution

1. **CLI param `-n <name>`** (priority)
2. **`.env` → `SERVICE_NAME`** (if provided)
3. **`name` value from package.json** (default)
4. Additionally: if `SERVICE_INSTANCE` is set in `.env`, the final name becomes `<name>--<instance>`

### Port resolution

1. **CLI param `-p <port>`** (priority)
2. **`config.webServer.port` value** (automatic)
   ```javascript
   // Executed from the project root:
   const config = require('config');
   console.log(config.webServer?.port);
   ```


## Generated systemd unit file

```ini
[Unit]
Description=<serviceName>
After=network.target
StartLimitIntervalSec=0

[Service]
User=root
WorkingDirectory=/path/to/project/root
EnvironmentFile=/path/to/project/root/.env
ExecStart=/root/.nvm/versions/node/v22.17.1/bin/node <package.json.main>
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## Debugging and monitoring


### Viewing logs

```bash
# Short status with logs
systemctl -l status <serviceName>

# Latest logs (compact output)
journalctl -o cat -u <serviceName>

# Follow logs in real time (equivalent to what `reinstall` starts)
journalctl -o cat -xefu <serviceName>

# Logs for the last hour
journalctl -u <serviceName> --since "1 hour ago"
```

### Manual control

```bash
sudo systemctl start|stop|restart|disable|status <serviceName>
```
