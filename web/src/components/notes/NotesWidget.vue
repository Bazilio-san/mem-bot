<script setup>
// Интерактивный виджет заметок. Рендерится нативно (без iframe) в ленте чата админки под сообщением
// ассистента, когда агент вызвал тул notes_show_widget, и переиспользуется страницей Telegram Mini App.
// Данные ходит за ними сам в REST API заметок (/api/notes): авторизация — либо widget-токен (проп token),
// либо initData Telegram (проп tgInitData). Список подгружается лениво при прокрутке (IntersectionObserver),
// поиск семантический (выполняется на сервере), CRUD полный, удаление — с кнопкой «Отменить».
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';

const props = defineProps({
  token: { type: String, default: null }, // widget-токен из notes_show_widget
  tgInitData: { type: String, default: null }, // initData Telegram Mini App
  initialQuery: { type: String, default: '' },
  dataUrl: { type: String, default: '/api/notes' },
  // Высота списка: в чате админки виджет компактный, в Mini App растягивается на экран.
  listMaxHeight: { type: String, default: '420px' },
});

const items = ref([]);
const total = ref(0);
const nextCursor = ref(null);
const loading = ref(false);
const errorText = ref('');
const q = ref(props.initialQuery);
const sentinel = ref(null);
const listHost = ref(null);

// Инлайн-редактор: null — закрыт; { id: null } — создание; { id } — правка существующей.
const editor = ref(null);
const saving = ref(false);
// Тост отмены удаления: { id, title, timer }.
const undo = ref(null);

const authHeaders = computed(() => {
  if (props.token) {
    return { Authorization: `Bearer ${props.token}` };
  }
  if (props.tgInitData) {
    return { 'X-Tg-Init-Data': props.tgInitData };
  }
  return {};
});

async function api(method, path = '', body = null) {
  const options = { method, headers: { 'Content-Type': 'application/json', ...authHeaders.value } };
  if (body) {
    options.body = JSON.stringify(body);
  }
  const res = await fetch(`${props.dataUrl}${path}`, options);
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.error || `Ошибка запроса (${res.status})`);
  }
  return json;
}

async function load(reset = false) {
  if (loading.value) {
    return;
  }
  loading.value = true;
  errorText.value = '';
  try {
    const params = new URLSearchParams({ limit: '20' });
    if (q.value.trim()) {
      params.set('q', q.value.trim());
    }
    if (!reset && nextCursor.value) {
      params.set('cursor', nextCursor.value);
    }
    const page = await api('GET', `?${params}`);
    items.value = reset ? page.items : [...items.value, ...page.items];
    nextCursor.value = page.nextCursor;
    total.value = page.total;
  } catch (err) {
    errorText.value = err.message;
  } finally {
    loading.value = false;
  }
}

// Поиск с задержкой: каждое изменение строки перезапрашивает первую страницу через 400 мс тишины.
let searchTimer = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    nextCursor.value = null;
    load(true);
  }, 400);
}

// Ленивая подгрузка: сторожевой элемент в конце списка.
let observer = null;
onMounted(async () => {
  await load(true);
  await nextTick();
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting && nextCursor.value && !loading.value) {
        load(false);
      }
    },
    { root: listHost.value, rootMargin: '80px' },
  );
  if (sentinel.value) {
    observer.observe(sentinel.value);
  }
});
onBeforeUnmount(() => {
  observer?.disconnect();
  clearTimeout(searchTimer);
  if (undo.value) {
    clearTimeout(undo.value.timer);
  }
});

function openEditor(note = null) {
  editor.value = note
    ? { id: note.id, title: note.title, body: note.body, tags: note.tags.join(', ') }
    : { id: null, title: '', body: '', tags: '' };
}

async function saveEditor() {
  if (!editor.value || saving.value) {
    return;
  }
  const payload = {
    title: editor.value.title,
    body: editor.value.body,
    tags: editor.value.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  };
  saving.value = true;
  errorText.value = '';
  try {
    if (editor.value.id == null) {
      await api('POST', '', payload);
    } else {
      await api('PATCH', `/${editor.value.id}`, payload);
    }
    editor.value = null;
    await load(true);
  } catch (err) {
    errorText.value = err.message;
  } finally {
    saving.value = false;
  }
}

async function togglePin(note) {
  errorText.value = '';
  try {
    await api('PATCH', `/${note.id}`, { pinned: !note.pinned });
    await load(true);
  } catch (err) {
    errorText.value = err.message;
  }
}

async function removeNote(note) {
  errorText.value = '';
  try {
    await api('DELETE', `/${note.id}`);
    if (undo.value) {
      clearTimeout(undo.value.timer);
    }
    undo.value = {
      id: note.id,
      title: note.title || `#${note.id}`,
      timer: setTimeout(() => {
        undo.value = null;
      }, 7000),
    };
    await load(true);
  } catch (err) {
    errorText.value = err.message;
  }
}

async function restoreNote() {
  if (!undo.value) {
    return;
  }
  const { id, timer } = undo.value;
  clearTimeout(timer);
  undo.value = null;
  errorText.value = '';
  try {
    await api('POST', `/${id}/restore`);
    await load(true);
  } catch (err) {
    errorText.value = err.message;
  }
}

function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}
</script>

