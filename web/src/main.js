// Точка входа фронтенда: создаёт корневой экземпляр приложения Vue, подключает библиотеку компонентов
// PrimeVue v4 с темой Aura и монтирует приложение в элемент #app. Тема Aura подключается в «стилизованном»
// режиме (styled mode) — компоненты приходят с готовым оформлением, поверх которого работают наши правки.
import { createApp } from 'vue';
import PrimeVue from 'primevue/config';
import Aura from '@primeuix/themes/aura';
import 'primeicons/primeicons.css';
import App from './App.vue';
import './styles.css';

const app = createApp(App);

app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      // Тёмную тему не используем: darkModeSelector указывает на несуществующий класс, чтобы Aura всегда
      // оставалась в светлом варианте независимо от системных настроек пользователя.
      darkModeSelector: '.app-dark-never',
    },
  },
  // Выпадающие списки (Select и прочие оверлеи) PrimeVue телепортирует в <body> с z-index ~1000+.
  // Собственное модальное окно AnalyzeDialog лежит на z-index 1100, поэтому без этой настройки список
  // пресетов раскрывался ПОЗАДИ диалога и был не виден. 1200 — выше маски диалога (1100), но ниже
  // редактора текста запроса (3000).
  zIndex: {
    overlay: 1200,
  },
});

app.mount('#app');
