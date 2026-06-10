// Notes MCP server with MCP Apps support. Lives in the same process as the admin web server: the
// Streamable HTTP endpoint is mounted on the admin express app (config.notes.mcpPath, default /mcp/notes)
// in stateless mode — a fresh Server+Transport pair per request, no session state.
//
// The agent connects to it through the regular MCP client (.mcp.json, alias "notes"), so the tools reach
// the model as notes__note_create, notes__notes_show_widget and so on. The user identity is NOT a tool
// argument (the model must not be able to spoof it): the client forwards ctx.userId/ctx.conversationId in
// the request _meta (see forwardUserContext in src/mcp/config.js), and this server reads it from there.
//
// MCP Apps: notes_show_widget carries _meta.ui.resourceUri pointing to the ui://notes/widget.html
// resource. Our own hosts (admin chat, Telegram Mini App) render the widget natively without iframes and
// never read this resource; it exists so that spec-compliant external hosts (Claude Desktop etc.) can
// render the same widget their own way.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from '../config.js';
import { createNote, updateNote, deleteNote, restoreNote, searchNotesForLlm, countNotes } from '../notes/store.js';
import { issueWidgetToken } from '../notes/widget-token.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// _meta keys under which the MCP client of this very project forwards the caller's identity.
export const META_USER_ID = 'mem-bot/userId';
export const META_CONVERSATION_ID = 'mem-bot/conversationId';

export const WIDGET_RESOURCE_URI = 'ui://notes/widget.html';
const WIDGET_RESOURCE_MIME = 'text/html;profile=mcp-app';
// The Mini App page doubles as the UI resource for external MCP Apps hosts. Note: it references its
// assets by absolute /assets/ paths, so a host that renders it inside a sandboxed iframe without our
// origin will show only the fallback text — full standalone (single-file) packaging is a possible later step.
const WIDGET_HTML_PATH = path.resolve(__dirname, '../../web/dist/miniapp/notes.html');

const TAGS_SCHEMA = { type: 'array', items: { type: 'string' }, description: 'Optional list of tags' };

const TOOLS = [
  {
    name: 'note_create',
    description:
      'Creates a new note for the current user. The note has an optional title, required text body and optional tags.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title (optional, up to 400 characters)' },
        body: { type: 'string', description: 'Note text (required, up to 20000 characters)' },
        tags: TAGS_SCHEMA,
      },
      required: ['body'],
    },
  },
  {
    name: 'note_update',
    description: 'Edits an existing note of the current user by id. Only the provided fields are changed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Note id' },
        title: { type: 'string', description: 'New title' },
        body: { type: 'string', description: 'New text' },
        tags: TAGS_SCHEMA,
        pinned: { type: 'boolean', description: 'Pin or unpin the note' },
      },
      required: ['id'],
    },
  },
  {
    name: 'note_delete',
    description: 'Soft-deletes a note of the current user by id. The note can be restored with note_restore.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Note id' } },
      required: ['id'],
    },
  },
  {
    name: 'note_restore',
    description: 'Restores a previously deleted note of the current user by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'integer', description: 'Note id' } },
      required: ['id'],
    },
  },
  {
    name: 'notes_search',
    description: `Searches the current user's notes by meaning (semantic + full-text hybrid search) and returns compact snippets. Use it when you need the CONTENT of notes to answer a question. Empty query returns the most recent notes.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (empty = recent notes)' },
        tag: { type: 'string', description: 'Filter by tag' },
        limit: { type: 'integer', description: 'Max results, default 10' },
      },
    },
  },
  {
    name: 'notes_show_widget',
    description: `Shows the user an interactive notes widget (list with search, lazy loading and full editing). Call it when the user asks to SEE, browse or manage their notes. The widget loads the data itself; do not list the notes in your answer.`,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional initial search filter for the widget' } },
    },
    _meta: { ui: { resourceUri: WIDGET_RESOURCE_URI } },
  },
];

function textResult(text, structuredContent = undefined) {
  return { content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}) };
}

function errorResult(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function noteLabel(note) {
  return note.title ? `#${note.id} «${note.title}»` : `#${note.id}`;
}

