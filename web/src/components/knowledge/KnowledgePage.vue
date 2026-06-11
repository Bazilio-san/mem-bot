<script setup>
// Вкладка «База знаний»: CRUD над глобальной RAG-базой (mem.global_knowledge). Таблица PrimeVue DataTable
// с сортировками и фильтрами по столбцам; объём базы мал (десятки–сотни записей), поэтому список загружается
// целиком (включая корзину), а сортировка и фильтрация выполняются на клиенте. Фильтр по статусу по умолчанию
// скрывает удалённые записи — выбор статуса deleted открывает корзину, восстановление — через форму записи.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import DataTable from 'primevue/datatable';
import Column from 'primevue/column';
import MultiSelect from 'primevue/multiselect';
import Select from 'primevue/select';
import InputText from 'primevue/inputtext';
import Button from 'primevue/button';
import { FilterMatchMode, FilterService } from '@primevue/core/api';
import {
  fetchKnowledge,
  fetchDomains,
  createKnowledge,
  updateKnowledge,
  deleteKnowledge,
  reembedKnowledge,
  searchKnowledgeText,
} from '../../api.js';
import KnowledgeDialog from './KnowledgeDialog.vue';

// Пользовательский режим фильтра для массива тегов: строка проходит, если содержит хотя бы один из
// выбранных тегов (встроенных режимов для колонок-массивов у PrimeVue нет).
const TAGS_MATCH_MODE = 'knowledgeTagsIncludeAny';
FilterService.register(TAGS_MATCH_MODE, (value, filter) => {
  if (!Array.isArray(filter) || !filter.length) {
    return true;
  }
  return Array.isArray(value) && filter.some((tag) => value.includes(tag));
});

const records = ref([]);
const domains = ref([]);
const loading = ref(false);
const error = ref('');

// Запись, открытая в диалоге: null — диалог закрыт, {} без id — создание, с id — редактирование.
const dialogRecord = ref(null);

// Фильтры столбцов. Статус по умолчанию скрывает корзину: после загрузки данных фильтру присваиваются
// только статусы, реально присутствующие в записях, кроме deleted (см. defaultStatusFilter) — иначе
// предвыбранное, но отсутствующее в данных значение раздувает счётчик «выбрано» в мультиселекте.
// Удалённые записи доступны выбором статуса deleted в этом же фильтре.
const defaultFilters = () => ({
  embeddingLabel: { value: null, matchMode: FilterMatchMode.EQUALS },
  title: { value: null, matchMode: FilterMatchMode.CONTAINS },
  content: { value: null, matchMode: FilterMatchMode.CONTAINS },
  domainLabel: { value: null, matchMode: FilterMatchMode.IN },
  tags: { value: null, matchMode: TAGS_MATCH_MODE },
  status: { value: null, matchMode: FilterMatchMode.IN },
  source: { value: null, matchMode: FilterMatchMode.CONTAINS },
});
const filters = ref(defaultFilters());

// Статусы для фильтра по умолчанию: все, что есть в данных, кроме deleted. Если удалённых записей нет
// вовсе, фильтр остаётся пустым (null) — это «показывать всё», и счётчик мультиселекта не вводит в
// заблуждение лишними предвыбранными значениями.
function defaultStatusFilter(rows) {
  const present = new Set(rows.map((r) => r.status));
  if (!present.has('deleted')) {
    return null;
  }
  present.delete('deleted');
  return Array.from(present).sort();
}

const EMBEDDING_OPTIONS = ['есть', 'нет'];

// Производные поля для сортировки и фильтров: подпись эмбеддинга, подпись домена, короткое превью текста.
function decorate(r) {
  return {
    ...r,
    embeddingLabel: r.hasEmbedding ? 'есть' : 'нет',
    domainLabel: r.domainKey || 'все домены',
    contentPreview: r.content.length > 160 ? `${r.content.slice(0, 160)}…` : r.content,
  };
}

const withoutEmbedding = computed(() => records.value.filter((r) => !r.hasEmbedding).length);

