<script setup>
// Тело LLM-запроса с многослойным прогрессивным раскрытием. Три зоны:
// 1) чипы скалярных параметров (model, temperature, …) — всегда видны;
// 2) messages — по строке на сообщение (роль + превью), клик раскрывает содержимое инлайном; у длинных
//    сообщений после бэджа роли есть кнопка, открывающая то же содержимое в модальном окне на весь экран;
// 3) tools — по строке на инструмент (имя + первые слова описания), первый клик раскрывает описание,
//    отдельная кнопка показывает JSON Schema параметров.
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import ContentViewer from './ContentViewer.vue';

const props = defineProps({
  payload: { type: [Object, Array, String], default: null },
  binaryMeta: { type: Object, default: null },
});

// Порог «длинного» сообщения: длиннее — в строке появляется кнопка открытия модального окна.
// На само инлайн-раскрытие порог не влияет: одинарный клик всегда раскрывает содержимое в списке.
const INLINE_LIMIT = 2000;

const payloadObj = computed(() => {
  if (props.payload && typeof props.payload === 'object') {
    return props.payload;
  }
  if (typeof props.payload === 'string') {
    try {
      return JSON.parse(props.payload);
    } catch {
      return null;
    }
  }
  return null;
});

const chips = computed(() => {
  const p = payloadObj.value;
  if (!p || Array.isArray(p)) {
    return [];
  }
  return Object.entries(p)
    .filter(([, v]) => v !== null && typeof v !== 'object')
    .map(([k, v]) => ({ key: k, value: String(v) }));
});

const messages = computed(() => (Array.isArray(payloadObj.value?.messages) ? payloadObj.value.messages : []));
const tools = computed(() => (Array.isArray(payloadObj.value?.tools) ? payloadObj.value.tools : []));

// Имя и описание инструмента: поддерживаем оба формата — «плоский» и обёртку {type:'function', function:{…}}.
function toolInfo(t) {
  const fn = t?.function && typeof t.function === 'object' ? t.function : t;
  return { name: fn?.name || '?', description: fn?.description || '', parameters: fn?.parameters || null };
}

function messageContent(m) {
  if (typeof m?.content === 'string') {
    return m.content;
  }
  return m?.content == null ? '' : JSON.stringify(m.content);
}

function preview(m) {
  const c = messageContent(m).replace(/\s+/g, ' ').trim();
  if (c) {
    return c.slice(0, 160);
  }
  return m?.tool_calls?.length ? '⟨вызовы инструментов⟩' : '⟨пусто⟩';
}

function toolCallTags(m) {
  return (m?.tool_calls || []).map((tc) => tc?.function?.name || '?');
}

// Формат содержимого сообщения по роли: user/system — сырой текст, tool — JSON;
// assistant — единственная роль с переменным содержимым, остаётся автодетекция (null).
function roleFormat(role) {
  if (role === 'user' || role === 'system') {
    return 'RAW';
  }
  if (role === 'tool') {
    return 'JSON';
  }
  return null;
}

const openedMessages = ref(new Set());
const openedTools = ref(new Set());
const openedParams = ref(new Set());
const bigContent = ref(null); // содержимое для модального окна

function toggleSet(setRef, idx) {
  const next = new Set(setRef.value);
  if (next.has(idx)) {
    next.delete(idx);
  } else {
    next.add(idx);
  }
  setRef.value = next;
}

function clickMessage(idx) {
  toggleSet(openedMessages, idx);
}

// Открыть содержимое сообщения в модальном окне (кнопка у длинных сообщений).
function openBig(idx) {
  bigContent.value = messageContent(messages.value[idx]);
}

function setAllMessages(open) {
  openedMessages.value = open ? new Set(messages.value.map((_, i) => i)) : new Set();
}

// --- Растягиваемое модальное окно «Содержимое сообщения» -------------------------------------------
// PrimeVue Dialog не умеет менять размер за произвольную сторону, поэтому окно собственное: 8 ручек
// (4 стороны + 4 угла), размер сохраняется в localStorage и восстанавливается при следующем открытии.
const DLG_SIZE_KEY = 'llmLog.contentDialog.size';
const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const MIN_W = 320;
const MIN_H = 200;
const dlg = ref({ w: 900, h: 600, x: 0, y: 0 });

