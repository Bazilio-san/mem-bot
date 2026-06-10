<script setup>
// Корневой компонент админки. Раскладка «список пользователей слева — память выбранного пользователя справа».
// Таблицы памяти построены на компоненте DataTable из библиотеки PrimeVue (тема Aura): сортировка, фильтрация
// по столбцам и пагинация берутся из коробки, поэтому здесь остаётся только подготовка данных и описание колонок.
import { ref, onMounted, onBeforeUnmount } from 'vue';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import MultiSelect from 'primevue/multiselect';
import Button from 'primevue/button';
import { FilterMatchMode } from '@primevue/core/api';
import { fetchUsers, fetchUserMemory, deleteMemoryItem, fetchAuthMe, logoutAdmin } from './api.js';
import LlmLogPage from './components/llm-log/LlmLogPage.vue';
import LoginScreen from './components/auth/LoginScreen.vue';

// Гейт авторизации: пока статус не получен — пустой экран, без сессии — экран входа через Telegram.
// authState: 'loading' | 'login' | 'ready'.
const authState = ref('loading');
const authInfo = ref({ authRequired: false, displayName: null, botUsername: null });

async function checkAuth() {
  try {
    const me = await fetchAuthMe();
    authInfo.value = me;
    authState.value = me.authenticated ? 'ready' : 'login';
    if (me.authenticated) {
      loadUsers();
    }
  } catch (err) {
    error.value = err.message;
    authState.value = 'login';
  }
}

async function onLoggedIn() {
  await checkAuth();
}

async function logout() {
  try {
    await logoutAdmin();
  } finally {
    authState.value = 'login';
  }
}

// Любой запрос, вернувший 401 (сессия истекла), переключает приложение на экран входа.
const onAuthRequired = () => {
  authState.value = 'login';
};

// Активный раздел админки: «Память» (исходная страница) или «Логи LLM» (просмотрщик журналов).
const activeTab = ref('memory');
const TABS = [
  { key: 'memory', title: 'Память' },
  { key: 'llm-log', title: 'Логи LLM' },
];

const users = ref([]);
const selectedUser = ref(null);
const memory = ref(null);
const loadingUsers = ref(false);
const loadingMemory = ref(false);
const error = ref('');

// Состояние фильтров по столбцам для каждой группы памяти отдельно: { [ключ группы]: { поле: { value, matchMode } } }.
// DataTable связывается с этим объектом через v-model:filters и сам пересчитывает видимые строки при выборе значений.
const filters = ref({});

// Заголовки и порядок отображения категорий памяти. Ключи совпадают с полями ответа админ-API.
const MEMORY_GROUPS = [
  { key: 'profile', title: 'Профиль (устойчивые факты о пользователе)' },
  { key: 'domain', title: 'Память предметной области' },
  { key: 'dialog', title: 'Факты текущего диалога' },
  { key: 'reminder', title: 'Активные напоминания' },
  { key: 'secure', title: 'Защищённые записи (безопасные резюме)' },
];

// Возможные колонки метаданных записи. Поле filter: 'multi' помечает столбцы, для которых выводится фильтр-мультиселект
// (по «Виду» и «Домену»). Для каждой группы реально показываются только те столбцы, по которым есть хоть одно значение.
const META_COLUMNS = [
  { field: 'kind', header: 'Вид', filter: 'multi', width: '11rem' },
  { field: 'domain', header: 'Домен', filter: 'multi', width: '11rem' },
  { field: 'importance', header: 'Важность', width: '7rem' },
  { field: 'due', header: 'Срок', width: '11rem' },
  { field: 'consent', header: 'Согласие', width: '11rem' },
];

// Короткая подпись для одного элемента памяти: основной текст плюс заголовок напоминания/защищённой записи.
function itemText(item) {
  return item.text || item.title || item.displayName || '(без текста)';
}

// Какие колонки метаданных есть смысл показывать для конкретной группы: оставляем только непустые.
function columnsFor(groupKey) {
  const items = (memory.value && memory.value[groupKey]) || [];
  return META_COLUMNS.filter((c) => items.some((it) => it[c.field] != null && it[c.field] !== ''));
}

// Уникальные значения столбца внутри группы — список опций для фильтра-мультиселекта, отсортированный по алфавиту.
function optionsFor(groupKey, field) {
  const set = new Set();
  for (const it of (memory.value && memory.value[groupKey]) || []) {
    if (it[field] != null && it[field] !== '') {
      set.add(it[field]);
    }
  }
  return Array.from(set).sort((a, b) => String(a).localeCompare(String(b), 'ru'));
}

// Инициализация фильтров после загрузки памяти: для каждой группы, где присутствуют фильтруемые столбцы,
// заводим запись с режимом сопоставления IN (значение ячейки должно входить в выбранный набор).
function initFilters() {
  const next = {};
  for (const grp of MEMORY_GROUPS) {
    const cols = columnsFor(grp.key).filter((c) => c.filter === 'multi');
    if (!cols.length) {
      continue;
    }
    next[grp.key] = {};
    for (const c of cols) {
      next[grp.key][c.field] = { value: null, matchMode: FilterMatchMode.IN };
    }
  }
  filters.value = next;
}

async function loadUsers() {
  loadingUsers.value = true;
  error.value = '';
  try {
    users.value = await fetchUsers();
  } catch (err) {
    error.value = err.message;
  } finally {
    loadingUsers.value = false;
  }
}

