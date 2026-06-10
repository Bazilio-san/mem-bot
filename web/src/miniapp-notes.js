// Точка входа страницы Telegram Mini App «Заметки» (web/miniapp/notes.html). Отдельная entry-точка
// сборки Vite: страница живёт вне SPA админки и открывается в WebView Телеграма по кнопке web_app.
import { createApp } from 'vue';
import MiniAppNotes from './components/notes/MiniAppNotes.vue';

createApp(MiniAppNotes).mount('#app');
