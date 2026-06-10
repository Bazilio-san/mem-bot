// Тесты MCP-сервера заметок (src/notes-mcp/server.js): подключение реальным MCP-клиентом из SDK по
// Streamable HTTP, список тулов с MCP Apps-метаданными, передача userId через _meta запроса, CRUD-цикл,
// notes_show_widget с валидным widget-токеном и чтение UI-ресурса. БД реальная, эмбеддинги — заглушка.
// Запуск: npm run test:notes-mcp.
import assert from 'node:assert/strict';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from '../src/config.js';
import { query, closePool } from '../src/db.js';
import { ensureUser, ensureConversation } from '../src/repo.js';
import { __setEmbedForTests } from '../src/notes/store.js';
import { verifyWidgetToken } from '../src/notes/widget-token.js';
import { mountNotesMcp, META_USER_ID, META_CONVERSATION_ID, WIDGET_RESOURCE_URI } from '../src/notes-mcp/server.js';

__setEmbedForTests(async () => null);

async function freshUser(extId) {
  await query('DELETE FROM mem.users WHERE external_id = $1', [extId]);
  return ensureUser(extId);
}
const u = await freshUser('notes-mcp-test-main');
const conv = await ensureConversation(u.id, 'general');

// Поднимаем express с примонтированным MCP-эндпоинтом на эфемерном порту.
const app = express();
app.use(express.json({ limit: '1mb' }));
mountNotesMcp(app);
const server = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const mcpUrl = `http://127.0.0.1:${server.address().port}${config.notes.mcpPath}`;

const client = new Client({ name: 'notes-mcp-test', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));

const META = { [META_USER_ID]: u.id, [META_CONVERSATION_ID]: conv.id };
const callTool = (name, args = {}, meta = META) =>
  client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
const text = (res) => res.content.find((c) => c.type === 'text')?.text || '';

// ---- 1. Список тулов и MCP Apps-метаданные --------------------------------------
const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
assert.deepEqual(
  names,
  ['note_create', 'note_delete', 'note_restore', 'note_update', 'notes_search', 'notes_show_widget'],
  'все шесть тулов зарегистрированы',
);
const widgetTool = tools.find((t) => t.name === 'notes_show_widget');
assert.equal(widgetTool._meta?.ui?.resourceUri, WIDGET_RESOURCE_URI, 'тул показа связан с UI-ресурсом (MCP Apps)');

// ---- 2. Вызов без контекста пользователя отклоняется ------------------------------
const noCtx = await callTool('note_create', { body: 'без контекста' }, null);
assert.equal(noCtx.isError, true);
assert.match(text(noCtx), /Контекст пользователя не передан/);

// ---- 3. CRUD-цикл через _meta-контекст --------------------------------------------
const created = await callTool('note_create', { title: 'Через MCP', body: 'Тело заметки', tags: ['mcp'] });
assert.ok(!created.isError, text(created));
assert.match(text(created), /Заметка #\d+ «Через MCP» создана/);
const noteId = created.structuredContent.note.id;
const { rows: dbNote } = await query('SELECT user_id, title FROM mem.notes WHERE id = $1', [noteId]);
assert.equal(dbNote[0].user_id, u.id, 'заметка принадлежит пользователю из _meta');

const updated = await callTool('note_update', { id: noteId, body: 'Новое тело' });
assert.match(text(updated), /обновлена \(body\)/);

// Эмбеддинги в тесте заглушены, поэтому ищем словом из текста заметки (полнотекстовая ветка).
const found = await callTool('notes_search', { query: 'новое тело' });
const parsed = JSON.parse(text(found));
assert.equal(parsed.total, 1);
assert.equal(parsed.items[0].id, noteId);

const deleted = await callTool('note_delete', { id: noteId });
assert.match(text(deleted), /удалена/);
const restored = await callTool('note_restore', { id: noteId });
assert.match(text(restored), /восстановлена/);

const missing = await callTool('note_update', { id: 99_999_999, body: 'нет такой' });
assert.equal(missing.isError, true);

// Ошибка валидации возвращается как isError-результат, а не валит сервер.
const invalid = await callTool('note_create', { body: '   ' });
assert.equal(invalid.isError, true);
assert.match(text(invalid), /не может быть пустым/);

// ---- 4. notes_show_widget: мета-текст для LLM + дескриптор виджета -----------------
const widget = await callTool('notes_show_widget', { query: 'mcp' });
assert.match(text(widget), /показан интерактивный виджет/);
assert.match(text(widget), /Всего заметок: 1/);
const w = widget.structuredContent.widget;
assert.equal(w.type, 'notes');
assert.equal(w.dataUrl, '/api/notes');
assert.equal(w.query, 'mcp');
const tokenPayload = verifyWidgetToken(w.token);
assert.equal(tokenPayload.userId, u.id, 'widget-токен выпущен на пользователя из _meta');
assert.equal(tokenPayload.conversationId, conv.id, 'widget-токен привязан к диалогу');

// ---- 5. UI-ресурс MCP Apps ----------------------------------------------------------
const { resources } = await client.listResources();
assert.equal(resources.length, 1);
assert.equal(resources[0].uri, WIDGET_RESOURCE_URI);
const resource = await client.readResource({ uri: WIDGET_RESOURCE_URI });
assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
assert.match(resource.contents[0].text, /<!DOCTYPE html>/i);

await client.close();
__setEmbedForTests(null);
await new Promise((resolve) => server.close(resolve));
await closePool();
console.log('notes-mcp.test.mjs: ok');
