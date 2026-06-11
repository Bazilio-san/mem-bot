<script setup>
// Диалог создания/редактирования записи базы знаний. Окно собственное (не PrimeVue Dialog) по паттерну
// модального окна из llm-log/PayloadView.vue: телепорт в body, оверлей, восемь ручек изменения размера
// (4 стороны + 4 угла), размер сохраняется в localStorage и восстанавливается при следующем открытии,
// закрытие по ESC. Главный мотив ресайза — textarea содержимого, растягивающаяся вместе с диалогом.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import Select from 'primevue/select';
import InputChips from 'primevue/inputchips';
import InputNumber from 'primevue/inputnumber';
import Button from 'primevue/button';

const props = defineProps({
  // Запись для редактирования; объект без id означает создание новой записи.
  record: { type: Object, required: true },
  // Список доменов агента: [{ domainKey, title }] — опции выпадающего списка «Домен».
  domains: { type: Array, default: () => [] },
});
const emit = defineEmits(['save', 'close']);

const isNew = !props.record.id;

const form = ref({
  title: props.record.title || '',
  content: props.record.content || '',
  domainKey: props.record.domainKey || null,
  tags: [...(props.record.tags || [])],
  importance: props.record.importance ?? 0.5,
  source: props.record.source || '',
  status: props.record.status || 'active',
});

const domainOptions = computed(() => [
  { key: null, label: 'все домены' },
  ...props.domains.map((d) => ({ key: d.domainKey, label: `${d.domainKey} — ${d.title}` })),
]);

const STATUS_OPTIONS = ['active', 'archived', 'deleted'];

// Текст изменился по сравнению с исходной записью — после сохранения сервер пересчитает эмбеддинг.
const textChanged = computed(
  () => isNew || form.value.title !== (props.record.title || '') || form.value.content !== (props.record.content || ''),
);

const canSave = computed(() => form.value.content.trim().length > 0);

function save() {
  if (!canSave.value) {
    return;
  }
  emit('save', {
    id: props.record.id || null,
    title: form.value.title.trim() || null,
    content: form.value.content.trim(),
    domainKey: form.value.domainKey,
    tags: form.value.tags,
    importance: form.value.importance ?? 0.5,
    source: form.value.source.trim() || null,
    status: form.value.status,
  });
}

// --- Изменение размера окна (паттерн PayloadView) ---------------------------------------------
const DLG_SIZE_KEY = 'knowledge.dialog.size';
const RESIZE_DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
const MIN_W = 520;
const MIN_H = 360;
const dlg = ref({ w: 720, h: 560, x: 0, y: 0 });

function savedSize() {
  try {
    const s = JSON.parse(localStorage.getItem(DLG_SIZE_KEY) || 'null');
    return s && Number(s.w) >= MIN_W && Number(s.h) >= MIN_H ? { w: Number(s.w), h: Number(s.h) } : null;
  } catch {
    return null;
  }
}

function placeDialog() {
  const saved = savedSize();
  const w = Math.min(saved?.w ?? Math.min(720, window.innerWidth - 24), window.innerWidth - 24);
  const h = Math.min(saved?.h ?? Math.min(560, window.innerHeight - 24), window.innerHeight - 24);
  dlg.value = { w, h, x: Math.round((window.innerWidth - w) / 2), y: Math.round((window.innerHeight - h) / 2) };
}

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

function onKeydown(e) {
  if (e.key === 'Escape') {
    emit('close');
  }
}