const statusOptions = computed(() => Array.from(new Set(records.value.map((r) => r.status))).sort());
const domainOptions = computed(() =>
  Array.from(new Set(records.value.map((r) => r.domainLabel))).sort((a, b) => a.localeCompare(b, 'ru')),
);
const tagOptions = computed(() =>
  Array.from(new Set(records.value.flatMap((r) => r.tags))).sort((a, b) => a.localeCompare(b, 'ru')),
);

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleString('ru-RU') : '';
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [list, doms] = await Promise.all([fetchKnowledge('all'), fetchDomains()]);
    records.value = list.map(decorate);
    domains.value = doms;
    if (filters.value.status.value === null) {
      filters.value.status.value = defaultStatusFilter(records.value);
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

// Клик по индикатору «без эмбеддинга: N» — включает (или сбрасывает) фильтр по отсутствию вектора.
function toggleNoEmbeddingFilter() {
  filters.value.embeddingLabel.value = filters.value.embeddingLabel.value === 'нет' ? null : 'нет';
}

// --- Неточный текстовый поиск ------------------------------------------------------------------
// Запрос уходит на сервер (полнотекст + триграммная похожесть, ловит опечатки и словоформы) с задержкой
// после окончания ввода. Результаты заменяют содержимое таблицы и сортируются по релевантности; очистка
// поля возвращает полный список. Колоночные фильтры продолжают работать поверх результатов поиска.
const searchQuery = ref('');
const searching = ref(false);
const searchMode = ref(false);
let searchTimer = null;
let searchSeq = 0;

async function runSearch() {
  const q = searchQuery.value.trim();
  const seq = ++searchSeq;
  if (!q) {
    searchMode.value = false;
    await load();
    return;
  }
  searching.value = true;
  try {
    const found = await searchKnowledgeText(q, 'all');
    if (seq !== searchSeq) {
      return; // пришёл ответ на устаревший запрос — пользователь уже набрал другой текст
    }
    records.value = found.map(decorate);
    searchMode.value = true;
    error.value = '';
  } catch (err) {
    if (seq === searchSeq) {
      error.value = err.message;
    }
  } finally {
    if (seq === searchSeq) {
      searching.value = false;
    }
  }
}

watch(searchQuery, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 350);
});

function clearSearch() {
  searchQuery.value = '';
}

onBeforeUnmount(() => clearTimeout(searchTimer));

function openCreate() {
  dialogRecord.value = {};
}

function openEdit(record) {
  dialogRecord.value = { ...record };
}

// Сохранение из диалога: создание или обновление, затем замена строки в локальном состоянии.
async function onDialogSave(payload) {
  try {
    const saved = payload.id ? await updateKnowledge(payload.id, payload) : await createKnowledge(payload);
    const row = decorate(saved);
    const idx = records.value.findIndex((r) => r.id === row.id);
    if (idx >= 0) {
      records.value[idx] = row;
    } else {
      records.value = [row, ...records.value];
    }
    dialogRecord.value = null;
  } catch (err) {
    error.value = err.message;
  }
}

// Мягкое удаление: запись получает status = 'deleted' и скрывается фильтром статуса по умолчанию.
async function removeRecord(record) {
  if (!window.confirm(`Удалить запись?\n\n${record.title || record.contentPreview}`)) {
    return;
  }
  try {
    await deleteKnowledge(record.id);
    const idx = records.value.findIndex((r) => r.id === record.id);
    if (idx >= 0) {
      records.value[idx] = decorate({ ...records.value[idx], status: 'deleted' });
    }
    // Если фильтр статуса не задан (удалённых до сих пор не было — «показывать всё»), задаём его сейчас,
    // чтобы только что удалённая запись скрылась из представления по умолчанию.
    if (filters.value.status.value === null) {
      filters.value.status.value = defaultStatusFilter(records.value);
    }
  } catch (err) {
    error.value = err.message;
  }
}

