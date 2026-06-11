<script setup>
// Корневой компонент админки. Раскладка «список пользователей слева — память выбранного пользователя справа».
// Таблицы памяти построены на компоненте DataTable из библиотеки PrimeVue (тема Aura): сортировка, фильтрация
// по столбцам и пагинация берутся из коробки, поэтому здесь остаётся только подготовка данных и описание колонок.
import { ref, onMounted, onBeforeUnmount } from 'vue';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import MultiSelect from 'primevue/multiselect';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Checkbox from 'primevue/checkbox';
import { FilterMatchMode } from '@primevue/core/api';
import { fetchUsers, fetchUserMemory, deleteMemoryItem, deleteUser, fetchAuthMe, logoutAdmin } from './api.js';
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
  { field: 'confidence', header: 'Уверенность', width: '7rem' },
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

// --- Удаление пользователя целиком -------------------------------------------------------------
// По кнопке у строки пользователя показывается диалог-предупреждение о каскадном удалении всех данных.
// Флажок «Не напоминать в течение 5 минут» записывает в localStorage момент, до которого подтверждение
// не требуется: пока он не наступил, повторные удаления выполняются сразу, без диалога.
const DELETE_CONFIRM_SUPPRESS_KEY = 'memAdmin.deleteUserConfirmSuppressedUntil';
const DELETE_CONFIRM_SUPPRESS_MS = 5 * 60 * 1000;

const deleteDialogVisible = ref(false);
const userToDelete = ref(null);
const suppressDeleteConfirm = ref(false);
const deletingUser = ref(false);

// Активно ли сейчас подавление диалога подтверждения (включённый ранее флажок ещё не истёк).
function isDeleteConfirmSuppressed() {
  const until = Number(localStorage.getItem(DELETE_CONFIRM_SUPPRESS_KEY) || 0);
  return Number.isFinite(until) && Date.now() < until;
}

// Клик по кнопке удаления в списке: либо сразу удаляем (подавление активно), либо открываем диалог.
function askDeleteUser(user) {
  if (isDeleteConfirmSuppressed()) {
    performDeleteUser(user);
    return;
  }
  userToDelete.value = user;
  suppressDeleteConfirm.value = false;
  deleteDialogVisible.value = true;
}

// Подтверждение в диалоге: при включённом флажке запоминаем срок подавления, затем удаляем.
async function confirmDeleteUser() {
  if (suppressDeleteConfirm.value) {
    localStorage.setItem(DELETE_CONFIRM_SUPPRESS_KEY, String(Date.now() + DELETE_CONFIRM_SUPPRESS_MS));
  }
  const user = userToDelete.value;
  deleteDialogVisible.value = false;
  userToDelete.value = null;
  if (user) {
    await performDeleteUser(user);
  }
}

// Собственно удаление: запрос к API, затем чистка локального состояния — пользователь уходит из списка,
// а если была открыта его память, правая панель возвращается к подсказке «выберите пользователя».
async function performDeleteUser(user) {
  deletingUser.value = true;
  error.value = '';
  try {
    await deleteUser(user.id);
    users.value = users.value.filter((u) => u.id !== user.id);
    if (selectedUser.value && selectedUser.value.id === user.id) {
      selectedUser.value = null;
      memory.value = null;
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    deletingUser.value = false;
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
        <span class="user-side">
          <span class="badge">{{ user.memoryCount }}</span>
          <Button
            icon="pi pi-trash"
            severity="danger"
            text
            rounded
            size="small"
            class="user-delete"
            :disabled="deletingUser"
            :aria-label="`Удалить пользователя ${user.name}`"
            @click.stop="askDeleteUser(user)"
          />
        </span>
      </div>
    </aside>

    <Dialog
      v-model:visible="deleteDialogVisible"
      modal
      header="Удаление пользователя"
      :style="{ width: 'min(480px, 92vw)' }"
    >
      <p class="delete-warning">
        Будут безвозвратно удалены пользователь
        <strong>{{ userToDelete ? userToDelete.name : '' }}</strong> и все его данные: диалоги, сообщения, факты памяти,
        защищённые записи, задачи планировщика и уведомления. Журналы вызовов инструментов и LLM-запросов сохранятся.
        Отменить это действие нельзя.
      </p>
      <label class="delete-suppress">
        <Checkbox v-model="suppressDeleteConfirm" binary input-id="suppress-delete-confirm" />
        <span>Не напоминать в течение 5 минут</span>
      </label>
      <template #footer>
        <Button label="Отмена" severity="secondary" text @click="deleteDialogVisible = false" />
        <Button label="Удалить" severity="danger" @click="confirmDeleteUser" />
      </template>
    </Dialog>

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