<template>
  <div class="nw">
    <div class="nw-head">
      <span class="nw-title">📝 Заметки</span>
      <span class="nw-count">{{ q.trim() ? `найдено: ${items.length}` : `всего: ${total}` }}</span>
      <input v-model="q" class="nw-search" placeholder="Поиск по смыслу…" @input="onSearchInput" />
      <button type="button" class="nw-btn" @click="openEditor()">+ Новая</button>
    </div>

    <div v-if="errorText" class="nw-error">{{ errorText }}</div>

    <div v-if="editor" class="nw-editor">
      <input v-model="editor.title" placeholder="Заголовок" />
      <textarea v-model="editor.body" placeholder="Текст заметки…" rows="4"></textarea>
      <input v-model="editor.tags" placeholder="Теги через запятую" />
      <div class="nw-editor-row">
        <button type="button" class="nw-btn ghost" @click="editor = null">Отмена</button>
        <button type="button" class="nw-btn" :disabled="saving || !editor.body.trim()" @click="saveEditor">
          {{ saving ? '…' : editor.id == null ? 'Создать' : 'Сохранить' }}
        </button>
      </div>
    </div>

    <div ref="listHost" class="nw-list" :style="{ maxHeight: listMaxHeight }">
      <div v-for="note in items" :key="note.id" class="nw-card" :class="{ pinned: note.pinned }">
        <div class="nw-card-top">
          <span class="nw-card-title">
            <span v-if="note.pinned" class="nw-pin">📌</span>
            {{ note.title || 'Без названия' }}
          </span>
          <span class="nw-card-date">{{ fmtDate(note.updated_at) }}</span>
        </div>
        <div class="nw-card-body">{{ note.body }}</div>
        <div v-if="note.tags.length" class="nw-tags">
          <span v-for="t in note.tags" :key="t" class="nw-tag">#{{ t }}</span>
        </div>
        <div class="nw-actions">
          <button type="button" title="Редактировать" @click="openEditor(note)">✏️</button>
          <button type="button" :title="note.pinned ? 'Открепить' : 'Закрепить'" @click="togglePin(note)">
            {{ note.pinned ? '📌' : '📍' }}
          </button>
          <button type="button" class="danger" title="Удалить" @click="removeNote(note)">🗑️</button>
        </div>
      </div>

      <div v-if="!loading && !items.length" class="nw-empty">
        {{ q.trim() ? `Ничего не найдено по запросу «${q.trim()}»` : 'Заметок пока нет — создайте первую!' }}
      </div>
      <div ref="sentinel" class="nw-sentinel">
        <span v-if="loading">Загрузка…</span>
        <span v-else-if="nextCursor">прокрутите вниз, чтобы показать ещё</span>
        <span v-else-if="items.length">— конец списка —</span>
      </div>
    </div>

    <div v-if="undo" class="nw-undo">
      Заметка «{{ undo.title }}» удалена.
      <button type="button" @click="restoreNote">Отменить</button>
    </div>
  </div>
</template>

<style scoped>
.nw {
  background: #fff;
  border: 1px solid #e2e5ea;
  border-radius: 10px;
  overflow: hidden;
  font-size: 13px;
  width: 100%;
}
.nw-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: #fafbfc;
  border-bottom: 1px solid #e2e5ea;
}
.nw-title {
  font-weight: 600;
  white-space: nowrap;
}
.nw-count {
  color: #8a93a2;
  font-size: 11.5px;
  white-space: nowrap;
}
.nw-search {
  flex: 1;
  min-width: 80px;
  padding: 5px 9px;
  border: 1px solid #d6d9de;
  border-radius: 7px;
  font: inherit;
}
.nw-btn {
  border: none;
  background: #e8a33d;
  color: #fff;
  border-radius: 7px;
  padding: 6px 11px;
  cursor: pointer;
  font-size: 12.5px;
  white-space: nowrap;
}
.nw-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.nw-btn.ghost {
  background: transparent;
  color: #777;
  border: 1px solid #d6d9de;
}
.nw-error {
  padding: 6px 10px;
  color: #b3261e;
  background: #fdecea;
  font-size: 12px;
}
.nw-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  background: #f0f7ff;
  border-bottom: 1px solid #e2e5ea;
}
.nw-editor input,
.nw-editor textarea {
  padding: 6px 9px;
  border: 1px solid #d6d9de;
  border-radius: 7px;
  font: inherit;
  resize: vertical;
}
.nw-editor-row {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.nw-list {
  overflow-y: auto;
}
.nw-card {
  position: relative;
  padding: 8px 10px;
  border-bottom: 1px solid #eef0f3;
}
.nw-card:hover {
  background: #f8fafc;
}
.nw-card.pinned {
  background: #fffbeb;
}
.nw-card-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.nw-card-title {
  font-weight: 600;
  flex: 1;
  word-break: break-word;
}
.nw-pin {
  font-size: 11px;
}
.nw-card-date {
  color: #99a1ad;
  font-size: 11px;
  white-space: nowrap;
}
.nw-card-body {
  color: #374151;
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
}
.nw-tags {
  margin-top: 5px;
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
.nw-tag {
  background: #eef2ff;
  color: #4338ca;
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 99px;
}
.nw-actions {
  position: absolute;
  right: 8px;
  bottom: 6px;
  display: none;
  gap: 2px;
  background: #fff;
  border: 1px solid #e2e5ea;
  border-radius: 7px;
  padding: 1px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
.nw-card:hover .nw-actions {
  display: flex;
}
.nw-actions button {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  padding: 3px 5px;
  border-radius: 5px;
}
.nw-actions button:hover {
  background: #f1f3f5;
}
.nw-actions button.danger:hover {
  background: #fef2f2;
}
.nw-empty {
  padding: 26px 12px;
  text-align: center;
  color: #99a1ad;
}
.nw-sentinel {
  padding: 8px;
  text-align: center;
  color: #99a1ad;
  font-size: 11.5px;
  min-height: 14px;
}
.nw-undo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  background: #111827;
  color: #fff;
  font-size: 12px;
}
.nw-undo button {
  border: none;
  background: transparent;
  color: #fbbf24;
  cursor: pointer;
  font-weight: 600;
  font-size: 12px;
}
</style>
