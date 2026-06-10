#!/usr/bin/env node

/**
 * Long-running Telegram-Web driver for end-to-end bot testing.
 *
 * Why a daemon? A persistent browser profile can be opened by only one process at a time,
 * and Claude Code drives the bot across many separate Bash calls. So we launch the browser
 * ONCE here, keep it open, and expose a tiny localhost HTTP API that the `tg.js` CLI (or
 * `curl`) calls for each action. This also keeps the page alive between calls, which is the
 * only way to watch a streaming draft grow in place.
 *
 * The browser runs headful (visible) with a persistent profile in `.browser-session/`, so the
 * Telegram login survives across runs. Chromium is started with fake-media flags so a WAV file
 * can stand in for the microphone, letting us send a real voice message without a live mic.
 *
 * Start it in the background:  node .claude/skills/test-telegram-bot/scripts/driver.js
 * Then talk to it:            node .claude/skills/test-telegram-bot/scripts/tg.js status
 *
 * Environment:
 *   TG_PW_PORT   HTTP port (default 39517)
 *   TG_PW_PEER   override the peer to open (default: config telegram.botUsername)
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import config from 'config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');

const PORT = Number(process.env.TG_PW_PORT) || 39517;
const PEER = process.env.TG_PW_PEER || config.get('telegram.botUsername');
const USER_DATA_DIR = path.resolve(projectRoot, '.browser-session');
const SHOTS_DIR = path.resolve(USER_DATA_DIR, 'shots');
const WAV_PATH = path.resolve(__dirname, '..', 'assets', 'voice-sample.wav');
const WEB_BASE = 'https://web.telegram.org/k/';

/**
 * Central selector map for Telegram Web "K" (the /k/ client). Tweak here if Telegram ships a
 * markup change. Signals are intentionally redundant so detection survives minor reshuffles.
 */
const SEL = {
  // Login screen signal: <body> carries `has-auth-pages` on any auth page (QR/phone/passkey).
  // The QR variant additionally renders a <canvas> and the "Log in by QR Code" copy.
  qrCanvas: 'canvas',
  // Logged-in / chat signals
  chatList: '#folders-container, .chatlist, .sidebar-header',
  messageInput: 'div.input-message-input[data-peer-id]',
  sendButton: '.btn-send',
  // Record button = the main circular button while the input is EMPTY (it carries `.record`);
  // once you type, the same button drops `.record` and becomes the text-send button.
  recordButton: '.btn-send.record',
  bubblesInner: '.bubbles-inner',
  bubble: '.bubble[data-mid]',
};

let context;
let page;

function log(...a) {
  console.log(`[tg-driver]`, ...a);
}

async function ensurePage() {
  if (!page || page.isClosed()) {
    page = await context.newPage();
    await page.goto(WEB_BASE, { waitUntil: 'domcontentloaded' });
  }
  return page;
}

/** Probe the DOM and classify the current screen. */
async function getStatus() {
  const p = await ensurePage();
  const res = await p.evaluate((sel) => {
    const has = (s) => !!document.querySelector(s);
    const text = (document.body.innerText || '').slice(0, 4000);
    // Fast, reliable signal: Telegram Web "K" puts `has-auth-pages` on <body> for ANY login
    // screen and removes it once authenticated. That alone tells logged-in vs not, instantly.
    const authScreen = document.body.classList.contains('has-auth-pages');
    const qrByText = /Log in by QR|Scan with Telegram|QR Code|Войти по QR|QR-?код/i.test(text);
    const qrVisible = authScreen && qrByText && has('canvas');
    const loggedIn = !authScreen;
    const chatOpen = has(sel.messageInput);
    return { url: location.href, authScreen, qrVisible, loggedIn, chatOpen };
  }, SEL);
  return res;
}