// Ручной пересчёт эмбеддинга (кнопка у записей без вектора).
const reembedding = ref(new Set());
async function reembed(record) {
  reembedding.value = new Set(reembedding.value).add(record.id);
  try {
    const saved = await reembedKnowledge(record.id);
    const idx = records.value.findIndex((r) => r.id === record.id);
    if (idx >= 0) {
      records.value[idx] = decorate(saved);
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    const next = new Set(reembedding.value);
    next.delete(record.id);
    reembedding.value = next;
  }
}

onMounted(load);
</script>

<template>
  <div class="kb">
    <div class="kb-toolbar">
      <Button label="Добавить запись" icon="pi pi-plus" size="small" @click="openCreate" />
      <span class="kb-search">
        <InputText
          v-model="searchQuery"
          size="small"
          placeholder="Текстовый поиск (неточный: опечатки, словоформы)"
          class="kb-search-input"
        />
        <button v-if="searchQuery" type="button" class="kb-search-x" title="Очистить поиск" @click="clearSearch">
          ✕
        </button>
      </span>
      <span v-if="searching" class="kb-count">поиск…</span>
      <span class="kb-count">{{ searchMode ? `найдено: ${records.length}` : `записей: ${records.length}` }}</span>
      <button
        v-if="withoutEmbedding"
        type="button"
        class="kb-noemb"
        :class="{ active: filters.embeddingLabel.value === 'нет' }"
        title="Показать только записи без эмбеддинга"
        @click="toggleNoEmbeddingFilter"
      >
        ⚠ без эмбеддинга: {{ withoutEmbedding }}
      </button>
      <span v-if="loading" class="kb-count">загрузка…</span>
    </div>

    <div v-if="error" class="kb-error">Ошибка: {{ error }}</div>

    <DataTable
      v-model:filters="filters"
      :value="records"
      data-key="id"
      size="small"
      removable-sort
      striped-rows
      filter-display="row"
      :sort-field="searchMode ? 'relevance' : 'updatedAt'"
      :sort-order="-1"
      paginator
      :rows="50"
      :rows-per-page-options="[25, 50, 100]"
      :always-show-paginator="false"
    >
      <Column v-if="searchMode" field="relevance" header="Релевантность" sortable :style="{ width: '8rem' }">
        <template #body="{ data }">{{ data.relevance != null ? data.relevance.toFixed(2) : '' }}</template>
      </Column>

      <Column field="embeddingLabel" header="Эмбеддинг" sortable :show-filter-menu="false" :style="{ width: '9rem' }">
        <template #filter="{ filterModel, filterCallback }">
          <Select
            v-model="filterModel.value"
            :options="EMBEDDING_OPTIONS"
            placeholder="Все"
            show-clear
            fluid
            @change="filterCallback()"
          />
        </template>
        <template #body="{ data }">
          <span v-if="data.hasEmbedding" class="kb-emb kb-emb-ok">✓</span>
          <span v-else class="kb-emb kb-emb-no">
            ⚠ нет
            <Button
              icon="pi pi-refresh"
              text
              rounded
              size="small"
              :loading="reembedding.has(data.id)"
              aria-label="Пересчитать эмбеддинг"
              title="Пересчитать эмбеддинг"
              @click="reembed(data)"
            />
          </span>
        </template>
      </Column>

      <Column field="title" header="Заголовок" sortable :show-filter-menu="false" :style="{ width: '14rem' }">
        <template #filter="{ filterModel, filterCallback }">
          <InputText v-model="filterModel.value" placeholder="Поиск" fluid @input="filterCallback()" />
        </template>
      </Column>

      <Column field="content" header="Содержимое" sortable :show-filter-menu="false" :style="{ minWidth: '20rem' }">
        <template #filter="{ filterModel, filterCallback }">
          <InputText v-model="filterModel.value" placeholder="Поиск" fluid @input="filterCallback()" />
        </template>
        <template #body="{ data }">
          <span :title="data.content">{{ data.contentPreview }}</span>
        </template>
      </Column>

      <Column field="domainLabel" header="Домен" sortable :show-filter-menu="false" :style="{ width: '11rem' }">
        <template #filter="{ filterModel, filterCallback }">
          <MultiSelect
            v-model="filterModel.value"
            :options="domainOptions"
            placeholder="Все"
            :max-selected-labels="1"
            selected-items-label="выбрано: {0}"
            fluid
            @change="filterCallback()"
          />
        </template>
      </Column>

      <Column field="tags" header="Теги" :show-filter-menu="false" :style="{ width: '12rem' }">
        <template #filter="{ filterModel, filterCallback }">
          <MultiSelect
            v-model="filterModel.value"
            :options="tagOptions"
            placeholder="Все"
            :max-selected-labels="1"
            selected-items-label="выбрано: {0}"
            filter
            fluid
            @change="filterCallback()"
          />
        </template>
        <template #body="{ data }">
          <span v-for="t in data.tags" :key="t" class="kb-tag">{{ t }}</span>
        </template>
      </Column>

      <Column field="importance" header="Важность" sortable :style="{ width: '7rem' }" />

      <Column field="status" header="Статус" sortable :show-filter-menu="false" :style="{ width: '10rem' }">
        <template #filter="{ filterModel, filterCallback }">
          <MultiSelect
            v-model="filterModel.value"
            :options="statusOptions"
            placeholder="Все"
            :max-selected-labels="2"
            selected-items-label="выбрано: {0}"
            fluid
            @change="filterCallback()"
          />
        </template>
        <template #body="{ data }">
          <span class="kb-status" :class="`kb-status-${data.status}`">{{ data.status }}</span>
        </template>
      </Column>

      <Column field="source" header="Источник" sortable :show-filter-menu="false" :style="{ width: '10rem' }">
        <template #filter="{ filterModel, filterCallback }">
          <InputText v-model="filterModel.value" placeholder="Поиск" fluid @input="filterCallback()" />
        </template>
      </Column>

      <Column field="updatedAt" header="Обновлено" sortable :style="{ width: '11rem' }">
        <template #body="{ data }">{{ fmtDate(data.updatedAt) }}</template>
      </Column>

      <Column header="" class="kb-col-actions" :style="{ width: '6rem' }">
        <template #body="{ data }">
          <Button icon="pi pi-pencil" text rounded size="small" aria-label="Редактировать" @click="openEdit(data)" />
          <Button
            v-if="data.status !== 'deleted'"
            icon="pi pi-times"
            severity="danger"
            text
            rounded
            size="small"
            aria-label="Удалить запись"
            @click="removeRecord(data)"
          />
        </template>
      </Column>

      <template #empty>
        <div class="kb-empty">Записей нет.</div>
      </template>
    </DataTable>

    <KnowledgeDialog
      v-if="dialogRecord !== null"
      :record="dialogRecord"
      :domains="domains"
      @save="onDialogSave"
      @close="dialogRecord = null"
    />
  </div>
</template>

<style scoped>
.kb {
  padding: 12px 16px;
  overflow: auto;
  height: 100%;
}
.kb-toolbar {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 10px;
}
.kb-count {
  color: #777;
  font-size: 13px;
}
.kb-search {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.kb-search-input {
  width: 24rem;
  padding-right: 1.8rem;
}
.kb-search-x {
  position: absolute;
  right: 6px;
  border: none;
  background: none;
  color: #888;
  cursor: pointer;
  font-size: 12px;
  padding: 2px;
}
.kb-search-x:hover {
  color: #333;
}
.kb-noemb {
  border: 1px solid #e0a800;
  background: #fff8e1;
  color: #8a6d00;
  border-radius: 6px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
}
.kb-noemb.active {
  background: #e0a800;
  color: #fff;
}
.kb-error {
  background: #ffe5e5;
  color: #a33;
  border-radius: 6px;
  padding: 6px 12px;
  margin-bottom: 10px;
}
.kb-emb {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 12px;
}
.kb-emb-ok {
  color: #2c6b2f;
  font-weight: 700;
}
.kb-emb-no {
  color: #8a6d00;
}
.kb-tag {
  display: inline-block;
  background: rgba(0, 0, 0, 0.07);
  border-radius: 4px;
  padding: 0 6px;
  margin: 1px 3px 1px 0;
  font-size: 11px;
}
.kb-status {
  font-size: 12px;
}
.kb-status-deleted {
  color: #a33;
}
.kb-status-archived {
  color: #888;
}
.kb-empty {
  color: #999;
  padding: 8px;
}
.kb-col-actions :deep(.p-button) {
  width: 1.7rem;
  height: 1.7rem;
}
</style>