onMounted(() => {
  placeDialog();
  window.addEventListener('keydown', onKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  onResizeEnd();
});
</script>

<template>
  <Teleport to="body">
    <div class="kd-ovl" @click.self="emit('close')">
      <div class="kd-dlg" :style="{ width: `${dlg.w}px`, height: `${dlg.h}px`, left: `${dlg.x}px`, top: `${dlg.y}px` }">
        <div class="kd-h">
          <span class="kd-title">{{ isNew ? 'Новая запись базы знаний' : 'Запись базы знаний' }}</span>
          <button type="button" class="kd-x" title="Закрыть" @click="emit('close')">✕</button>
        </div>

        <div class="kd-b">
          <label class="kd-field">
            <span class="kd-label">Заголовок</span>
            <InputText v-model="form.title" placeholder="Необязательный заголовок" fluid />
          </label>

          <label class="kd-field kd-grow">
            <span class="kd-label">Содержимое</span>
            <Textarea v-model="form.content" class="kd-content" placeholder="Текст записи (обязательное поле)" />
          </label>

          <div class="kd-row">
            <label class="kd-field">
              <span class="kd-label">Домен</span>
              <Select v-model="form.domainKey" :options="domainOptions" option-label="label" option-value="key" fluid />
            </label>
            <label class="kd-field">
              <span class="kd-label">Важность (0–1)</span>
              <InputNumber
                v-model="form.importance"
                :min="0"
                :max="1"
                :step="0.05"
                :max-fraction-digits="2"
                show-buttons
                fluid
              />
            </label>
            <label class="kd-field">
              <span class="kd-label">Статус</span>
              <Select v-model="form.status" :options="STATUS_OPTIONS" fluid />
            </label>
          </div>

          <div class="kd-row">
            <label class="kd-field kd-wide">
              <span class="kd-label">Теги (Enter добавляет тег)</span>
              <InputChips v-model="form.tags" separator="," fluid />
            </label>
            <label class="kd-field kd-wide">
              <span class="kd-label">Источник</span>
              <InputText v-model="form.source" placeholder="Документ, ссылка, автор" fluid />
            </label>
          </div>
        </div>

        <div class="kd-f">
          <span class="kd-emb" :class="textChanged ? 'kd-emb-pending' : 'kd-emb-ok'">
            {{
              textChanged
                ? 'Эмбеддинг будет пересчитан после сохранения.'
                : record.hasEmbedding
                  ? 'Эмбеддинг актуален.'
                  : 'Эмбеддинг отсутствует — будет рассчитан фоновой задачей или кнопкой пересчёта.'
            }}
          </span>
          <Button label="Отмена" severity="secondary" text @click="emit('close')" />
          <Button label="Сохранить" :disabled="!canSave" @click="save" />
        </div>

        <span
          v-for="dir in RESIZE_DIRS"
          :key="dir"
          class="kd-rs"
          :class="`kd-rs-${dir}`"
          @pointerdown="startResize($event, dir)"
        />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.kd-ovl {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 1100;
}
.kd-dlg {
  position: fixed;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}
.kd-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid #e2e5e9;
  flex: none;
}
.kd-title {
  font-weight: 600;
  font-size: 14px;
}
.kd-x {
  border: none;
  background: none;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  padding: 2px 6px;
}
.kd-x:hover {
  color: #333;
}
.kd-b {
  flex: 1;
  min-height: 0;
  padding: 12px 16px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.kd-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.kd-label {
  font-size: 12px;
  color: #666;
}
.kd-grow {
  flex: 1;
  min-height: 0;
}
.kd-content {
  flex: 1;
  min-height: 90px;
  resize: none;
  font-size: 13px;
}
.kd-row {
  display: flex;
  gap: 12px;
  flex: none;
}
.kd-row .kd-field {
  flex: 1;
}
.kd-wide {
  flex: 1;
}
.kd-f {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid #e2e5e9;
  flex: none;
}
.kd-emb {
  flex: 1;
  font-size: 12px;
}
.kd-emb-pending {
  color: #8a6d00;
}
.kd-emb-ok {
  color: #2c6b2f;
}

/* Невидимые ручки изменения размера: 4 стороны и 4 угла (углы поверх сторон). */
.kd-rs {
  position: absolute;
  z-index: 5;
}
.kd-rs-n,
.kd-rs-s {
  left: 10px;
  right: 10px;
  height: 7px;
  cursor: ns-resize;
}
.kd-rs-n {
  top: -3px;
}
.kd-rs-s {
  bottom: -3px;
}
.kd-rs-e,
.kd-rs-w {
  top: 10px;
  bottom: 10px;
  width: 7px;
  cursor: ew-resize;
}
.kd-rs-e {
  right: -3px;
}
.kd-rs-w {
  left: -3px;
}
.kd-rs-ne,
.kd-rs-nw,
.kd-rs-se,
.kd-rs-sw {
  width: 14px;
  height: 14px;
  z-index: 6;
}
.kd-rs-ne {
  top: -4px;
  right: -4px;
  cursor: nesw-resize;
}
.kd-rs-nw {
  top: -4px;
  left: -4px;
  cursor: nwse-resize;
}
.kd-rs-se {
  bottom: -4px;
  right: -4px;
  cursor: nwse-resize;
}
.kd-rs-sw {
  bottom: -4px;
  left: -4px;
  cursor: nesw-resize;
}
</style>
