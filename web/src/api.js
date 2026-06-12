// Thin wrapper around fetch for talking to the admin API. In development mode /api requests are proxied
// by the Vite server to the backend; in production the frontend and the API are served by the same express
// server, so the relative /api path is correct in both modes. On a failing HTTP status we throw an exception
// with a human-readable message so the component can show the reason to the user.
async function request(path, options) {
  const res = await fetch(`/api${path}`, options);
  if (!res.ok) {
    // 401 means the admin session is missing or expired: the root component listens for this event
    // and shows the login screen instead of the app.
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('admin-auth-required'));
    }
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error ? `: ${body.error}` : '';
    } catch {
      /* response body is not JSON — keep only the status */
    }
    throw new Error(`Запрос ${path} вернул статус ${res.status}${detail}`);
  }
  return res.json();
}

// --- Admin authentication -------------------------------------------------------

// Session status: whether login is required, whether the user is authorized, bot username for the Login Widget.
export function fetchAuthMe() {
  return request('/auth/me');
}

// Login: data is the object the Telegram Login Widget passed to the onauth callback (id, auth_date, hash etc.).
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

// List of all users.
export function fetchUsers() {
  return request('/users');
}

// All memory of the selected user by their internal identifier.
export function fetchUserMemory(userId) {
  return request(`/users/${encodeURIComponent(userId)}/memory`);
}

// Soft deletion of a single memory item. The category matches the memory group key on the frontend
// (profile/dialog/domain/reminder/secure) and determines in which table the record is marked deleted.
export function deleteMemoryItem(userId, category, itemId) {
  return request(
    `/users/${encodeURIComponent(userId)}/memory/${encodeURIComponent(category)}/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' },
  );
}

// Cascading deletion of a user and all their data (conversations, facts, tasks, notifications etc.).
// Tool call and LLM request logs are kept — only their user reference is nulled,
// or they live in a separate logs DB.
export function deleteUser(userId) {
  return request(`/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
}

// Proactivity state of a user by their internal identifier (the id field from the user list).
export function fetchUserProactivity(userId) {
  return request(`/users/${encodeURIComponent(userId)}/proactivity`);
}

// --- "Knowledge base" tab (global RAG) -----------------------------------------

// List of agent domains — options for the "Domain" dropdown in the record form.
export function fetchDomains() {
  return request('/domains');
}

// Knowledge base records. status: undefined — active and archived, 'all' — everything, or a comma-separated
// list (e.g. 'deleted' — the trash). The embedding vector is not sent, only the hasEmbedding flag.
export function fetchKnowledge(status) {
  return request(`/knowledge${status ? `?status=${encodeURIComponent(status)}` : ''}`);
}

// Fuzzy text search over the base: full-text plus trigram similarity (catches typos and word forms).
// Response — records in list form with an extra relevance field (0–1), most relevant first.
export function searchKnowledgeText(q, status) {
  const params = new URLSearchParams({ q });
  if (status) {
    params.set('status', status);
  }
  return request(`/knowledge/search?${params}`);
}

// Record creation. The server computes the embedding right away; the response is the created record with hasEmbedding.
export function createKnowledge(record) {
  return request('/knowledge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
}

// Record update. When the text changes, the server resets and recomputes the embedding;
// restoring from the trash is the same request with status: 'active'.
export function updateKnowledge(id, record) {
  return request(`/knowledge/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
}

// Soft deletion of a record (status = 'deleted', the record goes to the trash).
export function deleteKnowledge(id) {
  return request(`/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// Manual recomputation of a record's embedding. The response is the updated record.
export function reembedKnowledge(id) {
  return request(`/knowledge/${encodeURIComponent(id)}/embed`, { method: 'POST' });
}

// --- "LLM logs" page -----------------------------------------------------------

// User search suggestions: by name, external (Telegram) id or exact internal UUID.
export function searchUsers(q) {
  return request(`/users/search?q=${encodeURIComponent(q)}`);
}

// User chat timeline: conversation messages interleaved with service LLM request badges.
// before — ISO time; the page returns items strictly older than it (lazy loading upwards).
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

// Log of one "user phrase → answer" cycle by the correlation request_id.
export function fetchCycle(requestId) {
  return request(`/llm-log/cycle/${encodeURIComponent(requestId)}`);
}

// Log of a single service record (a badge without request_id) by the log's primary key.
export function fetchSingleRequest(llmRequestId) {
  return request(`/llm-log/request/${encodeURIComponent(llmRequestId)}`);
}

// Sending a message on behalf of the user from the admin chat pane. The response arrives as a stream
// (SSE over fetch): onEvent is called for every pipeline progress frame — {type:'status', title} with the
// current step change and {type:'delta', text} with a chunk of the streamed answer text. On completion the
// promise resolves to {answer, requestId} — the fresh cycle's log is opened right away by requestId. A bad
// HTTP status and a {type:'error'} frame are thrown as an exception with the server message.
export async function sendChatMessage(userId, text, onEvent) {
  const res = await fetch(`/api/users/${encodeURIComponent(userId)}/chat-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    if (res.status === 401) {
      window.dispatchEvent(new CustomEvent('admin-auth-required'));
    }
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error ? `: ${body.error}` : '';
    } catch {
      /* body is not JSON */
    }
    throw new Error(`Отправка сообщения вернула статус ${res.status}${detail}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    // SSE frame parsing: events are separated by an empty line, the payload is in "data: …" lines.
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
      if (parsed.type === 'error') {
        throw new Error(parsed.error || 'Ошибка обработки сообщения.');
      }
      if (parsed.type === 'done') {
        result = { answer: parsed.answer, requestId: parsed.requestId };
      } else if (onEvent) {
        onEvent(parsed);
      }
    }
  }
  if (!result) {
    throw new Error('Поток ответа оборвался до завершения обработки.');
  }
  return result;
}

// Real-time subscription to a user's chat events (SSE). The server sends an event for every new
// conversation message, whatever channel it appeared in (Telegram, proactivity, the admin chat itself).
// Returns an EventSource; the caller must close it with close() when switching users.
export function openChatEvents(userId) {
  return new EventSource(`/api/users/${encodeURIComponent(userId)}/chat-events`);
}

// AI analysis settings (list of models and CLI presets) for the dialog's dropdowns.
export function fetchLogAnalysisConfig() {
  return request('/llm-log/analysis-config');
}

// Starting an AI analysis of the request context. The response arrives as a stream (SSE over fetch):
// onChunk is called for every text fragment, on completion the promise resolves to the full text.
// A bad status is thrown as an exception with the server message.
export async function runLogAnalysis({ llmRequestId, question, engine, model, preset, prompt }, onChunk) {
  const res = await fetch('/api/llm-log/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ llmRequestId, question, engine, model, preset, prompt }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error ? `: ${body.error}` : '';
    } catch {
      /* body is not JSON */
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
    // SSE frame parsing: events are separated by an empty line, the text is in "data: …" lines.
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