function savedSize() {
  try {
    const s = JSON.parse(localStorage.getItem(DLG_SIZE_KEY) || 'null');
    return s && Number(s.w) >= MIN_W && Number(s.h) >= MIN_H ? { w: Number(s.w), h: Number(s.h) } : null;
  } catch {
    return null;
  }
}

// При каждом открытии: восстановленный (или дефолтный) размер, ограниченный окном браузера, по центру.
watch(bigContent, (v) => {
  if (v === null) {
    return;
  }
  const saved = savedSize();
  const w = Math.min(saved?.w ?? Math.min(900, window.innerWidth - 24), window.innerWidth - 24);
  const h = Math.min(saved?.h ?? Math.round(window.innerHeight * 0.8), window.innerHeight - 24);
  dlg.value = { w, h, x: Math.round((window.innerWidth - w) / 2), y: Math.round((window.innerHeight - h) / 2) };
});

let drag = null;
function onResizeMove(e) {
  if (!drag) {
    return;
  }
  const dx = e.clientX - drag.sx;
  const dy = e.clientY - drag.sy;
  const d = { ...dlg.value };
  if (drag.dir.includes('e')) {
    d.w = Math.max(MIN_W, drag.w + dx);
  }
  if (drag.dir.includes('s')) {
    d.h = Math.max(MIN_H, drag.h + dy);
  }
  if (drag.dir.includes('w')) {
    d.w = Math.max(MIN_W, drag.w - dx);
    d.x = drag.x + (drag.w - d.w);
  }
  if (drag.dir.includes('n')) {
    d.h = Math.max(MIN_H, drag.h - dy);
    d.y = drag.y + (drag.h - d.h);
  }
  dlg.value = d;
}

function onResizeEnd() {
  if (!drag) {
    return;
  }
  drag = null;
  window.removeEventListener('pointermove', onResizeMove);
  window.removeEventListener('pointerup', onResizeEnd);
  try {
    localStorage.setItem(DLG_SIZE_KEY, JSON.stringify({ w: dlg.value.w, h: dlg.value.h }));
  } catch {
    /* localStorage недоступен — размер просто не сохранится */
  }
}

function startResize(e, dir) {
  drag = { dir, sx: e.clientX, sy: e.clientY, ...dlg.value };
  window.addEventListener('pointermove', onResizeMove);
  window.addEventListener('pointerup', onResizeEnd);
  e.preventDefault();
}

function onDlgKeydown(e) {
  if (e.key === 'Escape') {
    bigContent.value = null;
  }
}
watch(bigContent, (v) => {
  if (v !== null) {
    window.addEventListener('keydown', onDlgKeydown);
  } else {
    window.removeEventListener('keydown', onDlgKeydown);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onDlgKeydown);
  onResizeEnd();
});
</script>