/** Raw DOM probe to refine selectors during development. */
async function debug() {
  const p = await ensurePage();
  return p.evaluate(() => {
    const probe = [
      'canvas',
      '.qr-container',
      '.input-message-input[data-peer-id]',
      'ul.chatlist',
      '.chatlist-chat',
      '#folders-container',
      '.sidebar-header',
      '.btn-send',
      '.bubbles-inner',
    ];
    const found = {};
    for (const s of probe) found[s] = document.querySelectorAll(s).length;
    const btnRow = document.querySelector('.btn-send-container, .rows-wrapper .new-message-wrapper, .chat-input');
    const buttons = Array.from(document.querySelectorAll('.chat-input button, .btn-send-container button, .chat-input .btn-icon')).map(
      (b) => ({ cls: b.className, title: b.getAttribute('title') || b.getAttribute('aria-label') || '' }),
    );
    return {
      url: location.href,
      bodyClass: document.body.className,
      found,
      buttons,
      btnRowHtml: btnRow ? btnRow.outerHTML.slice(0, 1500) : null,
      text: (document.body.innerText || '').slice(0, 200),
    };
  });
}

/** Navigate the SPA to a peer by setting the URL hash (webk opens it on hashchange). */
async function goto(peer) {
  const target = peer || PEER;
  const p = await ensurePage();
  if (!p.url().startsWith(WEB_BASE)) {
    await p.goto(WEB_BASE, { waitUntil: 'domcontentloaded' });
  }
  await p.evaluate((u) => {
    location.hash = `#@${u}`;
  }, target);
  // Wait for the message input of this peer to mount.
  try {
    await p.waitForSelector(SEL.messageInput, { timeout: 8000 });
  } catch {
    /* may still be on login screen — caller checks status */
  }
  return { peer: target, ...(await getStatus()) };
}

/** Type text into the real message box and press Enter to send. */
async function send(text) {
  if (!text) throw new Error('send requires non-empty text');
  const p = await ensurePage();
  const input = p.locator(SEL.messageInput);
  await input.click();
  await p.keyboard.insertText(text);
  await p.keyboard.press('Enter');
  return { sent: text };
}

/** Read the last N message bubbles with the fields most useful for assertions. */
async function last(n) {
  const count = Number(n) || 3;
  const p = await ensurePage();
  return p.evaluate(
    ({ sel, count }) => {
      const nodes = Array.from(document.querySelectorAll(sel.bubble)).slice(-count);
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      // Read the message text WITHOUT the trailing timestamp/reactions, which live in `.time`
      // and `.reactions` nodes inside the same bubble and would otherwise pollute the text.
      const messageText = (b) => {
        const msg = b.querySelector('.message, .translatable-message');
        if (!msg) return null;
        const c = msg.cloneNode(true);
        c.querySelectorAll('.time, .reactions, .message-time').forEach((n) => n.remove());
        return norm(c.textContent);
      };
      return nodes.map((b) => {
        const audio = b.querySelector('.audio, .media-voice, .audio-toggle');
        const dur = b.querySelector('.audio-time, .audio-duration');
        return {
          mid: b.getAttribute('data-mid'),
          out: b.classList.contains('is-out'),
          voice: !!audio,
          voiceDuration: dur ? norm(dur.textContent) : null,
          text: messageText(b),
        };
      });
    },
    { sel: SEL, count },
  );
}

/**
 * Record and send a voice message. The mic is fed from the fake WAV via the Chromium launch
 * flags, so this produces a genuine Telegram voice note. We press-and-hold the send/record
 * button for `seconds`, then release. If a separate "send recording" control appears (some
 * builds switch to a click-to-stop flow), we click it as a fallback.
 */
