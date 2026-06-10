<script setup>
// Страница «Логи LLM»: поиск пользователя сверху, лента чата слева, журнал выбранного цикла справа
// (панели разделены перетаскиваемым Splitter). Здесь живёт состояние выбора: пользователь, загруженный
// журнал и запись для AI-анализа.
import { ref, computed } from 'vue';
import Splitter from 'primevue/splitter';
import SplitterPanel from 'primevue/splitterpanel';
import UserSearch from './UserSearch.vue';
import ChatPane from './ChatPane.vue';
import LogPane from './LogPane.vue';
import AnalyzeDialog from './AnalyzeDialog.vue';
import { fetchCycle, fetchSingleRequest } from '../../api.js';

const selectedUser = ref(null);
const log = ref(null);
const logTitle = ref('');
const logLoading = ref(false);
const error = ref('');
const analyzeVisible = ref(false);

function pickUser(user) {
  selectedUser.value = user;
  log.value = null;
  logTitle.value = '';
  error.value = '';
}

async function selectLog({ requestId, llmRequestId, item }) {
  logLoading.value = true;
  error.value = '';
  try {
    log.value = requestId ? await fetchCycle(requestId) : await fetchSingleRequest(llmRequestId);
    logTitle.value = item?.type === 'service' ? `Сервисный запрос · ${item.title}` : 'Цикл';
  } catch (err) {
    error.value = err.message;
    log.value = null;
  } finally {
    logLoading.value = false;
  }
}

// Запись для AI-анализа: последний главный запрос цикла (main_agent_answer), иначе — последняя строка
// запроса вообще. Именно её payload и response уходят анализатору.
const analyzeTarget = computed(() => {
  const rows = log.value?.rows || [];
  const requests = rows.filter((r) => r.rowType === 'llm_request' && r.llmRequestId);
  const main = requests.filter((r) => r.kind === 'main_agent_answer');
  const target = main.length ? main[main.length - 1] : requests[requests.length - 1];
  return target || null;
});

function openAnalyze() {
  if (analyzeTarget.value) {
    analyzeVisible.value = true;
  }
}
</script>

<template>
  <div class="llp">
    <div class="llp-top">
      <div class="llp-search">
        <UserSearch @select="pickUser" @error="error = $event" />
      </div>
      <div v-if="selectedUser" class="llp-user">
        Пользователь: <b>{{ selectedUser.displayName || '(без имени)' }}</b>
        <span class="llp-ext">tg {{ selectedUser.externalId }} · {{ selectedUser.id }}</span>
      </div>
      <div v-if="error" class="llp-error">{{ error }}</div>
    </div>

    <Splitter class="llp-body" :gutter-size="6">
      <SplitterPanel :size="32" :min-size="20">
        <ChatPane :user-id="selectedUser?.id || null" @select-log="selectLog" @error="error = $event" />
      </SplitterPanel>
      <SplitterPanel :size="68" :min-size="30">
        <LogPane :log="log" :loading="logLoading" :title="logTitle" @analyze="openAnalyze" />
      </SplitterPanel>
    </Splitter>

    <AnalyzeDialog
      v-model:visible="analyzeVisible"
      :llm-request-id="analyzeTarget?.llmRequestId || null"
      :context-label="analyzeTarget ? `строка №${analyzeTarget.n} «${analyzeTarget.title}»` : ''"
    />
  </div>
</template>

<style scoped>
.llp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}
.llp-top {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 8px 14px;
  background: #fff;
  border-bottom: 1px solid #e2e5e9;
  flex: none;
}
.llp-search {
  flex: 0 0 380px;
}
.llp-user {
  color: #555;
  font-size: 13px;
}
.llp-ext {
  color: #8a909a;
  margin-left: 8px;
  font-size: 12px;
}
.llp-error {
  color: #b3261e;
  font-size: 13px;
  margin-left: auto;
}
.llp-body {
  flex: 1;
  min-height: 0;
  border: none;
  border-radius: 0;
}
.llp-body :deep(.p-splitterpanel) {
  min-height: 0;
  overflow: hidden;
}
</style>
