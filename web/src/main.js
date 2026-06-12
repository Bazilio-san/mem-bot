// Frontend entry point: creates the root Vue application instance, plugs in the PrimeVue v4 component
// library with the Aura theme and mounts the app into the #app element. The Aura theme is used in styled
// mode — components come pre-styled, and our overrides are applied on top.
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
      // Dark theme is not used: darkModeSelector points to a non-existent class so Aura always
      // stays in the light variant regardless of the user's system settings.
      darkModeSelector: '.app-dark-never',
    },
  },
  // PrimeVue teleports dropdowns (Select and other overlays) into <body> with z-index ~1000+.
  // Our own AnalyzeDialog modal sits at z-index 1100, so without this setting the preset list
  // opened BEHIND the dialog and was invisible. 1200 is above the dialog mask (1100) but below
  // the request text editor (3000).
  zIndex: {
    overlay: 1200,
  },
});

app.mount('#app');
