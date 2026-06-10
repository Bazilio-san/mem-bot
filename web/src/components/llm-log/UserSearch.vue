<script setup>
// Поиск пользователя с подсказками для страницы логов: по имени, Telegram id или точному внутреннему UUID.
// Построен на PrimeVue AutoComplete; запросы к /api/users/search идут с задержкой (debounce берёт на себя
// сам компонент через минимальную длину и события complete).
import { ref } from 'vue';
import AutoComplete from 'primevue/autocomplete';
import { searchUsers } from '../../api.js';

const emit = defineEmits(['select', 'error']);

const value = ref(null);
const suggestions = ref([]);

async function complete(event) {
  try {
    suggestions.value = await searchUsers(event.query);
  } catch (err) {
    suggestions.value = [];
    emit('error', err.message);
  }
}

function onSelect(event) {
  emit('select', event.value);
  value.value = null;
}

function fmtLast(iso) {
  if (!iso) {
    return 'без сообщений';
  }
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
</script>

<template>
  <AutoComplete
    v-model="value"
    :suggestions="suggestions"
    option-label="displayName"
    placeholder="Пользователь: имя, telegram id или UUID…"
    :min-length="1"
    fluid
    @complete="complete"
    @option-select="onSelect"
  >
    <template #option="{ option }">
      <div class="us-opt">
        <span class="us-name">{{ option.displayName || '(без имени)' }}</span>
        <span class="us-ext">tg {{ option.externalId }}<span v-if="option.isTest"> · тест</span></span>
        <span class="us-last">{{ fmtLast(option.lastMessageAt) }}</span>
      </div>
    </template>
    <template #empty>
      <div class="us-empty">Никого не найдено.</div>
    </template>
  </AutoComplete>
</template>

<style scoped>
.us-opt {
  display: flex;
  gap: 10px;
  align-items: baseline;
  width: 100%;
}
.us-name {
  font-weight: 600;
}
.us-ext {
  color: #8a909a;
  font-size: 12px;
}
.us-last {
  margin-left: auto;
  color: #8a909a;
  font-size: 11px;
}
.us-empty {
  padding: 8px 12px;
  color: #99a;
  font-size: 13px;
}
</style>
