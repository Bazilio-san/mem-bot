// Routes of the admin interface (JSON API under the /api prefix). This is a thin layer over the existing
// data-fetching functions from the sandbox (src/sandbox/data.js): the admin panel reuses the same code as
// the visual sandbox page, so there is no separate business logic here. Each route wraps the call in
// try/catch and on error returns a clear JSON with code 500, so the frontend can show the reason rather
// than a "white screen".
import express from 'express';
import { listUsers, getUserMemory, getProactivity } from '../sandbox/data.js';

// A small wrapper: catches an async handler's exception and returns it as a JSON 500 error.
// Without it, a rejected promise in an express handler would not turn into a response and the request would hang.
function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`Admin API error ${req.method} ${req.originalUrl}:`, err.message);
      res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера.' });
    }
  };
}

// Build the admin API router. Extracted into a function so the server entry point decides under which
// prefix to mount it and can add its own middleware around it if needed.
export function createAdminApi() {
  const router = express.Router();

  // Health check: the frontend and monitoring systems use this route to confirm the server is alive.
  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // List of all users (for the admin panel's left sidebar).
  router.get(
    '/users',
    wrap(async (_req, res) => {
      const users = await listUsers();
      res.json(users);
    }),
  );

  // All active memory of the selected user, grouped by category.
  router.get(
    '/users/:id/memory',
    wrap(async (req, res) => {
      const memory = await getUserMemory(req.params.id);
      res.json(memory);
    }),
  );

  // Proactivity state of the selected user (master flag and the list of triggers).
  router.get(
    '/users/:id/proactivity',
    wrap(async (req, res) => {
      const state = await getProactivity(req.params.id);
      res.json(state);
    }),
  );

  return router;
}
