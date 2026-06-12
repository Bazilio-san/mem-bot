<script setup>
// Левая панель: лента чата выбранного пользователя в стиле Telegram. Пузыри сообщений с временем,
// между ними — компактные бэйджи сервисных LLM-запросов (сжатие истории, проактивность и т. п.).
// Скролл вверх лениво подгружает более раннюю историю (keyset-пагинация ?before=). У пользовательских
// сообщений — кнопка журнала цикла; клик по бэйджу открывает журнал сервисной группы.
import { ref, watch, nextTick, onBeforeUnmount } from 'vue';
import DOMPurify from 'dompurify';
import { fetchTimeline, sendChatMessage, openChatEvents } from '../../api.js';
import NotesWidget from '../notes/NotesWidget.vue';

const props = defineProps({
  userId: { type: String, default: null },
});
const emit = defineEmits(['select-log', 'error']);

const draft = ref('');
const sending = ref(false);
const draftEl = ref(null);

// Авторост поля ввода: высота подстраивается под текст, но не превышает 250px — дальше внутренний скролл.
const DRAFT_MAX_HEIGHT = 250;

function autosizeDraft() {
  const el = draftEl.value;
  if (!el) {
    return;
  }
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, DRAFT_MAX_HEIGHT)}px`;
  el.style.overflowY = el.scrollHeight > DRAFT_MAX_HEIGHT ? 'auto' : 'hidden';
}

watch(draft, () => nextTick(autosizeDraft));

// Ход обработки отправленного сообщения: пока конвейер работает, в конце ленты висят два временных
// пузыря — отправленная фраза (сообщение пользователя пишется в БД только в конце конвейера, поэтому
// до завершения её нет в ленте) и черновик ответа бота со строкой текущего шага (стадии и инструменты)
// и растущим потоковым текстом. По завершении временные пузыри заменяются настоящими из ленты.
const pending = ref(null); // { userText, status, text } | null

// Прокрутка ленты в самый низ — чтобы временные пузыри и растущий черновик оставались на виду.
async function scrollToBottom() {
  await nextTick();
  if (scrollHost.value) {
    scrollHost.value.scrollTop = scrollHost.value.scrollHeight;
  }
}

// Отправка сообщения от имени пользователя: полный проход агентского конвейера на сервере с трансляцией
// хода по SSE, затем перезагрузка ленты и автоматическое открытие журнала свежего цикла.
async function send() {
  const text = draft.value.trim();
  if (!text || !props.userId || sending.value) {
    return;
  }
  sending.value = true;
  pending.value = { userText: text, status: 'Отправляю…', text: '' };
  scrollToBottom();
  try {
    const result = await sendChatMessage(props.userId, text, (event) => {
      if (!pending.value) {
        return;
      }
      if (event.type === 'status') {
        pending.value.status = event.title || '';
      } else if (event.type === 'delta') {
        pending.value.text += event.text;
      }
      scrollToBottom();
    });
    draft.value = '';
    await loadInitial();
    if (result.requestId) {
      activeKey.value = null;
      emit('select-log', { requestId: result.requestId, item: null });
    }
  } catch (err) {
    emit('error', err.message);
  } finally {
    pending.value = null;
    sending.value = false;
  }
}

const items = ref([]);
const hasMore = ref(false);
const loading = ref(false);
const activeKey = ref(null); // подсветка выбранного источника журнала
const scrollHost = ref(null);

// Цвета бэйджей сервисных запросов — те же, что у строк журнала соответствующего вида.
const BADGE_COLORS = {
  history_compress: '#ffebd9',
  proactive_message: '#c5ebf1',
  event_relevance: '#c5ebf1',
  fact_extract: '#ffe7e3',
  topic_extract: '#ffe7e3',
  embedding: '#f5edff',
  stt: '#f0e6af',
  tts: '#f0e6af',
  voice_summary: '#f0e6af',
};

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(iso) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

// Ключ дня для разделителей в ленте.
function dayKey(iso) {
  return new Date(iso).toDateString();
}

async function loadInitial() {
  items.value = [];
  hasMore.value = false;
  if (!props.userId) {
    return;
  }
  loading.value = true;
  try {
    const page = await fetchTimeline(props.userId, { limit: 50 });
    items.value = page.items;
    hasMore.value = page.hasMore;
    await nextTick();
    if (scrollHost.value) {
      scrollHost.value.scrollTop = scrollHost.value.scrollHeight;
    }
  } catch (err) {
    emit('error', err.message);
  } finally {
    loading.value = false;
  }
}

// Ленивая подгрузка вверх: запрашиваем страницу старше самого раннего элемента и сохраняем позицию скролла.
async function loadOlder() {
  if (loading.value || !hasMore.value || !items.value.length) {
    return;
  }
  loading.value = true;
  const host = scrollHost.value;
  const prevHeight = host ? host.scrollHeight : 0;
  try {
    const oldest = items.value[0].createdAt;
    const page = await fetchTimeline(props.userId, { before: oldest, limit: 50 });
    items.value = [...page.items, ...items.value];
    hasMore.value = page.hasMore;
    await nextTick();
    if (host) {
      host.scrollTop = host.scrollHeight - prevHeight;
    }
  } catch (err) {
    emit('error', err.message);
  } finally {
    loading.value = false;
  }
}

function onScroll() {
  if (scrollHost.value && scrollHost.value.scrollTop < 60) {
    loadOlder();
  }
}

function keyOf(item) {
  return item.type === 'message' ? `m:${item.id}` : `s:${item.requestId || item.llmRequestIds?.[0]}`;
}

// Содержимое пузыря рендерится как HTML (бот отвечает с Telegram-разметкой <b>/<i>/<a>…).
// Содержимое недоверенное, поэтому всегда проходит через DOMPurify.
function bubbleHtml(content) {
  return DOMPurify.sanitize(String(content ?? ''));
}

// Подстановка текста сообщения в строку ввода для повторной отправки/правки.
function quoteToInput(item) {
  draft.value = item.content || '';
}

function pickLog(item) {
  activeKey.value = keyOf(item);
  if (item.requestId) {
    emit('select-log', { requestId: item.requestId, item });
  } else if (item.llmRequestIds?.length) {
    emit('select-log', { llmRequestId: item.llmRequestIds[0], item });
  }
}

// --- Живое обновление ленты (SSE) ---------------------------------------------
// Сервер присылает событие на каждое новое сообщение диалога этого пользователя, в каком бы канале оно
// ни появилось (Telegram, проактивность, админ-чат в другой вкладке). По событию дозагружается хвост
// ленты без сброса позиции скролла: загруженная ранее история остаётся на месте.
let eventSource = null;
let refreshing = false;
let refreshQueued = false;

// Дозагрузка хвоста: свежая первая страница сливается с текущей лентой — совпадающие по ключу элементы
// обновляются на месте (сервисные группы пополняются вызовами), новые добавляются в конец.
async function refreshTail() {
  if (!props.userId) {
    return;
  }
  if (refreshing) {
    refreshQueued = true; // события могут приходить чаще, чем грузится страница — дожмём один раз в конце
    return;
  }
  refreshing = true;
  try {
    const page = await fetchTimeline(props.userId, { limit: 50 });
    const known = new Map(items.value.map((item) => [keyOf(item), item]));
    const fresh = [];
    for (const item of page.items) {
      const key = keyOf(item);
      if (known.has(key)) {
        Object.assign(known.get(key), item);
      } else {
        fresh.push(item);
      }
    }
    if (fresh.length) {
      const host = scrollHost.value;
      const wasAtBottom = host ? host.scrollHeight - host.scrollTop - host.clientHeight < 80 : true;
      items.value = [...items.value, ...fresh];
      await nextTick();
      if (host && wasAtBottom) {
        host.scrollTop = host.scrollHeight;
      }
    }
  } catch (err) {
    emit('error', err.message);
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      refreshTail();
    }
  }
}

function subscribeToChatEvents() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (!props.userId) {
    return;
  }
  eventSource = openChatEvents(props.userId);
  eventSource.addEventListener('message', () => refreshTail());
  // При обрыве EventSource переподключается сам, а open срабатывает на каждом успешном
  // (пере)подключении — дозагрузка хвоста добирает сообщения, пропущенные за время обрыва.
  eventSource.addEventListener('open', () => refreshTail());
}

watch(
  () => props.userId,
  () => {
    loadInitial();
    subscribeToChatEvents();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (eventSource) {
    eventSource.close();
  }
});

defineExpose({ reload: loadInitial });
</script>

<template>
  <aside class="cp">
    <div ref="scrollHost" class="cp-scroll" @scroll.passive="onScroll">
      <div v-if="!userId" class="cp-empty">Найдите пользователя в поиске сверху.</div>
      <template v-else>
        <div v-if="hasMore" class="cp-hint">↑ скролл вверх подгружает раннюю историю</div>
        <div v-else-if="items.length" class="cp-hint">начало истории</div>
        <div v-if="loading && !items.length" class="cp-hint">Загрузка истории…</div>

        <template v-for="(item, idx) in items" :key="keyOf(item)">
          <div v-if="idx === 0 || dayKey(items[idx - 1].createdAt) !== dayKey(item.createdAt)" class="cp-day">
            {{ dayLabel(item.createdAt) }}
          </div>

          <div
            v-if="item.type === 'service'"
            class="cp-badge"
            :class="{ active: activeKey === keyOf(item), error: item.hasError }"
            :style="{ background: BADGE_COLORS[item.kind] || '#e5e5e5' }"
            :title="`${item.title} · вызовов: ${item.llmRequestIds.length}`"
            @click="pickLog(item)"
          >
            ⚙ {{ item.title }}
            <span class="t">
              · {{ Number(item.totalTokens).toLocaleString('ru-RU') }} ткн · ${{ Number(item.priceUsd).toFixed(4) }} ·
              {{ fmtTime(item.createdAt) }}
            </span>
          </div>

          <div
            v-else
            class="cp-msg"
            :class="[item.role === 'user' ? 'user' : 'bot', { active: activeKey === keyOf(item) }]"
          >
            <div class="cp-bubble">
              <!-- eslint-disable-next-line vue/no-v-html — содержимое прошло DOMPurify -->
              <span v-html="bubbleHtml(item.content)" />
              <span class="cp-time">{{ fmtTime(item.createdAt) }}</span>
              <!-- Виджеты этого хода (MCP Apps): рендерятся нативными Vue-компонентами без iframe. -->
              <template v-if="item.widgets">
                <NotesWidget
                  v-for="(w, wi) in item.widgets.filter((x) => x.type === 'notes')"
                  :key="`w${wi}`"
                  class="cp-widget"
                  :token="w.token"
                  :initial-query="w.query || ''"
                  :data-url="w.dataUrl || '/api/notes'"
                />
              </template>
            </div>
            <button
              v-if="item.role === 'user' && item.hasLog"
              type="button"
              class="cp-logbtn"
              title="Показать журнал цикла"
              @click="pickLog(item)"
            >
              ≡
            </button>
            <button
              v-if="item.role === 'user'"
              type="button"
              class="cp-logbtn"
              title="Подставить в строку ввода"
              @click="quoteToInput(item)"
            >
              ↴
            </button>
          </div>
        </template>

        <!-- Временные пузыри на время обработки: отправленная фраза и черновик ответа со строкой
             текущего шага конвейера и растущим потоковым текстом. -->
        <template v-if="pending">
          <div class="cp-msg user">
            <div class="cp-bubble cp-pending">{{ pending.userText }}</div>
          </div>
          <div class="cp-msg bot">
            <div class="cp-bubble cp-pending">
              <span v-if="pending.text">{{ pending.text }}</span>
              <div class="cp-status"><span class="cp-spin">⏳</span> {{ pending.status }}</div>
            </div>
          </div>
        </template>
      </template>
    </div>
    <div v-if="userId" class="cp-input">
      <!-- Enter отправляет, Shift+Enter — перенос строки. Высота растёт с текстом до 250px. -->
      <textarea
        ref="draftEl"
        v-model="draft"
        rows="3"
        :disabled="sending"
        placeholder="Сообщение от имени пользователя…"
        @keydown.enter.exact.prevent="send"
      />
      <button type="button" :disabled="sending || !draft.trim()" title="Отправить" @click="send">
        {{ sending ? '…' : '➤' }}
      </button>
    </div>
  </aside>
</template>

<style scoped>
.cp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: #e7ebf0;
}
.cp-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cp-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #99a;
}
.cp-hint {
  align-self: center;
  font-size: 11px;
  color: #999;
  padding: 4px;
}
.cp-day {
  align-self: center;
  font-size: 11px;
  color: #777;
  background: rgba(255, 255, 255, 0.75);
  padding: 2px 10px;
  border-radius: 10px;
  margin: 6px 0;
}
.cp-msg {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  max-width: 92%;
}
.cp-widget {
  margin-top: 8px;
  min-width: 360px;
}
.cp-msg.user {
  align-self: flex-end;
  flex-direction: row-reverse;
}
.cp-msg.bot {
  align-self: flex-start;
}
.cp-bubble {
  padding: 6px 10px;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 1px 1px rgba(0, 0, 0, 0.08);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
}
.cp-msg.user .cp-bubble {
  background: #ffffdc;
  border-bottom-right-radius: 3px;
}
.cp-msg.bot .cp-bubble {
  border-bottom-left-radius: 3px;
}
.cp-msg.active .cp-bubble {
  outline: 2px solid #e8a33d;
}
/* Временные пузыри обработки: чуть приглушены, чтобы отличались от настоящих сообщений ленты. */
.cp-pending {
  opacity: 0.85;
}
.cp-status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #888;
  margin-top: 2px;
}
.cp-spin {
  display: inline-block;
  animation: cp-spin-pulse 1.2s ease-in-out infinite;
}
@keyframes cp-spin-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
.cp-time {
  font-size: 10px;
  color: #999;
  margin-left: 8px;
  white-space: nowrap;
}
.cp-logbtn {
  flex: none;
  border: 1px solid #ddd;
  background: #fff;
  color: #777;
  border-radius: 6px;
  width: 24px;
  height: 24px;
  font-size: 13px;
  line-height: 1;
  padding: 0;
  cursor: pointer;
}
.cp-logbtn:hover {
  color: #e8a33d;
  border-color: #e8a33d;
}
.cp-badge {
  align-self: center;
  display: inline-flex;
  gap: 6px;
  align-items: center;
  font-size: 11px;
  color: #555;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 12px;
  padding: 2px 10px;
  cursor: pointer;
  max-width: 95%;
}
.cp-badge:hover {
  filter: brightness(0.96);
}
.cp-badge.active {
  outline: 2px solid #e8a33d;
}
.cp-badge.error {
  border-color: #b3261e;
}
.cp-badge .t {
  color: #999;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cp-input {
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 8px;
  background: #fff;
  border-top: 1px solid #e2e5e9;
  flex: none;
}
.cp-input textarea {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid #d6d9de;
  border-radius: 6px;
  font: inherit;
  resize: none;
  overflow-y: hidden; /* до достижения max-height скролл прячется; дальше его включает autosizeDraft */
  max-height: 250px;
}
.cp-input button {
  border: none;
  background: #e8a33d;
  color: #fff;
  border-radius: 6px;
  padding: 8px 14px;
  cursor: pointer;
}
.cp-input button:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
