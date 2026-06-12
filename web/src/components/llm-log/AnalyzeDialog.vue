<script setup>
// Диалог интеллектуального анализа контекста LLM-запроса. Два движка: штатная LLM проекта (с выбором
// модели из разрешённого списка) и CLI-инструмент (пресеты из конфига; доступен только когда админка
// слушает на localhost — сервер сам отвечает 403 в противном случае). Результат стримится в блок ниже
// и рендерится как Markdown через ContentViewer.
// Текст запроса к LLM собирается здесь же: в поле ввода — редактируемый шаблон (инструкция + вопрос),
// плейсхолдер {selected-data} которого заменяется выбранным в журнале контекстом (contextText).
// Кнопка «Текст запроса в LLM» открывает редактор поверх диалога — там виден полный
// собранный текст, его можно править или заменить целиком; отредактированная версия уходит в LLM как есть.
import { ref, computed, watch, onMounted } from 'vue';
import Dialog from 'primevue/dialog';
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

onMounted(async () => {
  try {
    const cfg = await fetchLogAnalysisConfig();
    models.value = cfg.models || [];
    model.value = cfg.defaultModel || models.value[0] || null;
    presets.value = cfg.cliPresets || [];
    preset.value = presets.value[0]?.name || null;
    cliAvailable.value = cfg.cliAvailable === true && presets.value.length > 0;
  } catch (err) {
    error.value = err.message;
  }
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
      output.value = '';
      error.value = '';
      promptOverride.value = null;
    }
  },
);

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
  <Dialog
    :visible="visible"
    modal
    header="Интеллектуальный анализ контекста запроса"
    :style="{ width: 'min(960px, 92vw)', height: '85vh' }"
    :content-style="{ display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' }"
    @update:visible="emit('update:visible', $event)"
  >
    <div class="ad-row">
      <label class="ad-radio">
        <RadioButton v-model="engine" input-id="eng-llm" value="llm" />
        <span>Штатная LLM</span>
      </label>
      <Select v-model="model" :options="models" :disabled="engine !== 'llm'" size="small" class="ad-select" />
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
    <div v-if="!cliAvailable" class="ad-note">
      CLI-движок доступен только когда админка слушает на localhost и в конфиге заданы пресеты.
    </div>
    <div class="ad-ctx">Контекст: {{ contextLabel || `запись журнала №${llmRequestId}` }}.</div>
    <textarea v-model="question" class="ad-q" rows="10" />
    <div class="ad-actions">
      <Button :loading="running" :disabled="!finalPrompt.trim()" severity="warn" @click="run">Запустить анализ</Button>
      <Button text size="small" @click="openEditor">Текст запроса в LLM…</Button>
      <span v-if="promptOverride !== null" class="ad-edited">
        отправится отредактированный текст ({{ promptOverride.length.toLocaleString('ru-RU') }} симв.)
        <button type="button" class="ad-reset" @click="resetEditor">сбросить</button>
      </span>
    </div>
    <div v-if="error" class="ad-error">Ошибка: {{ error }}</div>
    <div v-if="output" class="ad-out">
      <ContentViewer :content="output" />
    </div>

    <!-- Редактор полного текста запроса к LLM: поверх диалога, одно большое поле. -->
    <Teleport to="body">
      <div v-if="editorVisible" class="ad-ovl" @click.self="editorVisible = false">
        <div class="ad-ed">
          <div class="ad-ed-h">
            <span class="ad-ed-title">Текст запроса в LLM — можно править перед отправкой</span>
            <button type="button" class="ad-ed-x" title="Закрыть" @click="editorVisible = false">✕</button>
          </div>
          <textarea v-model="promptDraft" class="ad-ed-t" spellcheck="false" />
          <div class="ad-ed-f">
            <Button size="small" severity="warn" :loading="running" @click="sendFromEditor">Отправить в LLM</Button>
            <Button size="small" @click="applyEditor">Применить</Button>
            <Button size="small" text @click="resetEditor">Сбросить к автотексту</Button>
            <span class="ad-ed-len">{{ promptDraft.length.toLocaleString('ru-RU') }} симв.</span>
          </div>
        </div>
      </div>
    </Teleport>
  </Dialog>
</template>

<style scoped>
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
.ad-q {
  width: 100%;
  border: 1px solid #d6d9de;
  border-radius: 6px;
  padding: 8px;
  font: inherit;
  margin-bottom: 10px;
  flex: none;
  resize: vertical;
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
.ad-out {
  margin-top: 12px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
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
