// Объединённая точка входа: один процесс Node.js, в котором одновременно работают веб-сервер админки и
// Telegram-канал (длинный опрос входящих сообщений плюс фоновый воркер планировщика и доставки).
// Оба сервиса ввод-выводные и живут на одном цикле событий, не мешая друг другу. Запуск: npm run server.
//
// Порядок запуска: сначала поднимается HTTP-сервер (чтобы админка и проверка работоспособности были
// доступны как можно раньше), затем запускается Telegram-бот. Завершение по сигналу останавливает оба
// сервиса и единожды закрывает общий пул соединений с БД — пулом владеет именно этот процесс.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from '../config.js';
import { closePool } from '../db.js';
import { createAdminApi } from './admin-api.js';
// Импорт bot.js регистрирует профиль канала Telegram и проверяет наличие токена. Сам бот при этом ещё не
// запускается: автозапуск внутри bot.js срабатывает только при прямом вызове (npm run telegram), а здесь
// мы управляем его жизненным циклом явно через startTelegram/stopTelegram.
import { startTelegram, stopTelegram } from '../telegram/bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Каталог собранного фронтенда (Vue + Vite кладёт сборку сюда командой npm run web:build).
const WEB_DIST = path.resolve(__dirname, '../../web/dist');
const PORT = config.admin.port;
const HOST = config.admin.host;

// Собрать приложение express: JSON-разбор тела, маршруты админ-API под префиксом /api, отдача собранного
// фронтенда и возврат index.html на любые прочие GET-маршруты (так одностраничное приложение Vue само
// обрабатывает свою маршрутизацию на стороне браузера, не получая 404 при перезагрузке вложенной страницы).
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use('/api', createAdminApi());

  // Статика собранного фронтенда. В режиме разработки каталога web/dist может не быть — это нормально:
  // тогда фронтенд обслуживает сервер разработки Vite (npm run web:dev), а этот процесс отдаёт только API.
  app.use(express.static(WEB_DIST));

  // Возврат одностраничного приложения для любых не-API GET-маршрутов. Express 5 не принимает строковый
  // шаблон '*', поэтому используем промежуточный слой: пропускаем запросы к /api, остальные GET отдаём
  // index.html. Если сборки ещё нет, честно сообщаем об этом понятным текстом, а не отдаём пустой ответ.
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

// Запустить HTTP-сервер и вернуть объект сервера (нужен для корректного закрытия при завершении).
function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, HOST, () => resolve(server));
    server.on('error', reject);
  });
}

async function main() {
  const app = buildApp();
  const server = await listen(app);
  console.log(`Веб-сервер админки слушает http://${HOST}:${PORT} (API доступен по пути /api).`);

  // Telegram запускаем после веб-сервера. Бот сам печатает в журнал, что длинный опрос активен.
  const { username } = await startTelegram();
  console.log(`Telegram-канал поднят в этом же процессе (бот @${username}).`);

  // Аккуратное завершение по сигналу: останавливаем приём новых HTTP-запросов, гасим Telegram-часть и
  // только потом закрываем общий пул соединений с БД. process.exit вызываем после освобождения ресурсов.
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      return;
    } // повторный сигнал во время завершения игнорируем
    shuttingDown = true;
    console.log(`\nПолучен сигнал ${signal}. Завершаю работу объединённого сервера…`);
    await new Promise((resolve) => server.close(resolve)); // ждём закрытия HTTP-сервера
    await stopTelegram();
    try {
      await closePool();
    } catch {
      /* пул мог быть не открыт */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Критическая ошибка запуска объединённого сервера:', err.message);
  process.exit(1);
});
