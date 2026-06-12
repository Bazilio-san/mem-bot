// Entry point of the "Notes" Telegram Mini App page (web/miniapp/notes.html). A separate Vite build
// entry: the page lives outside the admin SPA and opens in the Telegram WebView via the web_app button.
import { createApp } from 'vue';
import MiniAppNotes from './components/notes/MiniAppNotes.vue';

createApp(MiniAppNotes).mount('#app');
