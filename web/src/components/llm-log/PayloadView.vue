<script setup>
// Тело LLM-запроса с многослойным прогрессивным раскрытием. Три зоны:
// 1) чипы скалярных параметров (model, temperature, …) — всегда видны;
// 2) messages — по строке на сообщение (роль + превью), клик раскрывает содержимое инлайном; у длинных
//    сообщений после бэджа роли есть кнопка, открывающая то же содержимое в модальном окне на весь экран;
// 3) tools — по строке на инструмент (имя + первые слова описания), клик раскрывает полную информацию
//    об инструменте (описание + JSON Schema параметров); кнопка в строке открывает полный JSON
//    инструмента в модальном окне.
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import ContentViewer from './ContentViewer.vue';
import { renderJsonHtml } from './pretty-print-json.js';

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
  const list = Object.entries(p)
    .filter(([, v]) => v !== null && typeof v !== 'object')
    .map(([k, v]) => ({ key: k, value: String(v) }));
  // response_format — объект и в общий фильтр не попадает, но режим структурированного ответа важен:
  // показываем его тип отдельным чипом (json_object | json_schema).
  if (p.response_format?.type) {
    list.push({ key: 'response_format', value: p.response_format.type });
  }
  return list;
});

const messages = computed(() => (Array.isArray(payloadObj.value?.messages) ? payloadObj.value.messages : []));
const tools = computed(() => (Array.isArray(payloadObj.value?.tools) ? payloadObj.value.tools : []));

// Режим json_schema: схема ответа идёт отдельным блоком запроса (response_format.json_schema) —
// показываем её собственной секцией с раскрытием в pretty JSON.
const rfSchema = computed(() => {
  const rf = payloadObj.value?.response_format;
  if (rf?.type !== 'json_schema' || !rf.json_schema) {
    return null;
  }
  return {
    name: rf.json_schema.name || 'schema',
    strict: rf.json_schema.strict === true,
    json: JSON.stringify(rf.json_schema.schema ?? {}),
  };
});
const rfOpen = ref(false);

// Режим json_object: схема вписана текстом в системный промпт и ВСЕГДА обёрнута в тег <json-schema>
// (контракт chatJSON в src/llm.js). Тег даёт детерминированную границу фрагмента — никакого поиска по
// скобкам. Возвращает текст до тега, содержимое тега и текст после.
function embeddedJson(text) {
  const m = text.match(/<json-schema>\s*([\s\S]*?)\s*<\/json-schema>/);
  if (!m) {
    return null;
  }
  const start = text.indexOf(m[0]);
  return {
    before: text.slice(0, start).trimEnd(),
    raw: m[1],
    after: text.slice(start + m[0].length).trim(),
  };
}

