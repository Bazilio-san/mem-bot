<script setup>
// Обёртка виджета заметок для Telegram Mini App: забирает initData и тему из window.Telegram.WebApp,
// маппит themeParams на CSS-переменные страницы и рендерит тот же NotesWidget, что и чат админки.
// Авторизация — заголовок X-Tg-Init-Data на каждом запросе виджета (валидируется на сервере подписью
// токена бота). Вне Телеграма (initData пуст) страница честно объясняет, как её открыть.
import { ref, onMounted } from 'vue';
import NotesWidget from './NotesWidget.vue';

const tgInitData = ref('');
const initialQuery = new URLSearchParams(window.location.search).get('q') || '';

onMounted(() => {
  const webApp = window.Telegram?.WebApp;
  if (!webApp?.initData) {
    return;
  }
  tgInitData.value = webApp.initData;
  webApp.ready();
  webApp.expand();

  // Тема Телеграма: фоновые и текстовые цвета страницы берутся из themeParams, чтобы Mini App выглядела
  // родной в светлой и тёмной темах. Виджет внутри остаётся светлым — он читабелен в обеих темах.
  const apply = () => {
    const p = webApp.themeParams || {};
    const root = document.documentElement;
    root.style.setProperty('--tg-bg', p.bg_color || '#ffffff');
    root.style.setProperty('--tg-text', p.text_color || '#111111');
    root.style.setProperty('--tg-hint', p.hint_color || '#888888');
  };
  apply();
  webApp.onEvent?.('themeChanged', apply);
});
</script>

<template>
  <div class="ma">
    <template v-if="tgInitData">
      <div class="ma-title">📝 Мои заметки</div>
      <NotesWidget :tg-init-data="tgInitData" :initial-query="initialQuery" list-max-height="calc(100vh - 130px)" />
    </template>
    <div v-else class="ma-fallback">
      <p>Эта страница — Telegram Mini App для заметок.</p>
      <p>Откройте её из чата с ботом по кнопке «📝 Открыть заметки» — тогда Телеграм передаст данные авторизации.</p>
    </div>
  </div>
</template>

<style>
body {
  margin: 0;
  background: var(--tg-bg, #f4f5f7);
  color: var(--tg-text, #111);
  font-family: -apple-system, 'Segoe UI', Roboto, sans-serif;
}
</style>

<style scoped>
.ma {
  max-width: 680px;
  margin: 0 auto;
  padding: 10px 10px 16px;
}
.ma-title {
  font-weight: 600;
  font-size: 16px;
  padding: 6px 2px 10px;
}
.ma-fallback {
  padding: 40px 16px;
  text-align: center;
  color: var(--tg-hint, #888);
  line-height: 1.5;
}
</style>