async function selectUser(user) {
  selectedUser.value = user;
  memory.value = null;
  loadingMemory.value = true;
  error.value = '';
  try {
    const data = await fetchUserMemory(user.id);
    // Заранее раскладываем основной текст записи в отдельное поле factText, чтобы DataTable мог сортировать
    // столбец «Факт» по обычному полю, не вызывая функцию на каждую отрисовку строки.
    for (const key of Object.keys(data)) {
      if (Array.isArray(data[key])) {
        for (const it of data[key]) {
          it.factText = itemText(it);
        }
      }
    }
    memory.value = data;
    initFilters();
  } catch (err) {
    error.value = err.message;
  } finally {
    loadingMemory.value = false;
  }
}

// Удаление одной записи памяти. Сначала запрашиваем подтверждение, затем выполняем мягкое удаление на сервере
// и убираем запись из локального состояния, чтобы таблица обновилась без повторной загрузки всей памяти.
async function removeItem(groupKey, item) {
  if (!selectedUser.value || !memory.value) {
    return;
  }
  if (!window.confirm(`Удалить запись?\n\n${itemText(item)}`)) {
    return;
  }
  try {
    await deleteMemoryItem(selectedUser.value.id, groupKey, item.id);
    memory.value[groupKey] = (memory.value[groupKey] || []).filter((it) => it.id !== item.id);
  } catch (err) {
    error.value = err.message;
  }
}

onMounted(() => {
  window.addEventListener('admin-auth-required', onAuthRequired);
  checkAuth();
});
onBeforeUnmount(() => {
  window.removeEventListener('admin-auth-required', onAuthRequired);
});
</script>

<template>
  <div v-if="authState === 'loading'" />
  <LoginScreen v-else-if="authState === 'login'" :bot-username="authInfo.botUsername" @logged-in="onLoggedIn" />
  <div v-else class="layout" :class="{ 'layout-full': activeTab !== 'memory' }">
    <header class="app-header">
      <h1>mem-bot — админка</h1>
      <nav class="tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          type="button"
          class="tab"
          :class="{ active: activeTab === t.key }"
          @click="activeTab = t.key"
        >
          {{ t.title }}
        </button>
      </nav>
      <span v-if="activeTab === 'memory'" class="status">пользователей: {{ users.length }}</span>
      <span v-if="authInfo.authRequired" class="auth-box">
        {{ authInfo.displayName }}
        <button type="button" class="logout" title="Выйти" @click="logout">Выйти</button>
      </span>
    </header>

    <div v-if="activeTab === 'llm-log'" class="page-full">
      <LlmLogPage />
    </div>

    <aside v-if="activeTab === 'memory'" class="sidebar">
      <div v-if="loadingUsers" class="empty">Загрузка списка пользователей…</div>
      <div v-else-if="!users.length" class="empty">Пользователей пока нет.</div>
      <div
        v-for="user in users"
        :key="user.id"
        class="user-item"
        :class="{ active: selectedUser && selectedUser.id === user.id }"
        @click="selectUser(user)"
      >
        <div>
          <div class="name">{{ user.name }}</div>
          <div class="meta">{{ user.externalId }}<span v-if="user.isAdmin"> · администратор</span></div>
        </div>
        <span class="badge">{{ user.memoryCount }}</span>
      </div>
    </aside>

    <main v-if="activeTab === 'memory'" class="main">
      <div v-if="error" class="error">Ошибка: {{ error }}</div>

      <div v-if="!selectedUser" class="empty">Выберите пользователя слева, чтобы увидеть его память.</div>

      <div v-else-if="loadingMemory" class="empty">Загрузка памяти пользователя…</div>

      <template v-else-if="memory">
        <section v-for="grp in MEMORY_GROUPS" :key="grp.key" class="memory-group">
          <h3>{{ grp.title }} ({{ (memory[grp.key] || []).length }})</h3>
          <DataTable
            v-model:filters="filters[grp.key]"
            :value="memory[grp.key] || []"
            data-key="id"
            size="small"
            removable-sort
            filter-display="row"
            striped-rows
          >
            <template v-for="c in columnsFor(grp.key)" :key="c.field">
              <Column
                v-if="c.filter === 'multi'"
                :field="c.field"
                :header="c.header"
                sortable
                :show-filter-menu="false"
                :style="{ width: c.width }"
              >
                <template #filter="{ filterModel, filterCallback }">
                  <MultiSelect
                    v-model="filterModel.value"
                    :options="optionsFor(grp.key, c.field)"
                    :placeholder="`Все: ${c.header.toLowerCase()}`"
                    :max-selected-labels="2"
                    filter
                    fluid
                    @change="filterCallback()"
                  />
                </template>
              </Column>
              <Column v-else :field="c.field" :header="c.header" sortable :style="{ width: c.width }" />
            </template>
            <Column field="factText" header="Факт" sortable :style="{ minWidth: '14rem' }" />
            <Column header="" class="col-actions">
              <template #body="{ data }">
                <Button
                  icon="pi pi-times"
                  severity="danger"
                  text
                  rounded
                  aria-label="Удалить запись"
                  @click="removeItem(grp.key, data)"
                />
              </template>
            </Column>
            <template #empty>
              <div class="empty">Записей нет.</div>
            </template>
          </DataTable>
        </section>
      </template>
    </main>
  </div>
</template>
