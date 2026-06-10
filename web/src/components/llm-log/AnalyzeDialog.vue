<script setup>
// Диалог интеллектуального анализа контекста LLM-запроса. Два движка: штатная LLM проекта (с выбором
// модели из разрешённого списка) и CLI-инструмент (пресеты из конфига; доступен только когда админка
// слушает на localhost — сервер сам отвечает 403 в противном случае). Результат стримится в блок ниже
// и рендерится как Markdown через ContentViewer.
import { ref, watch, onMounted } from 'vue';
import Dialog from 'primevue/dialog';
import Select from 'primevue/select';
import RadioButton from 'primevue/radiobutton';
import Button from 'primevue/button';
import ContentViewer from './ContentViewer.vue';
import { fetchLogAnalysisConfig, runLogAnalysis } from '../../api.js';

const props = defineProps({
  visible: { type: Boolean, default: false },
  // Журнальный id анализируемой записи (llm_request_id) и подпись для шапки контекста.
  llmRequestId: { type: [Number, String], default: null },
  contextLabel: { type: String, default: '' },
});
const emit = defineEmits(['update:visible']);

const DEFAULT_QUESTION =
  'Посмотри на запрос и ответ модели. Почему она ответила именно так? Что посоветуешь изменить в промпте или контексте?';

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

// При открытии диалога для новой записи сбрасываем прошлый результат, но сохраняем выбор движка и модели.
watch(
  () => props.llmRequestId,
  () => {
    output.value = '';
    error.value = '';
  },
);

async function run() {
  if (!props.llmRequestId || running.value) {
    return;
  }
  running.value = true;
  output.value = '';
  error.value = '';
  try {
    await runLogAnalysis(
      {
        llmRequestId: props.llmRequestId,
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
    :style="{ width: 'min(860px, 92vw)' }"
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
    <div class="ad-ctx">Контекст: {{ contextLabel || `запись журнала №${llmRequestId}` }} (запрос + ответ модели).</div>
    <textarea v-model="question" class="ad-q" rows="3" />
    <Button :loading="running" :disabled="!llmRequestId" severity="warn" @click="run">Запустить анализ</Button>
    <div v-if="error" class="ad-error">Ошибка: {{ error }}</div>
    <div v-if="output" class="ad-out">
      <ContentViewer :content="output" />
    </div>
  </Dialog>
</template>

<style scoped>
.ad-row {
  display: flex;
  gap: 14px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 10px;
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
}
.ad-ctx {
  font-size: 12px;
  color: #8a909a;
  margin-bottom: 8px;
}
.ad-q {
  width: 100%;
  border: 1px solid #d6d9de;
  border-radius: 6px;
  padding: 8px;
  font: inherit;
  margin-bottom: 10px;
}
.ad-error {
  margin-top: 10px;
  color: #b3261e;
  font-size: 13px;
}
.ad-out {
  margin-top: 12px;
}
</style>
