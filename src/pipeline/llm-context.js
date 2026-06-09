// Контекст корреляции для логирования LLM-запросов. Через AsyncLocalStorage из стандартного модуля
// node:async_hooks внутри src/llm.js доступны метаданные текущего хода диалога (пользователь, разговор,
// домен, канал, тип запроса) без протаскивания параметров через каждую функцию.
import { AsyncLocalStorage } from 'node:async_hooks';

// Хранилище метаданных текущего хода диалога. Значение — изменяемый объект:
// { requestId, userId, conversationId, domainKey, channel, kind }.
export const llmContext = new AsyncLocalStorage();

// Выполнить fn внутри хранилища с метаданными meta. Все асинхронные обращения к LLM, начатые внутри fn,
// увидят эти метаданные через getLlmContext(). Объект meta изменяемый: его поля можно дополнять по мере
// появления данных (например, userId и conversationId становятся известны не сразу).
export function runWithLlmContext(meta, fn) {
  return llmContext.run(meta || {}, fn);
}

// Вернуть метаданные текущего хода диалога или пустой объект, если контекст не установлен (например, для
// разовых эмбеддингов при админском наполнении базы — тогда user_id/conversation_id будут NULL).
export function getLlmContext() {
  return llmContext.getStore() || {};
}
