// Тонкая обёртка над fetch для обращения к админ-API. В режиме разработки запросы к /api проксируются
// сервером Vite на бэкенд, в продакшене фронтенд и API отдаются одним и тем же сервером express, поэтому
// относительный путь /api корректен в обоих режимах. При ошибочном HTTP-статусе бросаем исключение с
// человекочитаемым сообщением, чтобы компонент мог показать причину пользователю.
async function request(path) {
  const res = await fetch(`/api${path}`);
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error ? `: ${body.error}` : '';
    } catch {
      /* тело ответа не JSON — оставляем только статус */
    }
    throw new Error(`Запрос ${path} вернул статус ${res.status}${detail}`);
  }
  return res.json();
}

// Список всех пользователей.
export function fetchUsers() {
  return request('/users');
}

// Вся память выбранного пользователя по его внутреннему идентификатору.
export function fetchUserMemory(userId) {
  return request(`/users/${encodeURIComponent(userId)}/memory`);
}

// Состояние проактивности пользователя по его внутреннему идентификатору (поле id из списка пользователей).
export function fetchUserProactivity(userId) {
  return request(`/users/${encodeURIComponent(userId)}/proactivity`);
}