function prettyJson(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

// Раскрашенная pretty-печать схемы (без слоя вложенного JSON: у этого блока нет обработчика
// переключателей, а схемы сериализованных строк не содержат). null — если raw не валидный JSON.
function prettyJsonHtml(raw) {
  return renderJsonHtml(raw, {}, { withEmbeds: false });
}

// Режим показа встроенного JSON по индексу сообщения: 'JSON' (pretty, по умолчанию) или 'RAW'.
const embedModes = ref({});
function embedMode(idx) {
  return embedModes.value[idx] || 'JSON';
}

// Формат отображения ТЕКСТА сообщения со схемой (по индексу сообщения) — тот же набор, что у селекта
// ContentViewer. По умолчанию RAW, как у обычного system/user-сообщения (roleFormat).
const TEXT_FORMATS = ['RAW', 'MD', 'HTML', 'JSON'];
const textModes = ref({});
function textMode(idx) {
  return textModes.value[idx] || 'RAW';
}

// Рендер текста промпта в выбранном формате. Фрагмент логики ContentViewer: содержимое логов
// недоверенное, поэтому MD и HTML проходят только через DOMPurify. Возвращает {html} либо {text}.
function renderText(text, mode) {
  if (mode === 'MD') {
    return { html: DOMPurify.sanitize(marked.parse(text, { async: false })) };
  }
  if (mode === 'HTML') {
    return { html: DOMPurify.sanitize(text) };
  }
  if (mode === 'JSON') {
    return { text: prettyJson(text) };
  }
  return { text };
}

// Сообщение-носитель схемы в режиме json_schema: схема приходит отдельным полем запроса, но показываем
// её внутри раскрытого system-сообщения (после текста промпта) — первого system в списке.
const schemaMsgIdx = computed(() => (rfSchema.value ? messages.value.findIndex((m) => m.role === 'system') : -1));

// Встроенный JSON ищем только в текстовых ролях (system/user): содержимое tool и так JSON целиком.
// Два источника: тег <json-schema> в тексте промпта (json_object) либо response_format.json_schema,
// прикреплённый к system-сообщению (json_schema). cap — подсказка для селекта формата.
function embedOf(m, idx) {
  if (roleFormat(m.role) !== 'RAW') {
    return null;
  }
  const fromText = embeddedJson(messageContent(m));
  if (fromText) {
    return { ...fromText, cap: 'Формат схемы' };
  }
  if (idx === schemaMsgIdx.value) {
    const { name, strict } = rfSchema.value;
    return {
      before: messageContent(m).trimEnd(),
      raw: rfSchema.value.json,
      after: '',
      cap: `${name} — ${strict ? 'strict: формат ответа гарантируется API' : 'strict выключен: схема рекомендательная'}`,
    };
  }
  return null;
}

// Имя и описание инструмента: поддерживаем оба формата — «плоский» и обёртку {type:'function', function:{…}}.
function toolInfo(t) {
  const fn = t?.function && typeof t.function === 'object' ? t.function : t;
  return { name: fn?.name || '?', description: fn?.description || '', parameters: fn?.parameters || null };
}

// JSON инструмента для просмотра: свойства идут в фиксированном порядке name → description → parameters
// (в payload порядок произвольный), остальные ключи — следом без изменений.
function toolJson(t) {
  const wrapped = t?.function && typeof t.function === 'object';
  const { name, description, parameters, ...rest } = (wrapped ? t.function : t) || {};
  const fn = {
    ...(name !== undefined && { name }),
    ...(description !== undefined && { description }),
    ...(parameters !== undefined && { parameters }),
    ...rest,
  };
  return JSON.stringify(wrapped ? { ...t, function: fn } : fn);
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

// Обёртка нужна именно в скрипте: в шаблоне ref автоматически разворачивается, и toggleSet получил бы
// сам Set вместо ref — присваивание .value прошло бы мимо реактивности (клик «не работал бы»).
function clickTool(idx) {
  toggleSet(openedTools, idx);
}

// Открыть содержимое сообщения в модальном окне (кнопка у длинных сообщений). Вместе с текстом
// передаётся embedOf: сообщение со схемой ответа и в окне показывается тем же блоком
// «текст + селект формата + JSON» (режим селекта общий с инлайн-видом — по индексу сообщения).
function openBig(idx) {
  const m = messages.value[idx];
  bigContent.value = { text: messageContent(m), embed: embedOf(m, idx), idx };
}

// Открыть полный JSON инструмента (описание + схема параметров) в том же модальном окне, что и
// сообщения. format: 'JSON' включает pretty-печать без автодетекции, title заменяет заголовок окна.
function openToolBig(idx) {
  const t = tools.value[idx];
  bigContent.value = {
    text: toolJson(t),
    format: 'JSON',
    title: `Схема инструмента: ${toolInfo(t).name}`,
  };
}

function isLong(m) {
  return messageContent(m).length > INLINE_LIMIT;
}

// Отступ первой строки раскрытого содержимого под абсолютно позиционированный бэдж роли
// (и кнопку «открыть в окне» у длинных сообщений). Ширина бэджа оценивается по длине имени роли:
// шрифт 10px полужирный в верхнем регистре — примерно 6.5px на символ плюс горизонтальные паддинги.
function indentFor(m) {
  const badge = Math.round(m.role.length * 6.5) + 12;
  // Кнопка «открыть в окне»: зазор 8px + иконка с паддингами и белой подложкой (~22px).
  const pop = isLong(m) ? 30 : 0;
  return `${badge + pop + 8}px`;
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
        <div v-if="!openedMessages.has(idx)" class="pv-msg-h" @click="clickMessage(idx)">
          <span class="pv-role" :class="`role-${m.role}`">{{ m.role }}</span>
          <button v-if="isLong(m)" type="button" class="pv-pop" title="Открыть в окне" @click.stop="openBig(idx)">
            ⤢
          </button>
          <span v-for="tn in toolCallTags(m)" :key="tn" class="pv-tcall">🛠 {{ tn }}</span>
          <span class="pv-prev">{{ preview(m) }}</span>
          <span class="pv-len">{{ messageContent(m).length.toLocaleString('ru-RU') }} симв.</span>
        </div>
        <!-- Раскрытое сообщение — единый блок с фоном роли, без повторения строки-превью. Бэдж и кнопка
             позиционированы абсолютно относительно блока, поэтому при прокрутке содержимого остаются на
             месте; первая строка текста начинается с отступа (CSS-переменная), чтобы бэдж поместился. -->
        <div v-else class="pv-msg-o" :style="{ '--pv-indent': indentFor(m) }">
          <span class="pv-float">
            <span class="pv-role" :class="`role-${m.role}`" title="Свернуть" @click="clickMessage(idx)">
              {{ m.role }}
            </span>
            <button v-if="isLong(m)" type="button" class="pv-pop" title="Открыть в окне" @click.stop="openBig(idx)">
              ⤢
            </button>
          </span>
          <div v-if="m.tool_calls?.length" class="pv-tcalls">
            <div v-for="(tc, i) in m.tool_calls" :key="i">
              <b>{{ tc.function?.name }}</b>
              <ContentViewer :content="tc.function?.arguments || '{}'" compact default-format="JSON" />
            </div>
          </div>
          <!-- Сообщение со схемой ответа (json_object — тег в тексте, json_schema — поле запроса):
               текст промпта, затем сама схема в том же контейнере. В правом верхнем углу блока — селект
               формата отображения текста (RAW/MD/HTML/JSON), позиционирован абсолютно, как .cv-bar у
               ContentViewer. Селект формата схемы (JSON — pretty-печать по умолчанию, RAW) стоит в потоке
               текста, прямо перед схемой: где начинался тег <json-schema> (json_object) либо в конце
               текста промпта (json_schema) — позиция сама объясняет назначение, подписи не нужны. -->
          <div v-if="messageContent(m) && embedOf(m, idx)" class="pv-embed">
            <div class="pv-embed-bar">
              <select
                class="pv-embed-select"
                :value="textMode(idx)"
                title="Формат отображения текста"
                @change="textModes[idx] = $event.target.value"
              >
                <option v-for="f in TEXT_FORMATS" :key="f" :value="f">{{ f }}</option>
              </select>
            </div>
            <div class="pv-embed-body">
              <pre v-if="!renderText(embedOf(m, idx).before, textMode(idx)).html" class="pv-embed-txt">{{
                renderText(embedOf(m, idx).before, textMode(idx)).text
              }}</pre>
              <!-- eslint-disable-next-line vue/no-v-html — содержимое прошло DOMPurify -->
              <div v-else class="pv-embed-rendered" v-html="renderText(embedOf(m, idx).before, textMode(idx)).html" />
              <div class="pv-embed-schema-bar">
                <select
                  class="pv-embed-select"
                  :value="embedMode(idx)"
                  :title="embedOf(m, idx).cap"
                  @change="embedModes[idx] = $event.target.value"
                >
                  <option value="JSON">JSON</option>
                  <option value="RAW">RAW</option>
                </select>
              </div>
              <!-- eslint-disable-next-line vue/no-v-html — HTML собран из экранированных фрагментов -->
              <pre
                v-if="embedMode(idx) === 'JSON' && prettyJsonHtml(embedOf(m, idx).raw)"
                class="pv-embed-json"
                v-html="prettyJsonHtml(embedOf(m, idx).raw)"
              />
              <pre v-else class="pv-embed-json">{{
                embedMode(idx) === 'JSON' ? prettyJson(embedOf(m, idx).raw) : embedOf(m, idx).raw
              }}</pre>
              <pre v-if="embedOf(m, idx).after" class="pv-embed-txt">{{ embedOf(m, idx).after }}</pre>
            </div>
          </div>
          <ContentViewer
            v-else-if="messageContent(m)"
            :content="messageContent(m)"
            compact
            :default-format="roleFormat(m.role)"
          />
        </div>
      </div>
    </div>

    <!-- json_schema: обычно схема показывается внутри system-сообщения (embedOf). Отдельная секция —
         только запасной путь, когда system-сообщения в запросе нет и встроить схему некуда. -->
    <div v-if="rfSchema && schemaMsgIdx === -1" class="pv-sect">
      <div class="pv-sect-h">response_format — JSON Schema</div>
      <div class="pv-tool" :class="{ open: rfOpen }">
        <div class="pv-tool-h" @click="rfOpen = !rfOpen">
          <span class="pv-tool-name">{{ rfSchema.name }}</span>
          <span class="pv-tool-desc">
            {{
              rfSchema.strict ? 'strict — формат ответа гарантируется API' : 'strict выключен — схема рекомендательная'
            }}
          </span>
        </div>
        <div v-if="rfOpen" class="pv-tool-b">
          <ContentViewer :content="rfSchema.json" compact default-format="JSON" />
        </div>
      </div>
    </div>

    <div v-if="tools.length" class="pv-sect">
      <div class="pv-sect-h">tools — {{ tools.length }}</div>
      <div v-for="(t, idx) in tools" :key="idx" class="pv-tool" :class="{ open: openedTools.has(idx) }">
        <div class="pv-tool-h" @click="clickTool(idx)">
          <span class="pv-tool-name">{{ toolInfo(t).name }}</span>
          <button type="button" class="pv-pop" title="Схема инструмента в окне" @click.stop="openToolBig(idx)">
            ⤢
          </button>
          <span class="pv-tool-desc">{{ toolInfo(t).description.split(' ').slice(0, 10).join(' ') }}…</span>
        </div>
        <div v-if="openedTools.has(idx)" class="pv-tool-b">
          <div class="pv-tool-full">{{ toolInfo(t).description }}</div>
          <ContentViewer :content="toolJson(t)" compact default-format="JSON" />
        </div>
      </div>
    </div>

    <div v-if="!chips.length && !messages.length && !tools.length && !binaryMeta" class="pv-empty">
      <ContentViewer v-if="payload" :content="typeof payload === 'string' ? payload : JSON.stringify(payload)" />
      <span v-else>нет содержимого</span>
    </div>

    <Teleport to="body">
      <div v-if="bigContent !== null" class="pv-ovl">
        <div
          class="pv-dlg"
          :style="{ width: `${dlg.w}px`, height: `${dlg.h}px`, left: `${dlg.x}px`, top: `${dlg.y}px` }"
        >
          <div class="pv-dlg-h">
            <span class="pv-dlg-title">{{ bigContent.title || 'Содержимое сообщения' }}</span>
            <button type="button" class="pv-dlg-x" title="Закрыть" @click="bigContent = null">✕</button>
          </div>
          <div class="pv-dlg-b">
            <!-- Сообщение со схемой ответа: в окне тот же блок, что и в инлайн-виде, — селект формата
                 текста в правом верхнем углу, селект формата схемы в потоке текста перед самой схемой.
                 Режимы селектов общие с инлайн-видом — по индексу сообщения. -->
            <div v-if="bigContent.embed" class="pv-embed pv-embed-dlg">
              <div class="pv-embed-bar">
                <select
                  class="pv-embed-select"
                  :value="textMode(bigContent.idx)"
                  title="Формат отображения текста"
                  @change="textModes[bigContent.idx] = $event.target.value"
                >
                  <option v-for="f in TEXT_FORMATS" :key="f" :value="f">{{ f }}</option>
                </select>
              </div>
              <div class="pv-embed-body">
                <pre v-if="!renderText(bigContent.embed.before, textMode(bigContent.idx)).html" class="pv-embed-txt">{{
                  renderText(bigContent.embed.before, textMode(bigContent.idx)).text
                }}</pre>
                <!-- eslint-disable-next-line vue/no-v-html — содержимое прошло DOMPurify -->
                <div
                  v-else
                  class="pv-embed-rendered"
                  v-html="renderText(bigContent.embed.before, textMode(bigContent.idx)).html"
                />
                <div class="pv-embed-schema-bar">
                  <select
                    class="pv-embed-select"
                    :value="embedMode(bigContent.idx)"
                    :title="bigContent.embed.cap"
                    @change="embedModes[bigContent.idx] = $event.target.value"
                  >
                    <option value="JSON">JSON</option>
                    <option value="RAW">RAW</option>
                  </select>
                </div>
                <!-- eslint-disable-next-line vue/no-v-html — HTML собран из экранированных фрагментов -->
                <pre
                  v-if="embedMode(bigContent.idx) === 'JSON' && prettyJsonHtml(bigContent.embed.raw)"
                  class="pv-embed-json"
                  v-html="prettyJsonHtml(bigContent.embed.raw)"
                />
                <pre v-else class="pv-embed-json">{{
                  embedMode(bigContent.idx) === 'JSON' ? prettyJson(bigContent.embed.raw) : bigContent.embed.raw
                }}</pre>
                <pre v-if="bigContent.embed.after" class="pv-embed-txt">{{ bigContent.embed.after }}</pre>
              </div>
            </div>
            <ContentViewer v-else :content="bigContent.text" :default-format="bigContent.format || null" />
            <div class="pv-dlg-f">
              <button type="button" class="pv-mini" @click="bigContent = null">Закрыть</button>
            </div>
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
/* Раскрытое сообщение — один блок: единый фон роли на всём диве, без строки-превью. */
.pv-msg-o {
  position: relative;
  border-radius: 6px;
}
/* Бэдж роли и кнопка диалога позиционированы абсолютно относительно блока (прокрутка идёт внутри
   .cv-out, поэтому при скроллинге они остаются на месте). Клик по бэджу сворачивает сообщение. */
.pv-float {
  position: absolute;
  top: 4px;
  left: 8px;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 6px; /* тот же зазор, что и в свёрнутой строке, — иконка не «прилипает» к бэджу */
}
.pv-float .pv-role {
  cursor: pointer;
}
/* На цветном фоне раскрытого блока кнопка получает белую подложку, как в свёрнутой строке. */
.pv-float .pv-pop {
  background: #fff;
  border-radius: 4px;
  padding: 1px 4px;
}
/* У просмотрщика содержимого убираются собственная рамка и белая подложка — фон задаёт .pv-msg-o. */
.pv-msg-o :deep(.cv) {
  border: none;
  background: transparent;
}
/* Первая строка начинается с отступа под бэдж (ширина посчитана в indentFor, передана переменной). */
.pv-msg-o :deep(.cv-out) {
  padding: 4px 20px 4px 8px;
  border-radius: 6px;
  text-indent: var(--pv-indent, 0);
}
/* Раскрытый сырой текст сообщения — обычный текст, как в строке-превью, а не код-блок: моноширинный
   шрифт ContentViewer заменяется шрифтом интерфейса. JSON-просмотр (.cv-json) остаётся моноширинным. */
.pv-msg-o :deep(.cv-plain) {
  font:
    12px/1.4 system-ui,
    'Segoe UI',
    Roboto,
    sans-serif;
}
.pv-msg.msg-system .pv-msg-o {
  background: #f3efff;
}
.pv-msg.msg-assistant .pv-msg-o {
  background: #edf7ed;
}
.pv-msg.msg-user .pv-msg-o {
  background: #fffad8;
}
.pv-tcalls {
  margin-bottom: 6px;
}
/* Блок «текст промпта + встроенная JSON Schema» (json_object и json_schema): текст — шрифтом
   интерфейса, как обычное раскрытое сообщение; сам JSON — моноширинный на лёгкой подложке.
   Сам блок не прокручивается (он лишь относительный контейнер для панели селектов); прокрутка
   идёт во вложенном .pv-embed-body, поэтому панель при скроллинге остаётся на месте. */
.pv-embed {
  position: relative;
}
.pv-embed pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.pv-embed-body {
  padding: 4px 24px 4px 8px;
  max-height: 260px;
  overflow: auto;
}
/* Селект формата текста в правом верхнем углу блока — позиция и отступы как у .cv-bar в ContentViewer
   (запас справа под вертикальный скроллбар тела). */
.pv-embed-bar {
  position: absolute;
  top: 4px;
  right: 22px;
  display: flex;
  align-items: center;
  gap: 4px;
  z-index: 3;
}
/* Селект формата схемы — в потоке текста, прямо перед блоком схемы: его позиция показывает, к чему
   он относится, поэтому подпись не нужна. */
.pv-embed-schema-bar {
  margin: 6px 0 2px;
}
.pv-embed-txt {
  font:
    12px/1.4 system-ui,
    'Segoe UI',
    Roboto,
    sans-serif;
}
.pv-embed-txt:first-child {
  text-indent: var(--pv-indent, 0);
}
/* Текст промпта, отрендеренный как MD/HTML, — оформление как .cv-rendered у ContentViewer.
   Отступ под бэдж роли получает только первая строка первого блока. */
.pv-embed-rendered {
  font-family: system-ui, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
}
.pv-embed-rendered > :first-child {
  text-indent: var(--pv-indent, 0);
}
.pv-embed-rendered :deep(h1),
.pv-embed-rendered :deep(h2),
.pv-embed-rendered :deep(h3) {
  margin: 6px 0 4px;
}
.pv-embed-rendered :deep(ul) {
  margin: 4px 0;
  padding-left: 20px;
}
.pv-embed-rendered :deep(code) {
  background: rgba(0, 0, 0, 0.06);
  border-radius: 3px;
  padding: 0 4px;
}
.pv-embed-rendered :deep(p) {
  margin: 4px 0;
}
/* Тот же блок в модальном окне: тело занимает всю высоту диалога (лимит 260px снят), рамка и
   подложка — как у ContentViewer, чтобы не отличаться от обычного просмотра сообщений. */
.pv-embed-dlg {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 6px;
  background: #fcfcfc;
}
.pv-embed-dlg .pv-embed-body {
  flex: 1;
  min-height: 0;
  max-height: none;
  padding: 8px 10px;
}
/* Оформление селекта — точно как у селекта формата в ContentViewer (.cv-bar select). */
.pv-embed-select {
  font-size: 11px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: #fff;
  color: #666;
  cursor: pointer;
}
.pv-embed-json {
  font:
    12px/1.5 Consolas,
    'Cascadia Mono',
    monospace;
  background: rgba(0, 0, 0, 0.04);
  border-radius: 4px;
  padding: 6px 8px;
  margin-bottom: 4px;
}
/* Блок вызовов инструментов в раскрытом сообщении тоже сдвигается правее бэджа. */
.pv-msg-o .pv-tcalls {
  margin: 4px 8px 6px;
  padding-left: var(--pv-indent, 8px);
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
/* Полное описание инструмента над JSON-схемой в раскрытом блоке. */
.pv-tool-full {
  margin-bottom: 6px;
  white-space: pre-wrap;
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
.pv-dlg-f {
  margin-top: 10px;
  flex: none;
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