<template>
  <div class="pv">
    <div v-if="chips.length" class="pv-chips">
      <span v-for="c in chips" :key="c.key" class="pv-chip"
        ><b>{{ c.key }}</b
        >: {{ c.value }}</span
      >
    </div>

    <div v-if="binaryMeta" class="pv-chips">
      <span v-for="(v, k) in binaryMeta" :key="k" class="pv-chip pv-chip-bin"
        ><b>{{ k }}</b
        >: {{ v }}</span
      >
    </div>

    <div v-if="messages.length" class="pv-sect">
      <div class="pv-sect-h">
        messages — {{ messages.length }}
        <button type="button" class="pv-mini" @click="setAllMessages(true)">раскрыть все</button>
        <button type="button" class="pv-mini" @click="setAllMessages(false)">свернуть все</button>
      </div>
      <div
        v-for="(m, idx) in messages"
        :key="idx"
        class="pv-msg"
        :class="[`msg-${m.role}`, { open: openedMessages.has(idx) }]"
      >
        <div class="pv-msg-h" @click="clickMessage(idx)">
          <span class="pv-role" :class="`role-${m.role}`">{{ m.role }}</span>
          <button
            v-if="messageContent(m).length > INLINE_LIMIT"
            type="button"
            class="pv-pop"
            title="Открыть в окне"
            @click.stop="openBig(idx)"
          >
            ⤢
          </button>
          <span v-for="tn in toolCallTags(m)" :key="tn" class="pv-tcall">🛠 {{ tn }}</span>
          <span class="pv-prev">{{ preview(m) }}</span>
          <span class="pv-len">{{ messageContent(m).length.toLocaleString('ru-RU') }} симв.</span>
        </div>
        <div v-if="openedMessages.has(idx)" class="pv-msg-b">
          <div v-if="m.tool_calls?.length" class="pv-tcalls">
            <div v-for="(tc, i) in m.tool_calls" :key="i">
              <b>{{ tc.function?.name }}</b>
              <ContentViewer :content="tc.function?.arguments || '{}'" compact default-format="JSON" />
            </div>
          </div>
          <ContentViewer
            v-if="messageContent(m)"
            :content="messageContent(m)"
            compact
            :default-format="roleFormat(m.role)"
          />
        </div>
      </div>
    </div>

    <div v-if="tools.length" class="pv-sect">
      <div class="pv-sect-h">tools — {{ tools.length }}</div>
      <div v-for="(t, idx) in tools" :key="idx" class="pv-tool" :class="{ open: openedTools.has(idx) }">
        <div class="pv-tool-h" @click="toggleSet(openedTools, idx)">
          <span class="pv-tool-name">{{ toolInfo(t).name }}</span>
          <span class="pv-tool-desc">{{ toolInfo(t).description.split(' ').slice(0, 10).join(' ') }}…</span>
        </div>
        <div v-if="openedTools.has(idx)" class="pv-tool-b">
          {{ toolInfo(t).description }}
          <div>
            <button type="button" class="pv-mini" @click="toggleSet(openedParams, idx)">
              JSON инструмента (описание + схема параметров)
            </button>
          </div>
          <ContentViewer v-if="openedParams.has(idx)" :content="JSON.stringify(t)" compact default-format="JSON" />
        </div>
      </div>
    </div>

    <div v-if="!chips.length && !messages.length && !tools.length && !binaryMeta" class="pv-empty">
      <ContentViewer v-if="payload" :content="typeof payload === 'string' ? payload : JSON.stringify(payload)" />
      <span v-else>нет содержимого</span>
    </div>

    <Teleport to="body">
      <div v-if="bigContent !== null" class="pv-ovl" @click.self="bigContent = null">
        <div
          class="pv-dlg"
          :style="{ width: `${dlg.w}px`, height: `${dlg.h}px`, left: `${dlg.x}px`, top: `${dlg.y}px` }"
        >
          <div class="pv-dlg-h">
            <span class="pv-dlg-title">Содержимое сообщения</span>
            <button type="button" class="pv-dlg-x" title="Закрыть" @click="bigContent = null">✕</button>
          </div>
          <div class="pv-dlg-b">
            <ContentViewer :content="bigContent" />
          </div>
          <span
            v-for="dir in RESIZE_DIRS"
            :key="dir"
            class="pv-rs"
            :class="`pv-rs-${dir}`"
            @pointerdown="startResize($event, dir)"
          />
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.pv {
  font-size: 12px;
}
.pv-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 6px;
}
.pv-chip {
  background: rgba(0, 0, 0, 0.07);
  border-radius: 5px;
  padding: 1px 8px;
  font-size: 11px;
}
.pv-chip-bin {
  background: rgba(232, 163, 61, 0.18);
}
.pv-sect {
  margin-top: 8px;
}
.pv-sect-h {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #555;
  margin-bottom: 4px;
}
.pv-mini {
  border: none;
  background: none;
  color: #4567d8;
  font-size: 11px;
  padding: 0;
  text-decoration: underline;
  cursor: pointer;
}
.pv-msg,
.pv-tool {
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 6px;
  margin-bottom: 4px;
  background: #fff;
}
.pv-msg-h,
.pv-tool-h {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  cursor: pointer;
}
.pv-msg-h:hover,
.pv-tool-h:hover {
  background: #fafafa;
}
.pv-role {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  border-radius: 4px;
  padding: 1px 6px;
  text-transform: uppercase;
}
.role-system {
  background: #ece6ff;
  color: #5b46b5;
}
.role-user {
  background: #fff7c2;
  color: #8a6d00;
}
.role-assistant {
  background: #def0de;
  color: #2c6b2f;
}
.role-tool {
  background: #d9f2ec;
  color: #0e6e5c;
}
/* Кнопка «открыть в окне» у длинных сообщений — после бэджа роли. */
.pv-pop {
  flex: none;
  border: none;
  background: none;
  color: #4567d8;
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
  cursor: pointer;
}
.pv-pop:hover {
  color: #1d3fae;
}
.pv-tcall {
  font-size: 10px;
  background: #d2f5e8;
  border-radius: 4px;
  padding: 1px 6px;
  flex: none;
}
.pv-prev {
  color: #666;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.pv-len {
  color: #aaa;
  font-size: 10px;
  flex: none;
}
.pv-msg-b {
  border-top: 1px dashed rgba(0, 0, 0, 0.1);
  padding: 6px 8px;
}
/* Внутри раскрытого сообщения у просмотрщика содержимого убираются собственная рамка и белая
   подложка, а цветной фон по роли получает только сам блок текста (.cv-out). */
