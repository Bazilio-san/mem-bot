// REST API of the notes widget. Mounted at /api/notes on the admin web server; serves both surfaces:
// the inline widget in the admin chat (Bearer widget token issued by the notes_show_widget tool) and the
// Telegram Mini App (X-Tg-Init-Data header validated against the bot token). The data layer is
// src/notes/store.js; every successful mutation writes a meta-event into the dialog history
// (src/notes/events.js) so the LLM knows what the user did in the widget.
import express from 'express';
import { config } from '../config.js';
import { query } from '../db.js';
import { listNotes, getNote, createNote, updateNote, deleteNote, restoreNote } from '../notes/store.js';
import { verifyWidgetToken } from '../notes/widget-token.js';
import { validateTelegramInitData } from '../notes/telegram-init-data.js';
import { recordNoteEvent } from '../notes/events.js';

// Async-handler wrapper: store validation errors (code='VALIDATION') become 400, the rest become 500.
function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      const status = err?.code === 'VALIDATION' ? 400 : 500;
      res.status(status).json({ error: String(err?.message || err) });
    }
  };
}

// Resolve the caller. Two equal mechanisms:
//  1) Authorization: Bearer <widget-token> — the token carries userId and the dialog the widget was shown in;
//  2) X-Tg-Init-Data — Telegram Mini App; the signature is checked against the bot token and the Telegram
//     user id is mapped onto mem.users.external_id (the project stores the Telegram chat id there).
async function authenticate(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) {
    const parsed = verifyWidgetToken(auth.slice(7).trim());
    if (parsed) {
      return { userId: parsed.userId, conversationId: parsed.conversationId, via: 'token' };
    }
    return null;
  }

  const initData = req.headers['x-tg-init-data'];
  if (initData) {
    const valid = validateTelegramInitData(String(initData), config.telegram.apiKey);
    if (!valid) {
      return null;
    }
    const { rows } = await query('SELECT id FROM mem.users WHERE external_id = $1', [String(valid.user.id)]);
    if (!rows[0]) {
      return null;
    }
    return { userId: rows[0].id, conversationId: null, via: 'telegram' };
  }
  return null;
}

function parseId(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function createNotesApi() {
  const router = express.Router();

  router.use(async (req, res, next) => {
    try {
      if (!config.notes.enabled) {
        return res.status(503).json({ error: 'Инструментарий заметок выключен в конфигурации.' });
      }
      const auth = await authenticate(req);
      if (!auth) {
        return res.status(401).json({ error: 'Нет доступа: нужен действующий widget-токен или initData Telegram.' });
      }
      req.notesAuth = auth;
      next();
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  // List / hybrid search with lazy pagination: ?cursor=&limit=&q=&tag=
  router.get(
    '/',
    wrap(async (req, res) => {
      const { userId } = req.notesAuth;
      const { cursor, limit, q, tag } = req.query;
      res.json(await listNotes({ userId, cursor, limit, q, tag: tag || null }));
    }),
  );

  router.get(
    '/:id',
    wrap(async (req, res) => {
      const id = parseId(req);
      const note = id ? await getNote({ userId: req.notesAuth.userId, id }) : null;
      if (!note) {
        return res.status(404).json({ error: 'Заметка не найдена.' });
      }
      res.json({ note });
    }),
  );

  router.post(
    '/',
    wrap(async (req, res) => {
      const { userId, conversationId } = req.notesAuth;
      const { title, body, tags } = req.body || {};
      const note = await createNote({ userId, title, body, tags });
      await recordNoteEvent({ userId, conversationId, action: 'create', note });
      res.status(201).json({ note });
    }),
  );

  router.patch(
    '/:id',
    wrap(async (req, res) => {
      const { userId, conversationId } = req.notesAuth;
      const id = parseId(req);
      const { title, body, tags, pinned } = req.body || {};
      const result = id ? await updateNote({ userId, id, title, body, tags, pinned }) : null;
      if (!result) {
        return res.status(404).json({ error: 'Заметка не найдена.' });
      }
      if (result.changed.length > 0) {
        await recordNoteEvent({ userId, conversationId, action: 'update', note: result.note, changed: result.changed });
      }
      res.json({ note: result.note, changed: result.changed });
    }),
  );

  router.delete(
    '/:id',
    wrap(async (req, res) => {
      const { userId, conversationId } = req.notesAuth;
      const id = parseId(req);
      const note = id ? await deleteNote({ userId, id }) : null;
      if (!note) {
        return res.status(404).json({ error: 'Заметка не найдена.' });
      }
      await recordNoteEvent({ userId, conversationId, action: 'delete', note });
      res.json({ note });
    }),
  );

  // Undo of a soft delete (the "Отменить" button in the widget toast).
  router.post(
    '/:id/restore',
    wrap(async (req, res) => {
      const { userId, conversationId } = req.notesAuth;
      const id = parseId(req);
      const note = id ? await restoreNote({ userId, id }) : null;
      if (!note) {
        return res.status(404).json({ error: 'Удалённая заметка не найдена.' });
      }
      await recordNoteEvent({ userId, conversationId, action: 'restore', note });
      res.json({ note });
    }),
  );

  return router;
}
