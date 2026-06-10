// Конфигурация сборщика Vite для админки. В режиме разработки (npm run web:dev) поднимается сервер с
// мгновенной горячей заменой модулей, а все запросы к /api проксируются на бэкенд (объединённый сервер
// src/server/index.js), чтобы фронтенд и API выглядели для браузера одним адресом без настройки CORS.
// При сборке (npm run web:build) результат кладётся в web/dist — этот каталог отдаёт express в продакшене.
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Адрес бэкенда для проксирования API в режиме разработки. Порт должен совпадать с config.admin.port
// (по умолчанию 3001). При необходимости переопределяется переменной окружения VITE_API_TARGET.
const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:3001';

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
  },
});
