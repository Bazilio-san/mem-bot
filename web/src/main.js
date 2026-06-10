// Точка входа фронтенда: создаёт корневой экземпляр приложения Vue и монтирует его в элемент #app.
import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';

createApp(App).mount('#app');