async function voice(seconds) {
  const hold = Math.max(1, Number(seconds) || 3) * 1000;
  const p = await ensurePage();
  // The message box must be EMPTY for the button to be in record mode (.btn-send.record).
  // Warm the fake microphone first, so the recording does not drop its first moments.
  await p.evaluate(() =>
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => s.getTracks().forEach((t) => t.stop()))
      .catch(() => {}),
  );
  const btn = p.locator(SEL.recordButton).first();
  if (!(await btn.count())) throw new Error('record button .btn-send.record not found — ensure the input is empty');
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  // Reliable "are we recording?" probe: webk shows a running mm:ss timer in the input row and
  // a genuinely-visible cancel button. We test computed style + box size, not just offsetParent.
  const recState = () =>
    p.evaluate(() => {
      const wrap = document.querySelector('.new-message-wrapper');
      const visible = (s) => {
        const el = document.querySelector(s);
        if (!el) return false;
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.01 && el.getBoundingClientRect().width > 1;
      };
      return {
        wrapText: wrap ? wrap.innerText.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
        cancelVisible: visible('.voice-recording-cancel'),
        btnSendCls: (document.querySelector('.btn-send') || {}).className || '',
      };
    });
  const recording = (s) => s.cancelVisible || /\d:\d\d/.test(s.wrapText);

  const box = await btn.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Attempt 1: short tap — some webk builds latch into a locked recording on a click.
  await p.mouse.move(cx, cy);
  await p.mouse.down();
  await p.waitForTimeout(120);
  await p.mouse.up();
  await p.waitForTimeout(700);
  let st = await recState();
  let mode = 'tap-lock';

  // Attempt 2: if the tap did not start recording, press-and-hold for the duration.
  if (!recording(st)) {
    mode = 'press-hold';
    await p.mouse.move(cx, cy);
    await p.mouse.down();
    await p.waitForTimeout(hold);
    st = await recState();
    await p.screenshot({ path: path.resolve(SHOTS_DIR, 'voice-hold.png') });
    await p.mouse.up();
    await p.waitForTimeout(800);
    const afterUp = await recState();
    // Press-hold usually auto-sends on release; if a locked preview remains, click send.
    if (recording(afterUp)) {
      await p.locator('.btn-send').first().click({ force: true });
      await p.waitForTimeout(800);
    }
    return { mode, recordingDetected: recording(st), afterUp };
  }

  // Locked recording from the tap: let it run, then click send to dispatch it.
  await p.waitForTimeout(hold);
  await p.screenshot({ path: path.resolve(SHOTS_DIR, 'voice-locked.png') });
  await p.locator('.btn-send').first().click({ force: true });
  await p.waitForTimeout(800);
  return { mode, recordingDetected: true, recState: st };
}

async function shot(name) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const safe = (name || 'shot').replace(/[^\w.-]/g, '_');
  const file = path.resolve(SHOTS_DIR, `${safe}.png`);
  const p = await ensurePage();
  await p.screenshot({ path: file, fullPage: false });
  return { path: file };
}

const ROUTES = {
  'GET /status': () => getStatus(),
  'GET /debug': () => debug(),
  'GET /mic': async () => {
    const p = await ensurePage();
    return p.evaluate(async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        const tracks = s.getAudioTracks().map((t) => ({ label: t.label, enabled: t.enabled, state: t.readyState }));
        s.getTracks().forEach((t) => t.stop());
        return { ok: true, tracks };
      } catch (e) {
        return { ok: false, error: `${e.name}: ${e.message}` };
      }
    });
  },
  'POST /goto': (body) => goto(body.peer),
  'POST /send': (body) => send(body.text),
  'GET /last': (_b, q) => last(q.n),
  'POST /voice': (body) => voice(body.seconds),
  'POST /shot': (body) => shot(body.name),
  'POST /shutdown': async () => {
    setTimeout(() => process.exit(0), 100);
    return { bye: true };
  },
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

async function main() {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  if (!fs.existsSync(WAV_PATH)) {
    log(`WARNING: voice sample missing at ${WAV_PATH} — run scripts/generate-voice-sample.js (in this skill folder)`);
  }
  log(`Launching headful Chromium, profile: ${USER_DATA_DIR}`);
  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: null,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${WAV_PATH}`,
    ],
  });
  try {
    await context.grantPermissions(['microphone'], { origin: 'https://web.telegram.org' });
  } catch (e) {
    log('grantPermissions failed (non-fatal):', e.message);
  }
  page = context.pages()[0] || (await context.newPage());
  await page.goto(`${WEB_BASE}#@${PEER}`, { waitUntil: 'domcontentloaded' });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const key = `${req.method} ${url.pathname}`;
    const handler = ROUTES[key];
    res.setHeader('Content-Type', 'application/json');
    if (!handler) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: `no route ${key}` }));
      return;
    }
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const query = Object.fromEntries(url.searchParams);
      const result = await handler(body, query);
      res.end(JSON.stringify({ ok: true, result }));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  });

  server.on('error', (e) => {
    log(`HTTP server error: ${e.message}`);
    process.exit(1);
  });
  server.listen(PORT, '127.0.0.1', () => {
    log(`Ready. Peer @${PEER}. Command API on http://127.0.0.1:${PORT}`);
    log(`Try: node .claude/skills/test-telegram-bot/scripts/tg.js status`);
  });

  const shutdown = async () => {
    try {
      await context.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error('[tg-driver] fatal:', e.message);
  process.exit(1);
});
