<script setup>
// Диалог интеллектуального анализа контекста LLM-запроса. Два движка: штатная LLM проекта (с выбором
// модели из разрешённого списка) и CLI-инструмент (пресеты из конфига; доступен только когда админка
// слушает на localhost — сервер сам отвечает 403 в противном случае). Результат стримится в блок ниже
// и рендерится как Markdown через ContentViewer.
// Текст запроса к LLM собирается здесь же: в поле ввода — редактируемый шаблон (инструкция + вопрос),
// плейсхолдер {selected-data} которого заменяется выбранным в журнале контекстом (contextText).
// Кнопка «Текст запроса в LLM» открывает редактор поверх диалога — там виден полный
// собранный текст, его можно править или заменить целиком; отредактированная версия уходит в LLM как есть.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import Select from 'primevue/select';
import RadioButton from 'primevue/radiobutton';
import Button from 'primevue/button';
import ContentViewer from './ContentViewer.vue';
import { fetchLogAnalysisConfig, runLogAnalysis } from '../../api.js';

const props = defineProps({
  visible: { type: Boolean, default: false },
  // Журнальный id анализируемой записи — используется как резерв, когда контекст не передан.
  llmRequestId: { type: [Number, String], default: null },
  // Текст контекста, собранный из выбранных строк журнала, и человекочитаемая подпись к нему.
  contextText: { type: String, default: '' },
  contextLabel: { type: String, default: '' },
});
const emit = defineEmits(['update:visible']);

// Шаблон запроса целиком виден и редактируется в поле ввода. Плейсхолдер {selected-data} при отправке
// заменяется данными, выбранными в журнале (contextText).
const DEFAULT_QUESTION = `Ты — опытный инженер по промптам и отладке LLM-приложений. Ниже, в теге <selected-data> — выбранные администратором данные из журнала бота: запросы к LLM (payload целиком, включая системный промпт и полные определения
инструментов с описаниями и JSON-схемами параметров), ответы модели и события конвейера. Проанализируй их и ответь на вопрос администратора. Отвечай по-русски, по существу, с конкретными рекомендациями. Формат — Markdown.
<selected-data>
{selected-data}
</selected-data>

Посмотри на запрос и ответ модели. Почему она ответила именно так? Что посоветуешь изменить в промпте или контексте?`;

const engine = ref('llm');
const models = ref([]);
const model = ref(null);
const presets = ref([]);
const preset = ref(null);
const cliAvailable = ref(false);
const question = ref(DEFAULT_QUESTION);
const running = ref(false);
const output = ref('');
const error = ref('');

async function loadAnalysisConfig() {
  try {
    const cfg = await fetchLogAnalysisConfig();
    models.value = cfg.models || [];
    model.value = cfg.defaultModel || models.value[0] || null;
    presets.value = Array.isArray(cfg.cliPresets)
      ? cfg.cliPresets
          .map((p) => ({
            name: p?.name || null,
            title:
              typeof p?.title === 'string' && p.title.trim()
                ? p.title
                : typeof p?.name === 'string' && p.name.trim()
                  ? p.name
                  : 'Пресет CLI',
          }))
          .filter((p) => p.name)
      : [];
    if (!presets.value.some((item) => item?.name === preset.value)) {
      preset.value = presets.value[0]?.name || null;
    }
    cliAvailable.value = cfg.cliAvailable === true && presets.value.length > 0;
  } catch (err) {
    error.value = err.message;
  }
}

onMounted(async () => {
  await loadAnalysisConfig();
});

// Автоматически собранный текст запроса: шаблон из поля ввода, где {selected-data} заменяется выбранным
// контекстом журнала. Если администратор удалил плейсхолдер из шаблона, контекст не должен потеряться
// молча — тогда он добавляется в конец в том же теге <selected-data>.
const autoPrompt = computed(() => {
  const ctx = props.contextText || '(контекст не выбран)';
  if (question.value.includes('{selected-data}')) {
    return question.value.replaceAll('{selected-data}', ctx);
  }
  return `${question.value}\n\n<selected-data>\n${ctx}\n</selected-data>`;
});

