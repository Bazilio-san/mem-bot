// Realtime delivery of new chat messages to the admin chat pane. Messages may arrive from another
// process entirely (the telegram bot, the proactivity worker), so the transport between processes is
// PostgreSQL LISTEN/NOTIFY on the shared memory database: saveMessage() in src/repo.js issues
// pg_notify('chat_message', {userId, messageId, role}) and this module relays the event to subscribed
// browsers over Server-Sent Events. SSE is chosen over WebSocket deliberately: the stream is strictly
// one-way (server → browser), it reuses the admin session cookie and needs no extra dependencies —
// the same approach the log-analysis streaming already uses.
import { createListener } from '../db.js';

// Active SSE subscribers: response object → internal user id whose chat the browser is watching.
const subscribers = new Map();

// One LISTEN connection per process, created lazily on the first subscription. There is no point in
// holding a dedicated DB connection while nobody is watching the admin chat.
let listener = null;

function ensureListener() {
  if (listener) {
    return;
  }
  listener = createListener('chat_message', (msg) => {
    let event;
    try {
      event = JSON.parse(msg?.payload || '');
    } catch {
      return; // foreign or malformed payload — nothing to relay
    }
    if (!event?.userId) {
      return;
    }
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const [res, userId] of subscribers) {
      if (userId === String(event.userId)) {
        res.write(frame);
      }
    }
  });
}

// GET /users/:id/chat-events — an endless SSE stream of "a new message appeared in this user's chat"
// events. The browser subscribes with EventSource; on each event it refreshes the timeline tail.
export function chatEventsHandler(req, res) {
  ensureListener();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  subscribers.set(res, String(req.params.id));

  // Heartbeat comment frames keep the connection from being dropped by proxies and let the server
  // detect dead sockets through write errors.
  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    subscribers.delete(res);
  });
}