// Tool dispatch. userId comes from the request _meta, never from the model-controlled arguments.
async function handleToolCall(name, args, { userId, conversationId }) {
  if (!userId) {
    return errorResult('Контекст пользователя не передан: сервер заметок принимает вызовы только от агента mem-bot.');
  }
  switch (name) {
    case 'note_create': {
      const note = await createNote({ userId, title: args.title, body: args.body, tags: args.tags });
      return textResult(`Заметка ${noteLabel(note)} создана.`, { note: { id: Number(note.id), title: note.title } });
    }
    case 'note_update': {
      const result = await updateNote({
        userId,
        id: args.id,
        title: args.title,
        body: args.body,
        tags: args.tags,
        pinned: args.pinned,
      });
      if (!result) {
        return errorResult(`Заметка #${args.id} не найдена.`);
      }
      if (result.changed.length === 0) {
        return textResult(`Заметка ${noteLabel(result.note)} не изменилась (новые значения совпали с текущими).`);
      }
      return textResult(`Заметка ${noteLabel(result.note)} обновлена (${result.changed.join(', ')}).`);
    }
    case 'note_delete': {
      const note = await deleteNote({ userId, id: args.id });
      if (!note) {
        return errorResult(`Заметка #${args.id} не найдена.`);
      }
      return textResult(`Заметка ${noteLabel(note)} удалена. Её можно восстановить инструментом note_restore.`);
    }
    case 'note_restore': {
      const note = await restoreNote({ userId, id: args.id });
      if (!note) {
        return errorResult(`Удалённая заметка #${args.id} не найдена.`);
      }
      return textResult(`Заметка ${noteLabel(note)} восстановлена.`);
    }
    case 'notes_search': {
      const res = await searchNotesForLlm({ userId, q: args.query, tag: args.tag || null, limit: args.limit });
      return textResult(JSON.stringify(res, null, 2));
    }
    case 'notes_show_widget': {
      const total = await countNotes({ userId });
      const token = issueWidgetToken({ userId, conversationId });
      const query = String(args.query || '');
      // The text below is what lands in the LLM history — meta-information only, no note data.
      const text = `Пользователю показан интерактивный виджет списка заметок${query ? ` (фильтр: «${query}»)` : ''}. Всего заметок: ${total}. Данные виджет загружает сам — не перечисляй заметки в ответе.`;
      return textResult(text, {
        widget: {
          type: 'notes',
          dataUrl: '/api/notes',
          token,
          query,
          total,
          miniAppUrl: config.notes.publicUrl ? `${config.notes.publicUrl.replace(/\/$/, '')}/miniapp/notes` : null,
        },
      });
    }
    default:
      return errorResult(`Неизвестный инструмент: ${name}`);
  }
}

function readWidgetHtml() {
  try {
    return fs.readFileSync(WIDGET_HTML_PATH, 'utf8');
  } catch {
    // The build is optional: our own hosts render the widget natively. External MCP Apps hosts get an
    // honest stub until web/dist is built.
    return `<!DOCTYPE html><html lang="ru"><meta charset="utf-8"><body style="font-family:sans-serif">
<p>Виджет заметок mem-bot: standalone-сборка ещё не выполнена (npm run web:build).
Используйте чат админки или Telegram Mini App.</p></body></html>`;
  }
}

// Build a fresh MCP server instance (stateless transport → one instance per HTTP request).
export function buildNotesMcpServer() {
  const server = new Server(
    { name: 'mem-bot-notes', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const meta = req.params._meta || {};
    const ctx = { userId: meta[META_USER_ID] || null, conversationId: meta[META_CONVERSATION_ID] || null };
    try {
      return await handleToolCall(req.params.name, req.params.arguments || {}, ctx);
    } catch (err) {
      return errorResult(String(err?.message || err));
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: WIDGET_RESOURCE_URI,
        name: 'Notes Widget',
        description: 'Interactive notes list widget (MCP Apps UI resource)',
        mimeType: WIDGET_RESOURCE_MIME,
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    if (req.params.uri !== WIDGET_RESOURCE_URI) {
      throw new Error(`Неизвестный ресурс: ${req.params.uri}`);
    }
    return {
      contents: [{ uri: WIDGET_RESOURCE_URI, mimeType: WIDGET_RESOURCE_MIME, text: readWidgetHtml() }],
    };
  });

  return server;
}

// The MCP endpoint is meant for the local agent only. A request is considered external when it carries
// X-Forwarded-For (it came through a reverse proxy such as nginx) or its socket address is not loopback.
// External callers must present config.notes.mcpSecret in the X-Notes-Mcp-Secret header; without a
// configured secret every external request is rejected. The local agent connects to localhost directly
// (no proxy, no header), so it passes with zero configuration.
function isExternalRequest(req) {
  if (req.headers['x-forwarded-for']) {
    return true;
  }
  const addr = req.socket?.remoteAddress || '';
  return !(addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1');
}

function rejectUnauthorizedExternal(req, res) {
  if (!isExternalRequest(req)) {
    return false;
  }
  const secret = config.notes.mcpSecret;
  if (secret && req.headers['x-notes-mcp-secret'] === secret) {
    return false;
  }
  res.status(403).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'MCP-сервер заметок доступен только локальному агенту.' },
    id: null,
  });
  return true;
}

// Mount the Streamable HTTP endpoint on an express app. Stateless: every POST gets its own
// Server+Transport pair, closed when the response ends. GET/DELETE (SSE sessions) are not supported.
export function mountNotesMcp(app) {
  if (!config.notes.enabled) {
    return;
  }
  const { mcpPath } = config.notes;

  app.post(mcpPath, async (req, res) => {
    if (rejectUnauthorizedExternal(req, res)) {
      return;
    }
    try {
      const server = buildNotesMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('notes-mcp: request handling failed:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  const methodNotAllowed = (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Stateless-сервер заметок принимает только POST.' },
      id: null,
    });
  };
  app.get(mcpPath, methodNotAllowed);
  app.delete(mcpPath, methodNotAllowed);
  console.log(`Notes MCP server is mounted at ${mcpPath} (stateless Streamable HTTP).`);
}
