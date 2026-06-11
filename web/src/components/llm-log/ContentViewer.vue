<script setup>
// Просмотрщик произвольного содержимого из логов с переключателем формата JSON / MD / HTML / RAW.
// Стартовый формат определяется автоматически по содержимому, но плавающий селект в правом верхнем углу
// позволяет переключиться в любой момент (RAW доступен всегда). Содержимое логов недоверенное, поэтому
// режимы MD и HTML рендерятся только через DOMPurify.
import { ref, computed, watch } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const props = defineProps({
  content: { type: String, default: '' },
  // Компактный режим ограничивает высоту блока (используется внутри элементов messages).
  compact: { type: Boolean, default: false },
  // Формат отображения по умолчанию ('JSON' | 'MD' | 'HTML' | 'RAW'). Если задан — стартовый режим
  // равен ему БЕЗ автодетекции (и при смене content сбрасывается к нему же); null — автодетекция.
  // Источник — серверные словари типов (REQUEST_KIND_DISPLAY / EVENT_DISPLAY).
  defaultFormat: { type: String, default: null },
});

const FORMATS = ['JSON', 'MD', 'HTML', 'RAW'];

// Автоопределение формата: валидный JSON → JSON; закрывающиеся HTML-теги → HTML; маркеры разметки → MD.
// Простое упоминание тега (например, «используй <b>») не должно включать HTML-рендер — поэтому требуется
// закрывающий тег или <br>/<hr>.
function detectFormat(s) {
  const t = String(s || '').trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      JSON.parse(t);
      return 'JSON';
    } catch {
      /* не JSON — пробуем дальше */
    }
  }
  if (/<\/(p|div|ul|ol|li|b|i|a|table|span|h\d|strong|em|code|pre)>/i.test(t) || /<(br|hr)\s*\/?>/i.test(t)) {
    return 'HTML';
  }
  if (/(^|\n)#{1,4} |\*\*[^*]+\*\*|```|(^|\n)[-*] /m.test(t)) {
    return 'MD';
  }
  return 'RAW';
}

// Стартовый режим: заданный сервером формат типа без автодетекции, иначе автодетекция по содержимому.
function initialMode(content) {
  return FORMATS.includes(props.defaultFormat) ? props.defaultFormat : detectFormat(content);
}

const mode = ref(initialMode(props.content));
watch(
  () => props.content,
  (v) => {
    mode.value = initialMode(v);
  },
);

// Подсветка pretty-print JSON: экранируем текст и оборачиваем ключи/значения в классы.
function jsonHighlight(src) {
  let pretty;
  try {
    pretty = JSON.stringify(JSON.parse(src), null, 2);
  } catch {
    return null;
  }
  const esc = pretty.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return esc
    .replace(/("[^"\\]*(?:\\.[^"\\]*)*")(\s*:)/g, '<span class="cv-jk">$1</span>$2')
    .replace(/: ("[^"\\]*(?:\\.[^"\\]*)*")/g, ': <span class="cv-js">$1</span>')
    .replace(/: (-?\d+(?:\.\d+)?)/g, ': <span class="cv-jn">$1</span>')
    .replace(/: (true|false|null)/g, ': <span class="cv-jb">$1</span>');
}

const rendered = computed(() => {
  const src = String(props.content ?? '');
  switch (mode.value) {
    case 'JSON': {
      const html = jsonHighlight(src);
      return html != null ? { html: `<pre>${html}</pre>`, plain: false } : { text: src, plain: true };
    }
    case 'MD':
      return { html: DOMPurify.sanitize(marked.parse(src, { async: false })), plain: false };
    case 'HTML':
      return { html: DOMPurify.sanitize(src), plain: false };
    default:
      return { text: src, plain: true };
  }
});

const copied = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText(String(props.content ?? ''));
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1200);
  } catch {
    /* буфер обмена недоступен (http без localhost) — молча пропускаем */
  }
}
</script>

<template>
  <div class="cv" :class="{ compact }">
    <div class="cv-bar">
      <select v-model="mode" title="Формат отображения">
        <option v-for="f in FORMATS" :key="f" :value="f">{{ f }}</option>
      </select>
      <button type="button" :title="copied ? 'Скопировано' : 'Копировать'" @click="copy">
        {{ copied ? '✓' : '⧉' }}
      </button>
    </div>
    <pre v-if="rendered.plain" class="cv-out cv-plain">{{ rendered.text }}</pre>
    <!-- eslint-disable-next-line vue/no-v-html — содержимое прошло DOMPurify -->
    <div v-else class="cv-out" :class="mode === 'JSON' ? 'cv-json' : 'cv-rendered'" v-html="rendered.html" />
  </div>
</template>

<style scoped>
.cv {
  position: relative;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 6px;
  background: #fcfcfc;
}
.cv-bar {
  position: absolute;
  top: 4px;
  /* Отступ от правого края с запасом под вертикальный скроллбар (~17px) плюс 5px зазора. */
  right: 22px;
  display: flex;
  gap: 4px;
  z-index: 2;
}
.cv-bar select,
.cv-bar button {
  font-size: 11px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: #fff;
  color: #666;
  cursor: pointer;
}
.cv-out {
  padding: 8px 10px;
  max-height: 480px;
  overflow: auto;
  font:
    12px/1.5 Consolas,
    'Cascadia Mono',
    monospace;
}
.cv.compact .cv-out {
  max-height: 260px;
}
.cv-out :deep(pre),
.cv-plain {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.cv-rendered {
  font-family: system-ui, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
}
.cv-rendered :deep(h1),
.cv-rendered :deep(h2),
.cv-rendered :deep(h3) {
  margin: 6px 0 4px;
}
.cv-rendered :deep(ul) {
  margin: 4px 0;
  padding-left: 20px;
}
.cv-rendered :deep(code) {
  background: rgba(0, 0, 0, 0.06);
  border-radius: 3px;
  padding: 0 4px;
}
.cv-rendered :deep(p) {
  margin: 4px 0;
}
.cv-json :deep(.cv-jk) {
  color: #000080;
}
.cv-json :deep(.cv-js) {
  color: #1a7a1a;
}
.cv-json :deep(.cv-jn) {
  color: #0000ff;
}
.cv-json :deep(.cv-jb) {
  color: #007300;
}
</style>