.pv-msg-b :deep(.cv) {
  border: none;
  background: transparent;
}
.pv-msg-b :deep(.cv-out) {
  padding: 4px 20px 4px 8px;
  border-radius: 4px;
}
.pv-msg.msg-system .pv-msg-b :deep(.cv-out) {
  background: #f3efff;
}
/* Раскрытый сырой текст сообщения — обычный текст, как в строке-превью, а не код-блок: моноширинный
   шрифт ContentViewer заменяется шрифтом интерфейса. JSON-просмотр (.cv-json) остаётся моноширинным. */
.pv-msg-b :deep(.cv-plain) {
  font:
    12px/1.4 system-ui,
    'Segoe UI',
    Roboto,
    sans-serif;
}
.pv-msg.msg-assistant .pv-msg-b :deep(.cv-out) {
  background: #edf7ed;
}
.pv-msg.msg-user .pv-msg-b :deep(.cv-out) {
  background: #fffad8;
}
.pv-tcalls {
  margin-bottom: 6px;
}
.pv-tool-name {
  font-weight: 600;
  color: #0e6e5c;
  flex: none;
}
.pv-tool-desc {
  color: #888;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.pv-tool-b {
  border-top: 1px dashed rgba(0, 0, 0, 0.1);
  padding: 6px 8px;
}
.pv-empty {
  color: #999;
}

/* Растягиваемое модальное окно просмотра содержимого. */
.pv-ovl {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 1100;
}
.pv-dlg {
  position: fixed;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}
.pv-dlg-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #e2e5e9;
  flex: none;
}
.pv-dlg-title {
  font-weight: 600;
  font-size: 14px;
}
.pv-dlg-x {
  border: none;
  background: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
}
.pv-dlg-x:hover {
  color: #333;
}
.pv-dlg-b {
  flex: 1;
  min-height: 0;
  padding: 10px 14px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
/* ContentViewer внутри окна занимает всю высоту, собственный лимит 480px снимается. */
.pv-dlg-b :deep(.cv) {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pv-dlg-b :deep(.cv-out) {
  max-height: none;
  flex: 1;
}

/* Невидимые ручки изменения размера: 4 стороны и 4 угла (углы поверх сторон). */
.pv-rs {
  position: absolute;
  z-index: 5;
}
.pv-rs-n,
.pv-rs-s {
  left: 10px;
  right: 10px;
  height: 7px;
  cursor: ns-resize;
}
.pv-rs-n {
  top: -3px;
}
.pv-rs-s {
  bottom: -3px;
}
.pv-rs-e,
.pv-rs-w {
  top: 10px;
  bottom: 10px;
  width: 7px;
  cursor: ew-resize;
}
.pv-rs-e {
  right: -3px;
}
.pv-rs-w {
  left: -3px;
}
.pv-rs-ne,
.pv-rs-nw,
.pv-rs-se,
.pv-rs-sw {
  width: 14px;
  height: 14px;
  z-index: 6;
}
.pv-rs-ne {
  top: -4px;
  right: -4px;
  cursor: nesw-resize;
}
.pv-rs-nw {
  top: -4px;
  left: -4px;
  cursor: nwse-resize;
}
.pv-rs-se {
  bottom: -4px;
  right: -4px;
  cursor: nwse-resize;
}
.pv-rs-sw {
  bottom: -4px;
  left: -4px;
  cursor: nesw-resize;
}
</style>
