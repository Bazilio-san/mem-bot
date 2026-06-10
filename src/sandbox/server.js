// HTTP server for the memory sandbox. Serves a single page and a set of JSON routes on top of the data layer.
// Requires no dependencies beyond the built-in node:http module — this is a local tool for visually
// demonstrating how memory works, not a public service. Run: npm run sandbox (or node src/sandbox/server.js).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { closePool } from '../db.js';
import { flushLlmLog } from '../pipeline/llm-log.js';
import { listUsers, getUserMemory, runFilter, chat, getProactivity, deleteItem } from './data.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = path.join(__dirname, 'page.html');
const PORT = config.sandbox.port;

// Read the request body as JSON (with protection against overly large bodies).
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body is too large.'));
      }
    });
    req.on('end', () => {
      if (!body) {
        return resolve({});
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

// Route dispatch. Returns a JSON response or serves the HTML page.
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  // Sandbox main page.
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = fs.readFileSync(PAGE_PATH);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // User list for the dropdown.
  if (req.method === 'GET' && pathname === '/api/users') {
    sendJson(res, 200, await listUsers());
    return;
  }

  // All memory of the selected user, grouped by category.
  if (req.method === 'GET' && pathname === '/api/memory') {
    const userId = url.searchParams.get('user');
    if (!userId) {
      return sendJson(res, 400, { error: 'The "user" parameter is required.' });
    }
    sendJson(res, 200, await getUserMemory(userId));
    return;
  }

  // Delete a single memory record (soft delete). Parameters: user, category, id.
  if (req.method === 'DELETE' && pathname === '/api/memory') {
    const userId = url.searchParams.get('user');
    const category = url.searchParams.get('category');
    const id = url.searchParams.get('id');
    if (!userId || !category || !id) {
      return sendJson(res, 400, { error: 'The user, category and id parameters are required.' });
    }
    const ok = await deleteItem({ userId, category, id });
    return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Record not found.' });
  }

  // Proactivity state of the selected user.
  if (req.method === 'GET' && pathname === '/api/proactivity') {
    const userId = url.searchParams.get('user');
    if (!userId) {
      return sendJson(res, 400, { error: 'The "user" parameter is required.' });
    }
    sendJson(res, 200, await getProactivity(userId));
    return;
  }

  // Run the memory filtering stage: request classification and retrieval of relevant facts.
  if (req.method === 'POST' && pathname === '/api/filter') {
    const { user, phrase, domain } = await readJson(req);
    if (!user || !phrase) {
      return sendJson(res, 400, { error: 'The user and phrase fields are required.' });
    }
    sendJson(res, 200, await runFilter({ userId: user, phrase, currentDomain: domain || 'general' }));
    return;
  }

  // Full bot response through the main pipeline.
  if (req.method === 'POST' && pathname === '/api/chat') {
    const { externalId, phrase, domain } = await readJson(req);
    if (!externalId || !phrase) {
      return sendJson(res, 400, { error: 'The externalId and phrase fields are required.' });
    }
    sendJson(res, 200, await chat({ externalId, phrase, currentDomain: domain || 'general' }));
    return;
  }

  sendJson(res, 404, { error: 'Route not found.' });
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    console.error('Request handling error:', err.message);
    if (!res.headersSent) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
  }
});

server.listen(PORT, () => {
  console.log(`Memory sandbox started. Open in your browser: http://localhost:${PORT}`);
});

// Graceful shutdown: close the database connection pool when the process stops.
async function shutdown() {
  server.close();
  await flushLlmLog();
  await closePool();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
