<script setup>
// Одна строка журнала цикла: пастельный цвет по виду строки, иконка с отступом-иерархией, заголовок,
// токены/цена/модель/длительность серым, время справа и стрелка раскрытия. Раскрытая часть рендерит тело
// строки: payload запроса (PayloadView), содержимое ответа/инструмента (ContentViewer) или простой текст.
import { computed } from 'vue';
import PayloadView from './PayloadView.vue';
import ContentViewer from './ContentViewer.vue';

const props = defineProps({
  row: { type: Object, required: true },
  expanded: { type: Boolean, default: false },
});
const emit = defineEmits(['toggle']);

// Палитра из референсной реализации multi-bot: неяркие пастельные фоны, к которым привыкает глаз.
const KIND_COLORS = {
  user_say: '#ffffdc',
  intent_classify: '#fff5e3',
  stage: '#d6cffd',
  agent_start: '#e9e4fe',
  agent_end: '#c6d2fd',
  agent_error: '#faabda',
  llm_response: '#e8f5e8',
  tool_call: '#d2f5e8',
  tool_result: '#eafbda',
  embedding: '#f5edff',
  fact_extract: '#ffe7e3',
  topic_extract: '#ffe7e3',
  history_compress: '#ffebd9',
  proactive_message: '#c5ebf1',
  event_relevance: '#c5ebf1',
  delivery_intent: '#fff5e3',
  stt: '#f0e6af',
  tts: '#f0e6af',
  voice_summary: '#f0e6af',
  answer_user: '#ebffe8',
  mcp: '#dfe2e6',
  main_agent_answer: '#e3f2fd',
  skill_authoring: '#e3f2fd',
  log_analysis: '#e3f2fd',
};

const ICONS = {
  user_say: '👤',
  stage: '▷',
  agent_start: '▷',
  agent_end: '◻',
  agent_error: '⚠',
  llm_request: '→',
  llm_response: '←',
  tool_call: '🛠',
  tool_result: '✅',
  embedding: '↔',
  answer_user: '💬',
  mcp: '⛓',
  event: '•',
};

const color = computed(() => {
  if (props.row.status === 'error') {
    return '#faabda';
  }
  // Для строк запроса цвет определяется видом запроса (main_agent_answer — голубой и т. д.).
  return KIND_COLORS[props.row.kind] || (props.row.rowType === 'llm_request' ? '#e3f2fd' : '#e5e5e5');
});

const icon = computed(() => ICONS[props.row.rowType] || ICONS[props.row.kind] || '•');

const meta = computed(() => {
  const r = props.row;
  const parts = [];
  if (r.tokens != null) {
    parts.push(`${Number(r.tokens).toLocaleString('ru-RU')} ткн`);
  }
  if (r.priceUsd != null && Number(r.priceUsd) > 0) {
    parts.push(`$${Number(r.priceUsd).toFixed(4)}`);
  }
  if (r.model) {
    parts.push(r.model);
  }
  return parts.join(' · ');
});

const time = computed(() => {
  const d = new Date(props.row.createdAt);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('ru-RU');
});

// Длительность в секундах с двумя знаками — выводится рядом со временем начала строки.
const durSec = computed(() => (props.row.durationMs != null ? (Number(props.row.durationMs) / 1000).toFixed(2) : null));

const hasBody = computed(() => props.row.body != null);
</script>

<template>
  <div class="lr" :style="{ background: color }" :class="{ stage: row.isGroupHeader }">
    <div class="lr-h" @click="emit('toggle')">
      <span class="lr-chev">{{
        row.isGroupHeader ? (expanded ? '▾' : '▸') : hasBody ? (expanded ? '▾' : '▸') : ''
      }}</span>
      <span class="lr-n">{{ row.n }}</span>
      <span class="lr-ic" :style="{ marginLeft: `${(row.indent || 0) * 22}px` }">{{ icon }}</span>
      <span class="lr-cap">{{ row.title }}</span>
      <span v-if="meta" class="lr-meta">{{ meta }}</span>
      <span v-if="row.error" class="lr-err" :title="row.error">⚠ {{ row.error }}</span>
      <span class="lr-when"
        ><template v-if="durSec">{{ durSec }} с · </template>{{ time }}</span
      >
    </div>
    <div v-if="expanded && hasBody && !row.isGroupHeader" class="lr-b">
      <div v-if="row.payloadTruncated || row.responseTruncated" class="lr-trunc">
        Содержимое было обрезано при записи в журнал (лимит maxPayloadChars).
      </div>
      <PayloadView v-if="row.body.kind === 'payload'" :payload="row.body.payload" :binary-meta="row.body.binaryMeta" />
      <ContentViewer v-else-if="row.body.kind === 'content'" :content="row.body.content || ''" />
      <div v-else-if="row.body.kind === 'text'" class="lr-text">{{ row.body.text }}</div>
    </div>
  </div>
</template>

<style scoped>
.lr {
  border-bottom: 1px solid rgba(0, 0, 0, 0.05);
}
.lr-h {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 10px;
  cursor: pointer;
  user-select: none;
}
.lr-h:hover {
  filter: brightness(0.97);
}
.lr-n {
  width: 24px;
  text-align: right;
  color: #999;
  font-size: 11px;
  flex: none;
}
.lr-ic {
  flex: none;
  width: 18px;
  text-align: center;
}
.lr-cap {
  font-weight: 500;
  white-space: nowrap;
}
.lr.stage .lr-cap {
  font-weight: 600;
}
.lr-meta {
  color: #8d939c;
  font-size: 11px;
  margin-left: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lr-err {
  color: #b3261e;
  font-size: 11px;
  margin-left: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 320px;
}
.lr-when {
  margin-left: auto;
  color: #8d939c;
  font-size: 11px;
  white-space: nowrap;
}
.lr-chev {
  color: #6b7280;
  width: 20px;
  font-size: 16px;
  line-height: 1;
  flex: none;
  text-align: center;
}
.lr-b {
  padding: 8px 12px 10px 44px;
  background: rgba(255, 255, 255, 0.45);
}
.lr-text {
  font:
    12px/1.5 Consolas,
    'Cascadia Mono',
    monospace;
  white-space: pre-wrap;
  word-break: break-word;
}
.lr-trunc {
  font-size: 11px;
  color: #b3261e;
  background: #fff3f2;
  border: 1px solid #f3c1bd;
  border-radius: 5px;
  padding: 2px 8px;
  display: inline-block;
  margin-bottom: 6px;
}
</style>
