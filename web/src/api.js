// Тонкая обёртка над fetch для обращения к админ-API. В режиме разработки запросы к /api проксируются
// сервером Vite на бэкенд, в продакшене фронтенд и API отдаются одним и тем же сервером express, поэтому
// относительный путь /api корректен в обоих режимах. При ошибочном HTTP-статусе бросаем исключение с
// человекочитаемым сообщением, чтобы компонент мог показать причину пользователю.
async function request(path, options) {
  const res = await fetch(`/api${path}`, options);
  if (!res.ok) {
    // 401 означает, что админ-сессия отсутствует или истекла: корневой компонент слушает это событие
    // и показывает экран входа вместо приложения.
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('admin-auth-required'));
    }
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

// --- Авторизация админки -------------------------------------------------------

// Статус сессии: требуется ли вход, авторизован ли пользователь, username бота для Login Widget.
export function fetchAuthMe() {
  return request('/auth/me');
}

// Вход: data — объект, который Telegram Login Widget передал в onauth-колбэк (id, auth_date, hash и т.д.).
export function loginTelegram(data) {
  return request('/auth/telegram', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export function logoutAdmin() {
  return request('/auth/logout', { method: 'POST' });
}

// Список всех пользователей.
export function fetchUsers() {
  return request('/users');
}

// Вся память выбранного пользователя по его внутреннему идентификатору.
export function fetchUserMemory(userId) {
  return request(`/users/${encodeURIComponent(userId)}/memory`);
}

// Мягкое удаление одной записи памяти. Категория совпадает с ключом группы памяти на фронтенде
// (profile/dialog/domain/reminder/secure) и определяет, в какой таблице помечается запись удалённой.
export function deleteMemoryItem(userId, category, itemId) {
  return request(
    `/users/${encodeURIComponent(userId)}/memory/${encodeURIComponent(category)}/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' },
  );
}

// Каскадное удаление пользователя и всех его данных (диалоги, факты, задачи, уведомления и т.д.).
// Журналы вызовов инструментов и LLM-запросов при этом сохраняются — у них лишь обнуляется ссылка
// на пользователя либо они живут в отдельной БД логов.
export function deleteUser(userId) {
  return request(`/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

// Состояние проактивности пользователя по его внутреннему идентификатору (поле id из списка пользователей).
export function fetchUserProactivity(userId) {
  return request(`/users/${encodeURIComponent(userId)}/proactivity`);
}

// --- Вкладка «База знаний» (глобальный RAG) -----------------------------------

// Список доменов агента — опции выпадающего списка «Домен» в форме записи.
export function fetchDomains() {
  return request('/domains');
}

// Записи базы знаний. status: undefined — active и archived, 'all' — все, либо список через запятую
// (например 'deleted' — корзина). Вектор эмбеддинга не передаётся, только флаг hasEmbedding.
export function fetchKnowledge(status) {
  return request(`/knowledge${status ? `?status=${encodeURIComponent(status)}` : ''}`);
}

// Неточный текстовый поиск по базе: полнотекст плюс триграммная похожесть (ловит опечатки и словоформы).
// Ответ — записи в форме списка с дополнительным полем relevance (0–1), самые релевантные первыми.
export function searchKnowledgeText(q, status) {
  const params = new URLSearchParams({ q });
  if (status) {
    params.set('status', status);
  }
  return request(`/knowledge/search?${params}`);
}

// Создание записи. Сервер сразу считает эмбеддинг; в ответе — созданная запись с hasEmbedding.
export function createKnowledge(record) {
  return request('/knowledge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
}

// Обновление записи. При изменении текста сервер сбрасывает и пересчитывает эмбеддинг;
// восстановление из корзины — тот же запрос со status: 'active'.
export function updateKnowledge(id, record) {
  return request(`/knowledge/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
}

// Мягкое удаление записи (status = 'deleted', запись попадает в корзину).
export function deleteKnowledge(id) {
  return request(`/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// Ручной пересчёт эмбеддинга записи. В ответе — обновлённая запись.
export function reembedKnowledge(id) {
  return request(`/knowledge/${encodeURIComponent(id)}/embed`, { method: 'POST' });
}

// --- Страница «Логи LLM» -----------------------------------------------------

// Подсказки поиска пользователя: по имени, внешнему (Telegram) id или точному внутреннему UUID.
export function searchUsers(q) {
  return request(`/users/search?q=${encodeURIComponent(q)}`);
}

// Лента чата пользователя: сообщения диалога вперемешку с бэйджами сервисных LLM-запросов.
// before — ISO-время, страница возвращает элементы строго старше него (ленивая подгрузка вверх).
export function fetchTimeline(userId, { before, limit } = {}) {
  const params = new URLSearchParams();
  if (before) {
    params.set('before', before);
  }
  if (limit) {
    params.set('limit', String(limit));
  }
  const qs = params.toString();
  return request(`/users/${encodeURIComponent(userId)}/timeline${qs ? `?${qs}` : ''}`);
}

// Журнал одного цикла «фраза пользователя → ответ» по корреляционному request_id.
export function fetchCycle(requestId) {
  return request(`/llm-log/cycle/${encodeURIComponent(requestId)}`);
}

// Журнал одиночной сервисной записи (бэйдж без request_id) по первичному ключу журнала.
export function fetchSingleRequest(llmRequestId) {
  return request(`/llm-log/request/${encodeURIComponent(llmRequestId)}`);
}

// Отправка сообщения от имени пользователя из чат-панели админки. Ответ содержит текст бота и
// request_id свежего цикла — по нему сразу открывается журнал.
export function sendChatMessage(userId, text) {
  return request(`/users/${encodeURIComponent(userId)}/chat-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

// Настройки AI-анализа (список моделей и CLI-пресетов) для выпадающих списков диалога.
export function fetchLogAnalysisConfig() {
  return request('/llm-log/analysis-config');
}

// Запуск AI-анализа контекста запроса. Ответ приходит потоком (SSE поверх fetch): onChunk вызывается на
// каждый фрагмент текста, по завершении промис разрешается полным текстом. Ошибка статуса бросается как
// исключение с сообщением сервера.
export async function runLogAnalysis({ llmRequestId, question, engine, model, preset }, onChunk) {
  const res = await fetch('/api/llm-log/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ llmRequestId, question, engine, model, preset }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error ? `: ${body.error}` : '';
    } catch {
      /* тело не JSON */
    }
    throw new Error(`Анализ вернул статус ${res.status}${detail}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    // Разбор кадров SSE: события разделены пустой строкой, текст — в строках "data: …".
    let sep;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');
      if (!data) {
        continue;
      }
      const parsed = JSON.parse(data);
      if (parsed.error) {
        throw new Error(parsed.error);
      }
      if (parsed.text) {
        full += parsed.text;
        if (onChunk) {
          onChunk(parsed.text, full);
        }
      }
    }
  }
  return full;
}
