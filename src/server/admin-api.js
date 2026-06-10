// Маршруты административного интерфейса (JSON-API под префиксом /api). Это тонкий слой поверх уже
// существующих функций выборки данных из песочницы (src/sandbox/data.js): админка переиспользует тот же
// код, что и наглядная страница песочницы, поэтому отдельной бизнес-логики здесь нет. Каждый маршрут
// оборачивает вызов в try/catch и при ошибке возвращает понятный JSON с кодом 500, чтобы фронтенд мог
// показать причину, а не «белый экран».
import express from 'express';
import { listUsers, getUserMemory, getProactivity } from '../sandbox/data.js';

// Небольшая обёртка: ловит исключение асинхронного обработчика и отдаёт его как JSON-ошибку 500.
// Без неё отклонённый промис в обработчике express не превратился бы в ответ и запрос «завис» бы.
function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error(`Ошибка админ-API ${req.method} ${req.originalUrl}:`, err.message);
      res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера.' });
    }
  };
}

// Собрать маршрутизатор админ-API. Вынесено в функцию, чтобы точка входа сервера сама решала, под каким
// префиксом его смонтировать, и могла при необходимости добавить вокруг него свои промежуточные слои.
export function createAdminApi() {
  const router = express.Router();

  // Проверка работоспособности: фронтенд и системы мониторинга по этому маршруту убеждаются, что сервер жив.
  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Список всех пользователей (для левой панели админки).
  router.get(
    '/users',
    wrap(async (_req, res) => {
      const users = await listUsers();
      res.json(users);
    }),
  );

  // Вся активная память выбранного пользователя, разложенная по категориям.
  router.get(
    '/users/:id/memory',
    wrap(async (req, res) => {
      const memory = await getUserMemory(req.params.id);
      res.json(memory);
    }),
  );

  // Состояние проактивности выбранного пользователя (мастер-флаг и список поводов).
  router.get(
    '/users/:id/proactivity',
    wrap(async (req, res) => {
      const state = await getProactivity(req.params.id);
      res.json(state);
    }),
  );

  return router;
}
