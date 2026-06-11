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

// Последний выбранный пользователь переживает перезагрузку страницы: объект пользователя целиком лежит
// в localStorage, при старте восстанавливается, и ChatPane (watch по user-id) сам подгружает его историю.
const LAST_USER_KEY = 'memBot.llmLog.lastUser';

function restoreLastUser() {
  try {
    const raw = localStorage.getItem(LAST_USER_KEY);
    const user = raw ? JSON.parse(raw) : null;
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

const selectedUser = ref(restoreLastUser());
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
  try {
    localStorage.setItem(LAST_USER_KEY, JSON.stringify(user));
  } catch {
    // localStorage может быть недоступен (приватный режим) — выбор просто не сохранится.
  }
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

// Запись для AI-анализа по умолчанию (когда чекбоксами ничего не выбрано): последний главный запрос
// цикла (main_agent_answer), иначе — последняя строка запроса вообще.
const analyzeTarget = computed(() => {
  const rows = log.value?.rows || [];
  const requests = rows.filter((r) => r.rowType === 'llm_request' && r.llmRequestId);
  const main = requests.filter((r) => r.kind === 'main_agent_answer');
  const target = main.length ? main[main.length - 1] : requests[requests.length - 1];
  return target || null;
});

// Номера строк, отмеченных чекбоксами в журнале — именно их содержимое уйдёт в LLM при анализе.
const selectedNs = ref([]);

// Одна строка журнала → текстовый блок для промпта: заголовок с метаданными и тело целиком
// (payload сериализуется как JSON — описания и схемы инструментов попадают в LLM полностью).
function rowToText(row) {
  const head = [
    `строка №${row.n}`,
    row.title,
    row.model || null,
    row.tokens != null ? `${row.tokens} ткн` : null,
    row.status === 'error' && row.error ? `ошибка: ${row.error}` : null,
    row.createdAt,
  ]
    .filter(Boolean)
    .join(' · ');
  const b = row.body;
  let body = '';
  if (b?.kind === 'payload') {
    body = JSON.stringify(b.payload, null, 2);
  } else if (b?.kind === 'content') {
    body = b.content || '';
  } else if (b?.kind === 'text') {
    body = b.text || '';
  }
  return `### ${head}\n${body || '(нет содержимого)'}`;
}

// Контекст для AI-анализа: выбранные чекбоксами строки; если ничего не выбрано — запрос и ответ
// записи analyzeTarget (прежнее поведение «весь главный запрос цикла»).
const analyzeContext = computed(() => {
  const rows = log.value?.rows || [];
  const sel = new Set(selectedNs.value);
  let chosen = rows.filter((r) => !r.isGroupHeader && sel.has(r.n));
  if (!chosen.length && analyzeTarget.value) {
    const id = analyzeTarget.value.llmRequestId;
    chosen = rows.filter((r) => r.llmRequestId === id && (r.rowType === 'llm_request' || r.rowType === 'llm_response'));
  }
  return chosen.map(rowToText).join('\n\n');
});

const analyzeLabel = computed(() => {
  if (selectedNs.value.length) {
    return `выбрано строк журнала: ${selectedNs.value.length} (№ ${selectedNs.value.join(', ')})`;
  }
  const t = analyzeTarget.value;
  return t ? `строка №${t.n} «${t.title}» (запрос + ответ модели)` : '';
});

function openAnalyze() {
  if (analyzeTarget.value || selectedNs.value.length) {
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
        <LogPane
          :log="log"
          :loading="logLoading"
          :title="logTitle"
          @analyze="openAnalyze"
          @selection="selectedNs = $event"
        />
      </SplitterPanel>
    </Splitter>

    <AnalyzeDialog
      v-model:visible="analyzeVisible"
      :llm-request-id="analyzeTarget?.llmRequestId || null"
      :context-text="analyzeContext"
      :context-label="analyzeLabel"
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
