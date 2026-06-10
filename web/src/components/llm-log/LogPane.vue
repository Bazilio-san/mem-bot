<script setup>
// Правая панель просмотрщика: шапка журнала (название цикла, суммарные токены и стоимость, модели,
// длительность, кнопки «развернуть/свернуть всё» и «Спросить ИИ») и лента строк. Состояние раскрытия строк
// и сворачивания групп-стадий живёт здесь; LogRow только рисует строку и сообщает о клике.
import { ref, computed, watch } from 'vue';
import Button from 'primevue/button';
import LogRow from './LogRow.vue';

const props = defineProps({
  log: { type: Object, default: null }, // { requestId, header, rows }
  loading: { type: Boolean, default: false },
  title: { type: String, default: '' },
});
const emit = defineEmits(['analyze']);

const expandedRows = ref(new Set());
const collapsedGroups = ref(new Set());

// При загрузке нового журнала раскрываем «смысловые» строки, как в прототипе: сообщение пользователя и
// финальный ответ. Остальное свёрнуто.
watch(
  () => props.log,
  (log) => {
    const next = new Set();
    for (const row of log?.rows || []) {
      if (row.rowType === 'user_say' || row.rowType === 'answer_user') {
        next.add(row.n);
      }
    }
    expandedRows.value = next;
    collapsedGroups.value = new Set();
  },
  { immediate: true },
);

function toggleRow(row) {
  if (row.isGroupHeader) {
    const next = new Set(collapsedGroups.value);
    if (next.has(row.groupId)) {
      next.delete(row.groupId);
    } else {
      next.add(row.groupId);
    }
    collapsedGroups.value = next;
    return;
  }
  const next = new Set(expandedRows.value);
  if (next.has(row.n)) {
    next.delete(row.n);
  } else {
    next.add(row.n);
  }
  expandedRows.value = next;
}

function setAll(open) {
  if (!props.log) {
    return;
  }
  collapsedGroups.value = new Set();
  expandedRows.value = open
    ? new Set(props.log.rows.filter((r) => !r.isGroupHeader && r.body != null).map((r) => r.n))
    : new Set();
}

const visibleRows = computed(() =>
  (props.log?.rows || []).filter((r) => r.isGroupHeader || !r.groupId || !collapsedGroups.value.has(r.groupId)),
);

const headerSummary = computed(() => {
  const h = props.log?.header;
  if (!h) {
    return '';
  }
  const parts = [];
  if (h.tokens) {
    parts.push(`${Number(h.tokens).toLocaleString('ru-RU')} ткн`);
  }
  if (h.priceUsd) {
    parts.push(`$${Number(h.priceUsd).toFixed(4)}`);
  }
  if (h.models?.length) {
    parts.push(h.models.join(', '));
  }
  if (h.durationMs != null) {
    parts.push(`${(h.durationMs / 1000).toFixed(1)} с`);
  }
  return parts.join(' · ');
});
</script>

<template>
  <section class="lp">
    <div v-if="log" class="lp-head">
      <span class="lp-title" :title="log.requestId || ''">{{ title || `Цикл ${log.requestId || ''}` }}</span>
      <span class="lp-totals">{{ headerSummary }}</span>
      <span v-if="log.header?.hasError" class="lp-err">есть ошибки</span>
      <span class="lp-sp" />
      <Button text size="small" title="Развернуть всё" @click="setAll(true)">▼</Button>
      <Button text size="small" title="Свернуть всё" @click="setAll(false)">▲</Button>
      <Button size="small" severity="warn" @click="emit('analyze')">Спросить ИИ</Button>
    </div>
    <div class="lp-rows">
      <div v-if="loading" class="lp-empty">Загрузка журнала…</div>
      <div v-else-if="!log" class="lp-empty">Выберите сообщение или сервисный бэйдж слева.</div>
      <template v-else>
        <LogRow
          v-for="row in visibleRows"
          :key="row.n"
          :row="row"
          :expanded="row.isGroupHeader ? !collapsedGroups.has(row.groupId) : expandedRows.has(row.n)"
          @toggle="toggleRow(row)"
        />
      </template>
    </div>
  </section>
</template>

<style scoped>
.lp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: #fff;
}
.lp-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid #e2e5e9;
  flex: none;
}
.lp-title {
  color: #e8a33d;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}
.lp-totals {
  color: #8d939c;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lp-err {
  color: #b3261e;
  font-size: 12px;
  white-space: nowrap;
}
.lp-sp {
  flex: 1;
}
.lp-rows {
  flex: 1;
  overflow-y: auto;
  font-size: 13px;
}
.lp-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #aab;
  padding: 24px;
}
</style>
