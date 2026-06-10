<script setup>
// Экран входа в админку через официальный Telegram Login Widget. Скрипт виджета подключается
// динамически и рисует кнопку «Log in with Telegram»; после подтверждения в Телеграме виджет вызывает
// глобальный колбэк onTelegramAuth с подписанным payload, который отправляется на /api/auth/telegram.
// Сервер проверяет подпись токеном бота и флаг is_admin и ставит сессионную cookie.
// Требование Telegram: домен админки должен быть привязан к боту через BotFather (/setdomain).
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { loginTelegram } from '../../api.js';

const props = defineProps({
  botUsername: { type: String, default: null },
});
const emit = defineEmits(['logged-in']);

const widgetHost = ref(null);
const error = ref('');
const pending = ref(false);

onMounted(() => {
  if (!props.botUsername) {
    return;
  }
  // Глобальный колбэк для атрибута data-onauth виджета.
  window.onTelegramAuth = async (user) => {
    pending.value = true;
    error.value = '';
    try {
      await loginTelegram(user);
      emit('logged-in');
    } catch (err) {
      error.value = err.message;
    } finally {
      pending.value = false;
    }
  };
  const script = document.createElement('script');
  script.src = 'https://telegram.org/js/telegram-widget.js?22';
  script.async = true;
  script.setAttribute('data-telegram-login', props.botUsername);
  script.setAttribute('data-size', 'large');
  script.setAttribute('data-radius', '8');
  script.setAttribute('data-onauth', 'onTelegramAuth(user)');
  widgetHost.value.appendChild(script);
});

onBeforeUnmount(() => {
  delete window.onTelegramAuth;
});
</script>

<template>
  <div class="login">
    <div class="login-card">
      <h2>mem-bot — админка</h2>
      <p class="hint">Вход доступен только администраторам бота. Авторизация выполняется через Telegram.</p>
      <div v-if="!botUsername" class="warn">
        В конфигурации не задан username бота (<code>telegram.botUsername</code> / переменная
        <code>TELEGRAM_BOT_USERNAME</code>) — виджет входа не может быть показан.
      </div>
      <div v-else ref="widgetHost" class="widget"></div>
      <div v-if="pending" class="hint">Проверяю подпись Telegram…</div>
      <div v-if="error" class="warn">{{ error }}</div>
    </div>
  </div>
</template>

<style scoped>
.login {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: #e7ebf0;
}
.login-card {
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.1);
  padding: 32px 38px;
  text-align: center;
  max-width: 420px;
}
.login-card h2 {
  margin: 0 0 8px;
}
.hint {
  color: #6b7280;
  font-size: 13.5px;
  margin: 6px 0 16px;
}
.widget {
  display: flex;
  justify-content: center;
  min-height: 44px;
  margin: 10px 0;
}
.warn {
  margin-top: 12px;
  background: #fdecea;
  color: #b3261e;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  text-align: left;
}
</style>
