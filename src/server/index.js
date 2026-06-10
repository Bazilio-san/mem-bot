// Combined entry point: a single Node.js process running both the admin web server and the Telegram channel
// (long polling of incoming messages plus a background scheduler-and-delivery worker) at the same time.
// Both services are I/O-bound and live on the same event loop without interfering with each other. Run: npm run server.
//
// Startup order: first the HTTP server is brought up (so the admin panel and health check are available as
// early as possible), then the Telegram bot is started. Shutdown on a signal stops both services and closes
// the shared DB connection pool once — this process is the one that owns the pool.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from '../config.js';
import { closePool } from '../db.js';
import { createAdminApi } from './admin-api.js';
import { startLogRetention, stopLogRetention } from '../pipeline/log-retention.js';
// Importing bot.js registers the Telegram channel profile and checks that the token is present. The bot
// itself is not started yet: the auto-start inside bot.js only fires on a direct call (npm run telegram),
// while here we manage its lifecycle explicitly via startTelegram/stopTelegram.
import { startTelegram, stopTelegram } from '../telegram/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Directory of the built frontend (Vue + Vite places the build here via npm run web:build).
const WEB_DIST = path.resolve(__dirname, '../../web/dist');
const PORT = config.admin.port;
const HOST = config.admin.host;

// Build the express app: JSON body parsing, admin API routes under the /api prefix, serving the built
// frontend, and returning index.html for any other GET routes (so the Vue single-page app handles its own
// routing in the browser without getting a 404 when reloading a nested page).
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', createAdminApi());

  // Static files of the built frontend. In development mode the web/dist directory may be absent — that's
  // fine: then the Vite dev server (npm run web:dev) serves the frontend and this process serves only the API.
  app.use(express.static(WEB_DIST));

  // Return the single-page app for any non-API GET routes. Express 5 does not accept the string pattern '*',
  // so we use a middleware: we pass through requests to /api and serve index.html for other GET requests.
  // If the build is not there yet, we honestly report it with clear text rather than returning an empty response.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) {
      return next();
    }
    res.sendFile(path.join(WEB_DIST, 'index.html'), (err) => {
      if (err) {
        res
          .status(503)
          .type('text/plain; charset=utf-8')
          .send(
            'Фронтенд админки ещё не собран. Выполните «npm run web:build» для рабочей сборки ' +
              'или запустите сервер разработки Vite командой «npm run web:dev».',
          );
      }
    });
  });

  return app;
}

// Start the HTTP server and return the server object (needed to close it cleanly on shutdown).
function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, HOST, () => resolve(server));
    server.on('error', reject);
  });
}

async function main() {
  const app = buildApp();
  const server = await listen(app);
  console.log(`Admin web server is listening on http://${HOST}:${PORT}/# (API available at /api).`);

  // Telegram is started after the web server. The bot itself logs that long polling is active.
  const { username } = await startTelegram();
  console.log(`Telegram channel is up in the same process (bot @${username}).`);

  // Age-based cleanup of the journals in the logs DB: a pass now and then once a day (config llmLog.retention).
  startLogRetention();

  // Graceful shutdown on a signal: stop accepting new HTTP requests, shut down the Telegram part, and only
  // then close the shared DB connection pool. process.exit is called after releasing resources.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    } // ignore a repeated signal during shutdown
    shuttingDown = true;
    console.log(`\nReceived signal ${signal}. Shutting down the combined server…`);
    stopLogRetention();
    await new Promise((resolve) => server.close(resolve)); // wait for the HTTP server to close
    await stopTelegram();
    try {
      await closePool();
    } catch {
      /* the pool may not have been opened */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Critical error starting the combined server:', err.message);
  process.exit(1);
});
