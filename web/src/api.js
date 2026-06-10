// Тонкая обёртка над fetch для обращения к админ-API. В режиме разработки запросы к /api проксируются
// сервером Vite на бэкенд, в продакшене фронтенд и API отдаются одним и тем же сервером express, поэтому
// относительный путь /api корректен в обоих режимах. При ошибочном HTTP-статусе бросаем исключение с
// человекочитаемым сообщением, чтобы компонент мог показать причину пользователю.
async function request(path, options) {
  const res = await fetch(`/api${path}`, options);
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

// Мягкое удаление одной записи памяти. Категория совпадает с ключом группы памяти на фронтенде
// (profile/dialog/domain/reminder/secure) и определяет, в какой таблице помечается запись удалённой.
export function deleteMemoryItem(userId, category, itemId) {
  return request(
    `/users/${encodeURIComponent(userId)}/memory/${encodeURIComponent(category)}/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' },
  );
}

// Состояние проактивности пользователя по его внутреннему идентификатору (поле id из списка пользователей).
export function fetchUserProactivity(userId) {
  return request(`/users/${encodeURIComponent(userId)}/proactivity`);
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
