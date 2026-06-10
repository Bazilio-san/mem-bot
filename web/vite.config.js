// Конфигурация сборщика Vite для админки. В режиме разработки (npm run web:dev) поднимается сервер с
// мгновенной горячей заменой модулей, а все запросы к /api проксируются на бэкенд (объединённый сервер
// src/server/index.js), чтобы фронтенд и API выглядели для браузера одним адресом без настройки CORS.
// При сборке (npm run web:build) результат кладётся в web/dist — этот каталог отдаёт express в продакшене.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Адрес бэкенда для проксирования API в режиме разработки. Порт должен совпадать с config.admin.port
// (по умолчанию 9019). При необходимости переопределяется переменной окружения VITE_API_TARGET.
const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:9019';

// oxlint-disable-next-line import/no-default-export
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // Две страницы: SPA админки (index.html) и Telegram Mini App заметок (miniapp/notes.html).
      // Mini App попадает в dist/miniapp/notes.html и отдаётся express по маршруту /miniapp/notes.
      input: {
        index: path.resolve(__dirname, 'index.html'),
        'miniapp-notes': path.resolve(__dirname, 'miniapp/notes.html'),
      },
      output: {
        // Библиотека компонентов PrimeVue вместе с темой выносится в отдельный чанк vendor-primevue.
        // Она меняется редко (только при обновлении версии), поэтому браузер кэширует её отдельно от
        // кода приложения, а сам бандл приложения остаётся небольшим и пересобирается без перезагрузки темы.
        manualChunks(id) {
          if (id.includes('node_modules/primevue') || id.includes('node_modules/@primeuix')) {
            return 'vendor-primevue';
          }
          return undefined;
        },
      },
    },
  },
});
