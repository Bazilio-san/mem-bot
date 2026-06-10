<script setup>
// Тело LLM-запроса с многослойным прогрессивным раскрытием. Три зоны:
// 1) чипы скалярных параметров (model, temperature, …) — всегда видны;
// 2) messages — по строке на сообщение (роль + превью), клик раскрывает: короткое содержимое инлайном,
//    крупное — в модальном окне на весь экран;
// 3) tools — по строке на инструмент (имя + первые слова описания), первый клик раскрывает описание,
//    отдельная кнопка показывает JSON Schema параметров.
import { ref, computed } from 'vue';
import Dialog from 'primevue/dialog';
import ContentViewer from './ContentViewer.vue';

const props = defineProps({
  payload: { type: [Object, Array, String], default: null },
  binaryMeta: { type: Object, default: null },
});

// Порог инлайн-раскрытия содержимого сообщения; больше — открываем модальное окно.
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
  const content = messageContent(messages.value[idx]);
  if (content.length > INLINE_LIMIT) {
    bigContent.value = content;
    return;
  }
  toggleSet(openedMessages, idx);
}

function setAllMessages(open) {
  openedMessages.value = open ? new Set(messages.value.map((_, i) => i)) : new Set();
}
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
      <div v-for="(m, idx) in messages" :key="idx" class="pv-msg" :class="{ open: openedMessages.has(idx) }">
        <div class="pv-msg-h" @click="clickMessage(idx)">
          <span class="pv-role" :class="`role-${m.role}`">{{ m.role }}</span>
          <span v-for="tn in toolCallTags(m)" :key="tn" class="pv-tcall">🛠 {{ tn }}</span>
          <span class="pv-prev">{{ preview(m) }}</span>
          <span class="pv-len">{{ messageContent(m).length.toLocaleString('ru-RU') }} симв.</span>
        </div>
        <div v-if="openedMessages.has(idx)" class="pv-msg-b">
          <div v-if="m.tool_calls?.length" class="pv-tcalls">
            <div v-for="(tc, i) in m.tool_calls" :key="i">
              <b>{{ tc.function?.name }}</b>
              <ContentViewer :content="tc.function?.arguments || '{}'" compact />
            </div>
          </div>
          <ContentViewer v-if="messageContent(m)" :content="messageContent(m)" compact />
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
            <button type="button" class="pv-mini" @click="toggleSet(openedParams, idx)">параметры (JSON Schema)</button>
          </div>
          <ContentViewer
            v-if="openedParams.has(idx) && toolInfo(t).parameters"
            :content="JSON.stringify(toolInfo(t).parameters)"
            compact
          />
        </div>
      </div>
    </div>

    <div v-if="!chips.length && !messages.length && !tools.length && !binaryMeta" class="pv-empty">
      <ContentViewer v-if="payload" :content="typeof payload === 'string' ? payload : JSON.stringify(payload)" />
      <span v-else>нет содержимого</span>
    </div>

    <Dialog
      :visible="bigContent !== null"
      modal
      header="Содержимое сообщения"
      :style="{ width: 'min(900px, 92vw)' }"
      @update:visible="bigContent = null"
    >
      <ContentViewer v-if="bigContent !== null" :content="bigContent" />
    </Dialog>
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
</style>
