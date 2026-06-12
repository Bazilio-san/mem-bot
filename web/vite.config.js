// Vite bundler configuration for the admin panel. In development mode (npm run web:dev) a server with
// instant hot module replacement is started, and all /api requests are proxied to the backend (the combined
// server src/server/index.js) so the frontend and API look like a single origin to the browser without CORS setup.
// On build (npm run web:build) the result goes into web/dist — express serves that directory in production.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adminEntry = path.resolve(__dirname, 'src/main.js').replace(/\\/g, '/');
const miniappEntry = path.resolve(__dirname, 'src/miniapp-notes.js').replace(/\\/g, '/');
const normalizeModuleId = (id) => id.replace(/\\/g, '/');

// Backend address for proxying the API in development mode. The port must match config.admin.port
// (9019 by default). Can be overridden with the VITE_API_TARGET environment variable if needed.
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
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      // Two pages: the admin SPA (index.html) and the notes Telegram Mini App (miniapp/notes.html).
      // The Mini App ends up in dist/miniapp/notes.html and is served by express at /miniapp/notes.
      input: {
        index: path.resolve(__dirname, 'index.html'),
        'miniapp-notes': path.resolve(__dirname, 'miniapp/notes.html'),
      },
      output: {
        chunkFileNames: 'assets/[name]-[hash].js',
        // The PrimeVue component library together with its theme goes into a separate vendor-primevue chunk.
        // It changes rarely (only on a version upgrade), so the browser caches it separately from the
        // application code, and the app bundle itself stays small and rebuilds without reloading the theme.
        manualChunks(id) {
          const moduleId = normalizeModuleId(id);
          if (moduleId.startsWith(adminEntry)) {
            return 'entry-admin';
          }
          if (moduleId.startsWith(miniappEntry)) {
            return 'entry-miniapp';
          }
          if (moduleId.includes('src/components/notes/')) {
            return 'miniapp-content';
          }
          if (moduleId.includes('node_modules/primevue') || moduleId.includes('node_modules/@primeuix')) {
            return 'vendor-primevue';
          }
          if (moduleId.includes('node_modules/vue/') || moduleId.includes('node_modules/vuex')) {
            return 'vendor-vue';
          }
          if (moduleId.includes('node_modules/marked') || moduleId.includes('node_modules/dompurify')) {
            return 'vendor-content';
          }
          if (
            moduleId.includes('node_modules/@primeicons') ||
            moduleId.includes('node_modules/@vitejs') ||
            moduleId.includes('node_modules/vite')
          ) {
            return 'vendor-build';
          }
          if (moduleId.includes('node_modules/')) {
            return 'vendor-shared';
          }
          return undefined;
        },
      },
    },
  },
});
