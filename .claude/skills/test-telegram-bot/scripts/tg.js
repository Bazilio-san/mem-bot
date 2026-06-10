#!/usr/bin/env node

/**
 * Thin CLI for the Telegram-Web driver daemon (driver.js). Each command is one HTTP call to
 * the local driver, with the JSON result printed to stdout so Claude Code can read it.
 *
 * Commands:
 *   status            print the current screen state {qrVisible, loggedIn, chatOpen, url}
 *   goto [peer]       open a peer (default: the configured bot); waits for the message box
 *   send "<text>"     type the text into the message box and send it
 *   last [n]          print the last N message bubbles (default 3)
 *   voice [seconds]   record+send a voice message from the fake-audio WAV (default 3s)
 *   shot [name]       save a screenshot under .browser-session/shots/<name>.png
 *   stop              shut the driver (and browser) down
 *
 * Environment: TG_PW_PORT (default 39517).
 */

const PORT = Number(process.env.TG_PW_PORT) || 39517;
const BASE = `http://127.0.0.1:${PORT}`;

const [cmd, ...rest] = process.argv.slice(2);

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

async function main() {
  switch (cmd) {
    case 'status':
      return call('GET', '/status');
    case 'debug':
      return call('GET', '/debug');
    case 'goto':
      return call('POST', '/goto', { peer: rest[0] });
    case 'send':
      if (!rest.length) die('usage: tg.js send "<text>"');
      return call('POST', '/send', { text: rest.join(' ') });
    case 'last':
      return call('GET', `/last?n=${encodeURIComponent(rest[0] || 3)}`);
    case 'voice':
      return call('POST', '/voice', { seconds: rest[0] });
    case 'shot':
      return call('POST', '/shot', { name: rest[0] });
    case 'stop':
      return call('POST', '/shutdown', {});
    default:
      die(`unknown command: ${cmd || '(none)'}\nrun one of: status goto send last voice shot stop`);
  }
}

main()
  .then((out) => console.log(JSON.stringify(out, null, 2)))
  .catch((e) => die(`driver not reachable on ${BASE} (${e.message}). Is driver.js running?`));