// Отредактированная вручную версия текста запроса; null — используется autoPrompt.
const promptOverride = ref(null);
const finalPrompt = computed(() => promptOverride.value ?? autoPrompt.value);

// Редактор текста запроса (модал поверх диалога).
const editorVisible = ref(false);
const promptDraft = ref('');

function openEditor() {
  promptDraft.value = finalPrompt.value;
  editorVisible.value = true;
}

function applyEditor() {
  promptOverride.value = promptDraft.value;
  editorVisible.value = false;
}

function resetEditor() {
  promptOverride.value = null;
  promptDraft.value = autoPrompt.value;
}

async function sendFromEditor() {
  applyEditor();
  await run();
}

// При открытии диалога для нового контекста сбрасываем прошлый результат и ручную правку текста,
// но сохраняем выбор движка, модели и вопрос.
watch(
  () => [props.visible, props.contextText],
  ([visible]) => {
    if (visible) {
      loadAnalysisConfig();
      output.value = '';
      error.value = '';
      promptOverride.value = null;
    }
  },
);

// --- Горизонтальный сплиттер между промптом и результатом -------------------------------------------
// Область результата имеет фиксированную высоту (px), поле промпта забирает остальное (flex: 1).
// Перетаскивание сплиттера меняет высоту результата за счёт области промпта.
const outHeight = ref(280);
let splitDrag = null;

function onSplitMove(e) {
  if (!splitDrag) {
    return;
  }
  const dy = e.clientY - splitDrag.y;
  // Ограничения: результат не меньше 120px и не больше высоты окна минус место под промпт и контролы.
  const max = Math.max(160, window.innerHeight - 360);
  outHeight.value = Math.min(max, Math.max(120, splitDrag.h - dy));
}

function onSplitEnd() {
  splitDrag = null;
  window.removeEventListener('pointermove', onSplitMove);
  window.removeEventListener('pointerup', onSplitEnd);
}

function startSplit(e) {
  splitDrag = { y: e.clientY, h: outHeight.value };
  window.addEventListener('pointermove', onSplitMove);
  window.addEventListener('pointerup', onSplitEnd);
  e.preventDefault();
}

// --- Собственное растягиваемое окно диалога ----------------------------------------------------------
// PrimeVue Dialog не умеет менять размер за произвольную сторону, поэтому окно собственное — по образцу
// модального окна «Содержимое сообщения» в PayloadView: 8 ручек (4 стороны + 4 угла), размер хранится
// в localStorage и восстанавливается при следующем открытии.
const WIN_SIZE_KEY = 'llmLog.analyzeDialog.size';
const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const MIN_W = 480;
const MIN_H = 360;
const win = ref({ w: 960, h: 600, x: 0, y: 0 });

function savedWinSize() {
  try {
    const s = JSON.parse(localStorage.getItem(WIN_SIZE_KEY) || 'null');
    return s && Number(s.w) >= MIN_W && Number(s.h) >= MIN_H ? { w: Number(s.w), h: Number(s.h) } : null;
  } catch {
    return null;
  }
}

// При каждом открытии: восстановленный (или дефолтный) размер, ограниченный окном браузера, по центру.
function initWin() {
  const saved = savedWinSize();
  const w = Math.min(saved?.w ?? Math.min(960, window.innerWidth - 24), window.innerWidth - 24);
  const h = Math.min(saved?.h ?? Math.round(window.innerHeight * 0.85), window.innerHeight - 24);
  win.value = {
    w,
    h,
    x: Math.round((window.innerWidth - w) / 2),
    y: Math.round((window.innerHeight - h) / 2),
  };
}

let winDrag = null;
function onWinResizeMove(e) {
  if (!winDrag) {
    return;
  }
  const dx = e.clientX - winDrag.sx;
  const dy = e.clientY - winDrag.sy;
  const d = { ...win.value };
  if (winDrag.dir.includes('e')) {
    d.w = Math.max(MIN_W, winDrag.w + dx);
  }
  if (winDrag.dir.includes('s')) {
    d.h = Math.max(MIN_H, winDrag.h + dy);
  }
  if (winDrag.dir.includes('w')) {
    d.w = Math.max(MIN_W, winDrag.w - dx);
    d.x = winDrag.x + (winDrag.w - d.w);
  }
  if (winDrag.dir.includes('n')) {
    d.h = Math.max(MIN_H, winDrag.h - dy);
    d.y = winDrag.y + (winDrag.h - d.h);
  }
  win.value = d;
}

