// HTTP-сервер песочницы памяти. Отдаёт одну страницу и набор JSON-маршрутов поверх слоя данных.
// Зависимостей кроме встроенного модуля node:http не требует — это локальный инструмент для наглядной
// демонстрации работы памяти, а не публичный сервис. Запуск: npm run sandbox (или node src/sandbox/server.js).
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

// Прочитать тело запроса как JSON (с защитой от слишком больших тел).
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Слишком большое тело запроса.'));
      }
    });
    req.on('end', () => {
      if (!body) {
        return resolve({});
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Тело запроса не является корректным JSON.'));
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

// Разбор маршрутов. Возвращает ответ в формате JSON или отдаёт HTML-страницу.
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  // Главная страница песочницы.
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = fs.readFileSync(PAGE_PATH);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Список пользователей для выпадающего списка.
  if (req.method === 'GET' && pathname === '/api/users') {
    sendJson(res, 200, await listUsers());
    return;
  }

  // Вся память выбранного пользователя по категориям.
  if (req.method === 'GET' && pathname === '/api/memory') {
    const userId = url.searchParams.get('user');
    if (!userId) {
      return sendJson(res, 400, { error: 'Не указан параметр user.' });
    }
    sendJson(res, 200, await getUserMemory(userId));
    return;
  }

  // Удаление одной записи памяти (мягкое). Параметры: user, category, id.
  if (req.method === 'DELETE' && pathname === '/api/memory') {
    const userId = url.searchParams.get('user');
    const category = url.searchParams.get('category');
    const id = url.searchParams.get('id');
    if (!userId || !category || !id) {
      return sendJson(res, 400, { error: 'Нужны параметры user, category и id.' });
    }
    const ok = await deleteItem({ userId, category, id });
    return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Запись не найдена.' });
  }

  // Состояние проактивности выбранного пользователя.
  if (req.method === 'GET' && pathname === '/api/proactivity') {
    const userId = url.searchParams.get('user');
    if (!userId) {
      return sendJson(res, 400, { error: 'Не указан параметр user.' });
    }
    sendJson(res, 200, await getProactivity(userId));
    return;
  }

  // Прогон этапа фильтрации памяти: классификация запроса и выборка релевантных фактов.
  if (req.method === 'POST' && pathname === '/api/filter') {
    const { user, phrase, domain } = await readJson(req);
    if (!user || !phrase) {
      return sendJson(res, 400, { error: 'Нужны поля user и phrase.' });
    }
    sendJson(res, 200, await runFilter({ userId: user, phrase, currentDomain: domain || 'general' }));
    return;
  }

  // Полноценный ответ бота через основной пайплайн.
  if (req.method === 'POST' && pathname === '/api/chat') {
    const { externalId, phrase, domain } = await readJson(req);
    if (!externalId || !phrase) {
      return sendJson(res, 400, { error: 'Нужны поля externalId и phrase.' });
    }
    sendJson(res, 200, await chat({ externalId, phrase, currentDomain: domain || 'general' }));
    return;
  }

  sendJson(res, 404, { error: 'Маршрут не найден.' });
}

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    console.error('Ошибка обработки запроса:', err.message);
    if (!res.headersSent) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
  }
});

server.listen(PORT, () => {
  console.log(`Песочница памяти запущена. Откройте в браузере http://localhost:${PORT}`);
});

// Корректное завершение: закрываем пул подключений к базе при остановке процесса.
async function shutdown() {
  server.close();
  await flushLlmLog();
  await closePool();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
