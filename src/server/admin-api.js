// Routes of the admin interface (JSON API under the /api prefix). This is a thin layer over the existing
// data-fetching functions from the sandbox (src/sandbox/data.js): the admin panel reuses the same code as
// the visual sandbox page, so there is no separate business logic here. Each route wraps the call in
// try/catch and on error returns a clear JSON with code 500, so the frontend can show the reason rather
// than a "white screen".
import express from 'express';
import { listUsers, getUserMemory, getProactivity, deleteItem, deleteUser } from '../sandbox/data.js';
import { searchUsers, getTimeline, getCycle, getSingleRequest, getUserById } from './llm-log-data.js';
import { analysisConfigPublic, runAnalysis } from './log-analysis.js';
import { handleMessage } from '../agent.js';

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

  // Delete a single memory record (soft delete). The category matches the memory group key on the frontend
  // (profile/dialog/domain/reminder/secure) and decides which table and status transition is applied.
  router.delete(
    '/users/:id/memory/:category/:itemId',
    wrap(async (req, res) => {
      const ok = await deleteItem({
        userId: req.params.id,
        category: req.params.category,
        id: req.params.itemId,
      });
      res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'Запись не найдена.' });
    }),
  );

  // Cascade delete of a user and all related data (conversations, facts, tasks, notifications, etc. are
  // removed by ON DELETE CASCADE foreign keys). Logs are kept: tool call journal references are nulled,
  // the LLM request journal lives in a separate logs database and is not touched at all.
  router.delete(
    '/users/:id',
    wrap(async (req, res) => {
      const ok = await deleteUser(req.params.id);
      res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'Пользователь не найден.' });
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

  // --- LLM log viewer ------------------------------------------------------

  // User suggestions for the log page search box (by name, Telegram id, or exact internal UUID).
  router.get(
    '/users/search',
    wrap(async (req, res) => {
      res.json(await searchUsers(req.query.q));
    }),
  );

  // Chat timeline of a user: dialog messages merged with service LLM call badges, paginated upwards
  // (?before=<ISO> returns strictly older items, ?limit= messages per page).
  router.get(
    '/users/:id/timeline',
    wrap(async (req, res) => {
      res.json(await getTimeline({ userId: req.params.id, before: req.query.before, limit: req.query.limit }));
    }),
  );

  // Journal of one dialog cycle (header with totals + display rows) by its correlation request_id.
  router.get(
    '/llm-log/cycle/:requestId',
    wrap(async (req, res) => {
      const cycle = await getCycle(req.params.requestId);
      if (!cycle) {
        return res.status(404).json({ error: 'Записей журнала с таким request_id не найдено.' });
      }
      res.json(cycle);
    }),
  );

  // Journal of a single service record (a badge without request_id) by its journal primary key.
  router.get(
    '/llm-log/request/:llmRequestId',
    wrap(async (req, res) => {
      const result = await getSingleRequest(req.params.llmRequestId);
      if (!result) {
        return res.status(404).json({ error: 'Запись журнала не найдена.' });
      }
      res.json(result);
    }),
  );

  // Send a message on behalf of the user from the admin chat pane. Runs the full agent pipeline with the
  // 'admin' channel (no markup profile is registered for it, so the reply comes as plain text) and returns
  // the answer together with the turn's request_id, so the frontend can open the fresh cycle's journal.
  router.post(
    '/users/:id/chat-message',
    wrap(async (req, res) => {
      const text = String(req.body?.text || '').trim();
      if (!text) {
        return res.status(400).json({ error: 'Пустое сообщение.' });
      }
      const user = await getUserById(req.params.id);
      if (!user) {
        return res.status(404).json({ error: 'Пользователь не найден.' });
      }
      const result = await handleMessage({ externalId: user.external_id, userMessage: text, channel: 'admin' });
      res.json({ answer: result.answer, requestId: result.requestId });
    }),
  );

  // Public settings of the AI analysis dialog: allowed models and CLI preset names (no commands).
  router.get(
    '/llm-log/analysis-config',
    wrap(async (_req, res) => {
      res.json(analysisConfigPublic());
    }),
  );

  // AI analysis of a logged request. Streams the result as Server-Sent Events; the CLI engine is rejected
  // with 403 unless the admin server listens on localhost (the check lives in runAnalysis).
  router.post(
    '/llm-log/analyze',
    wrap(async (req, res) => {
      await runAnalysis(req.body || {}, res);
    }),
  );

  return router;
}
