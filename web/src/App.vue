<script setup>
// Корневой компонент админки. Раскладка «список пользователей слева — память выбранного пользователя справа».
// Это минимальный, но рабочий каркас: данные берутся из админ-API, состояние реактивно, поэтому добавление
// новых разделов сводится к новым запросам и компонентам без перестройки архитектуры.
import { ref, onMounted } from 'vue';
import { fetchUsers, fetchUserMemory } from './api.js';

const users = ref([]);
const selectedUser = ref(null);
const memory = ref(null);
const loadingUsers = ref(false);
const loadingMemory = ref(false);
const error = ref('');

// Заголовки и порядок отображения категорий памяти. Ключи совпадают с полями ответа админ-API.
const MEMORY_GROUPS = [
  { key: 'profile', title: 'Профиль (устойчивые факты о пользователе)' },
  { key: 'domain', title: 'Память предметной области' },
  { key: 'dialog', title: 'Факты текущего диалога' },
  { key: 'reminder', title: 'Активные напоминания' },
  { key: 'secure', title: 'Защищённые записи (безопасные резюме)' },
];

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
    memory.value = await fetchUserMemory(user.id);
  } catch (err) {
    error.value = err.message;
  } finally {
    loadingMemory.value = false;
  }
}

// Короткая подпись для одного элемента памяти: основной текст плюс заголовок напоминания/защищённой записи.
function itemText(item) {
  return item.text || item.title || item.displayName || '(без текста)';
}

onMounted(loadUsers);
</script>

<template>
  <div class="layout">
    <header class="app-header">
      <h1>mem-bot — админка</h1>
      <span class="status">пользователей: {{ users.length }}</span>
    </header>

    <aside class="sidebar">
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

    <main class="main">
      <div v-if="error" class="error">Ошибка: {{ error }}</div>

      <div v-if="!selectedUser" class="empty">Выберите пользователя слева, чтобы увидеть его память.</div>

      <div v-else-if="loadingMemory" class="empty">Загрузка памяти пользователя…</div>

      <template v-else-if="memory">
        <div v-for="grp in MEMORY_GROUPS" :key="grp.key" class="memory-group">
          <h3>{{ grp.title }} ({{ (memory[grp.key] || []).length }})</h3>
          <div v-if="!(memory[grp.key] || []).length" class="empty">Записей нет.</div>
          <div v-for="item in memory[grp.key] || []" :key="item.id" class="memory-item">
            <div>{{ itemText(item) }}</div>
            <div class="tags">
              <span v-if="item.kind">вид: {{ item.kind }}</span>
              <span v-if="item.domain"> · домен: {{ item.domain }}</span>
              <span v-if="item.importance != null"> · важность: {{ item.importance }}</span>
              <span v-if="item.due"> · срок: {{ item.due }}</span>
              <span v-if="item.consent"> · согласие: {{ item.consent }}</span>
            </div>
          </div>
        </div>
      </template>
    </main>
  </div>
</template>