function onWinResizeEnd() {
  if (!winDrag) {
    return;
  }
  winDrag = null;
  window.removeEventListener('pointermove', onWinResizeMove);
  window.removeEventListener('pointerup', onWinResizeEnd);
  try {
    localStorage.setItem(WIN_SIZE_KEY, JSON.stringify({ w: win.value.w, h: win.value.h }));
  } catch {
    /* localStorage недоступен — размер просто не сохранится */
  }
}

function startWinResize(e, dir) {
  winDrag = { dir, sx: e.clientX, sy: e.clientY, ...win.value };
  window.addEventListener('pointermove', onWinResizeMove);
  window.addEventListener('pointerup', onWinResizeEnd);
  e.preventDefault();
}

function close() {
  emit('update:visible', false);
}

// Escape закрывает верхний слой: сначала редактор текста запроса, затем сам диалог.
function onKeydown(e) {
  if (e.key !== 'Escape') {
    return;
  }
  if (editorVisible.value) {
    editorVisible.value = false;
  } else {
    close();
  }
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      initWin();
      window.addEventListener('keydown', onKeydown);
    } else {
      window.removeEventListener('keydown', onKeydown);
    }
  },
);

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  onWinResizeEnd();
  onSplitEnd();
});

async function run() {
  if (!finalPrompt.value.trim() || running.value) {
    return;
  }
  running.value = true;
  output.value = '';
  error.value = '';
  try {
    await runLogAnalysis(
      {
        llmRequestId: props.llmRequestId,
        prompt: finalPrompt.value,
        question: question.value,
        engine: engine.value,
        model: engine.value === 'llm' ? model.value : undefined,
        preset: engine.value === 'cli' ? preset.value : undefined,
      },
      (_chunk, full) => {
        output.value = full;
      },
    );
  } catch (err) {
    error.value = err.message;
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <!-- Собственное модальное окно (вместо PrimeVue Dialog): растягивается за все 4 стороны и 4 угла.
       Клик по подложке намеренно НЕ закрывает окно: в нём долгий ввод и стримящийся результат,
       случайный клик мимо не должен их терять. Закрытие — крестик, кнопка «Закрыть» или Escape. -->
  <Teleport to="body">
    <div v-if="visible" class="ad-wovl">
      <div
        class="ad-w"
        :style="{
          width: `${win.w}px`,
          height: `${win.h}px`,
          left: `${win.x}px`,
          top: `${win.y}px`,
        }"
      >
        <div class="ad-w-h">
          <span class="ad-w-title">Интеллектуальный анализ контекста запроса</span>
          <button type="button" class="ad-w-x" title="Закрыть" @click="close">✕</button>
        </div>
        <div class="ad-w-b">
          <div class="ad-row">
            <label class="ad-radio">
              <RadioButton v-model="engine" input-id="eng-llm" value="llm" />
              <span>Штатная LLM</span>
            </label>
            <Select v-model="model" :options="models" :disabled="engine !== 'llm'" size="small" class="ad-select" />
            <div
              class="ad-cli-inline"
              :class="{ disabled: !cliAvailable }"
              :title="!cliAvailable ? 'CLI доступны только при локальной разработке' : undefined"
            >
              <label class="ad-radio" :class="{ disabled: !cliAvailable }">
                <RadioButton v-model="engine" input-id="eng-cli" value="cli" :disabled="!cliAvailable" />
                <span>CLI-инструмент</span>
              </label>
              <Select
                v-model="preset"
                :options="presets"
                option-label="title"
                option-value="name"
                :disabled="engine !== 'cli' || !cliAvailable"
                size="small"
                class="ad-select"
              />
            </div>
          </div>
          <div v-if="!cliAvailable" class="ad-note">
            CLI-движок доступен только когда админка слушает на localhost и в конфиге заданы пресеты.
          </div>
          <div class="ad-ctx">Контекст: {{ contextLabel || `запись журнала №${llmRequestId}` }}.</div>
          <textarea v-model="question" class="ad-q" />
          <div class="ad-actions">
            <Button :loading="running" :disabled="!finalPrompt.trim()" severity="warn" @click="run"
              >Запустить анализ</Button
            >
            <Button text size="small" @click="openEditor">Текст запроса в LLM…</Button>
            <span v-if="promptOverride !== null" class="ad-edited">
              отправится отредактированный текст ({{ promptOverride.length.toLocaleString('ru-RU') }}
              симв.)
              <button type="button" class="ad-reset" @click="resetEditor">сбросить</button>
            </span>
          </div>
          <div v-if="error" class="ad-error">Ошибка: {{ error }}</div>
          <template v-if="output">
            <div class="ad-split" title="Потянуть, чтобы изменить высоту результата" @pointerdown="startSplit" />
            <div class="ad-out" :style="{ height: `${outHeight}px` }">
              <ContentViewer :content="output" />
            </div>
          </template>
        </div>
        <div class="ad-w-f">
          <Button size="small" severity="secondary" @click="close">Закрыть</Button>
        </div>
        <span
          v-for="dir in RESIZE_DIRS"
          :key="dir"
          class="ad-rs"
          :class="`ad-rs-${dir}`"
          @pointerdown="startWinResize($event, dir)"
        />
      </div>
    </div>
  </Teleport>

  <!-- Редактор полного текста запроса к LLM: поверх диалога, одно большое поле. -->
  <Teleport to="body">
    <div v-if="editorVisible" class="ad-ovl">
      <div class="ad-ed">
        <div class="ad-ed-h">
          <span class="ad-ed-title">Текст запроса в LLM — можно править перед отправкой</span>
          <button type="button" class="ad-ed-x" title="Закрыть" @click="editorVisible = false">✕</button>
        </div>
        <textarea v-model="promptDraft" class="ad-ed-t" spellcheck="false" />
        <div class="ad-ed-f">
          <Button size="small" severity="warn" :loading="running" @click="sendFromEditor">Отправить в LLM</Button>
          <Button size="small" @click="applyEditor">Применить</Button>
          <Button size="small" severity="secondary" @click="editorVisible = false">Закрыть</Button>
          <Button size="small" text @click="resetEditor">Сбросить к автотексту</Button>
          <span class="ad-ed-len">{{ promptDraft.length.toLocaleString('ru-RU') }} симв.</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Собственное растягиваемое окно диалога (вместо PrimeVue Dialog). */
.ad-wovl {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 1100;
}
.ad-w {
  position: fixed;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}
.ad-w-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #e2e5e9;
  flex: none;
}
.ad-w-title {
  font-weight: 600;
  font-size: 15px;
}
.ad-w-x {
  border: none;
  background: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
}
.ad-w-x:hover {
  color: #333;
}
.ad-w-b {
  flex: 1;
  min-height: 0;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* Футер с кнопкой «Закрыть» — единственный способ закрытия мышью наряду с крестиком. */
.ad-w-f {
  display: flex;
  justify-content: flex-end;
  padding: 10px 16px;
  border-top: 1px solid #e2e5e9;
  flex: none;
}

/* Невидимые ручки изменения размера: 4 стороны и 4 угла (углы поверх сторон). */
.ad-rs {
  position: absolute;
  z-index: 5;
}
.ad-rs-n,
.ad-rs-s {
  left: 10px;
  right: 10px;
  height: 7px;
  cursor: ns-resize;
}
.ad-rs-n {
  top: -3px;
}
.ad-rs-s {
  bottom: -3px;
}
.ad-rs-e,
.ad-rs-w {
  top: 10px;
  bottom: 10px;
  width: 7px;
  cursor: ew-resize;
}
.ad-rs-e {
  right: -3px;
}
.ad-rs-w {
  left: -3px;
}
.ad-rs-ne,
.ad-rs-nw,
.ad-rs-se,
.ad-rs-sw {
  width: 14px;
  height: 14px;
  z-index: 6;
}
.ad-rs-ne {
  top: -4px;
  right: -4px;
  cursor: nesw-resize;
}
.ad-rs-nw {
  top: -4px;
  left: -4px;
  cursor: nwse-resize;
}
.ad-rs-se {
  bottom: -4px;
  right: -4px;
  cursor: nwse-resize;
}
.ad-rs-sw {
  bottom: -4px;
  left: -4px;
  cursor: nesw-resize;
}

.ad-row {
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 10px;
  flex: none;
}
.ad-radio {
  display: flex;
  gap: 6px;
  align-items: center;
  cursor: pointer;
}
.ad-cli-inline {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ad-cli-inline.disabled {
  opacity: 0.5;
}
.ad-radio.disabled {
  opacity: 0.5;
}
.ad-select {
  min-width: 200px;
}
.ad-note {
  font-size: 12px;
  color: #8a909a;
  margin-bottom: 8px;
  flex: none;
}
.ad-ctx {
  font-size: 12px;
  color: #8a909a;
  margin-bottom: 8px;
  flex: none;
}
/* Поле ввода занимает всю свободную высоту диалога (контент диалога — flex-колонка); ручной ресайз
   не нужен — размер меняется вместе с диалогом. Когда появляется блок результата, делит высоту с ним. */
.ad-q {
  width: 100%;
  border: 1px solid #d6d9de;
  border-radius: 6px;
  padding: 8px;
  font: inherit;
  margin-bottom: 10px;
  flex: 1 1 auto;
  min-height: 120px;
  resize: none;
}
.ad-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  flex: none;
}
.ad-edited {
  font-size: 12px;
  color: #8a6d00;
  background: #fff7c2;
  border-radius: 5px;
  padding: 2px 8px;
}
.ad-reset {
  border: none;
  background: none;
  color: #4567d8;
  font-size: 12px;
  padding: 0;
  margin-left: 6px;
  text-decoration: underline;
  cursor: pointer;
}
.ad-error {
  margin-top: 10px;
  color: #b3261e;
  font-size: 13px;
  flex: none;
}
/* Сплиттер между промптом и результатом: тонкая полоса с «ручкой», курсор вертикального ресайза. */
.ad-split {
  flex: none;
  height: 8px;
  margin-top: 8px;
  cursor: ns-resize;
  position: relative;
}
.ad-split::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 3px;
  height: 2px;
  border-radius: 1px;
  background: #d6d9de;
}
.ad-split:hover::before {
  background: #9aa3b0;
}
/* Высота области результата задаётся инлайн-стилем (outHeight) и меняется сплиттером;
   прокрутка идёт внутри ContentViewer, который растянут на всю высоту области. */
.ad-out {
  margin-top: 4px;
  flex: none;
  min-height: 0;
  overflow: hidden;
}
.ad-out :deep(.cv) {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.ad-out :deep(.cv-out) {
  max-height: none;
  flex: 1;
}

/* Редактор текста запроса: поверх PrimeVue-диалога (его маска ~1100), поэтому z-index выше. */
.ad-ovl {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ad-ed {
  width: min(1100px, 94vw);
  height: 88vh;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  display: flex;
  flex-direction: column;
}
.ad-ed-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #e2e5e9;
  flex: none;
}
.ad-ed-title {
  font-weight: 600;
  font-size: 14px;
}
.ad-ed-x {
  border: none;
  background: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
}
.ad-ed-x:hover {
  color: #333;
}
.ad-ed-t {
  flex: 1;
  min-height: 0;
  margin: 10px 16px;
  border: 1px solid #d6d9de;
  border-radius: 6px;
  padding: 10px;
  font:
    12px/1.5 Consolas,
    'Cascadia Mono',
    monospace;
  resize: none;
}
.ad-ed-f {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px 12px;
  flex: none;
}
.ad-ed-len {
  margin-left: auto;
  color: #8a909a;
  font-size: 12px;
}
</style>
