# Tool Selection Layer для AI-агента с 1000+ инструментов

## Главная идея

Не давать основной LLM все 1000 инструментов.

Использовать отдельный слой выбора инструментов:

```text
user message
  ↓
intent detector
  ↓
dialog state builder
  ↓
tool router
  ↓
tool retriever
  ↓
tool reranker
  ↓
top-N tools
  ↓
main agent
```

Основной агент получает только 5–15 релевантных инструментов.

---

# Tool Registry

Каждый инструмент хранится как ToolCard.

```ts
type ToolCard = {
  id: string;
  namespace: string;
  domain: string;

  shortDescription: string;
  longDescription: string;

  intents: string[];
  keywords: string[];

  examples: string[];

  requiresContext: boolean;
  requiresAuth: boolean;

  riskLevel: "read" | "write" | "destructive";

  embeddingText: string;
};
```

---

# Dialog State

Не использовать всю историю диалога.

Использовать компактное состояние:

```ts
type DialogState = {
  currentGoal?: string;
  activeIntent?: string;

  mentionedEntities: object;

  lastUsedTools: string[];

  lastToolResultsSummary?: string;

  pendingAction?: string;
};
```

---

# Полный Pipeline

## 1. Intent Detection

Определяем:

- intent
- confidence
- entities
- requiresHistory

Пример:

```json
{
  "intent": "email_forward",
  "confidence": 0.89
}
```

---

## 2. Domain Router

Сначала выбираем домены:

```text
email
calendar
files
crm
database
web
notifications
```

Пример:

```json
{
  "domains": ["email", "contacts"]
}
```

1000 tools → 50-150 tools.

---

## 3. Hard Filters

До нейросетей отбрасываем невозможные инструменты:

- нет авторизации
- отключенный namespace
- destructive операции
- отсутствует контекст

После этого:

```text
1000
→ 300
→ 100
```

---

## 4. Vector Retrieval

Поиск инструментов как документов в RAG.

Запрос:

```text
message
+ intent
+ dialog state
+ entities
```

Результат:

```text
Top 30-80 candidate tools
```

---

## 5. Hybrid Search

Итоговый score:

```text
0.45 vector
0.25 keyword
0.20 intent
0.10 history
```

или похожая формула.

---

## 6. Tool Reranker

Маленькая модель или LLM.

Из 50 кандидатов выбирает 5-15 лучших.

Выход:

```json
{
  "selectedTools": [
    "gmail.forward_email",
    "contacts.search_contacts",
    "gmail.read_email"
  ]
}
```

---

# Dynamic Top-K

Не использовать фиксированное количество.

```text
Высокая уверенность → 3-5 tools

Средняя уверенность → 7-10 tools

Низкая уверенность → 15-20 tools
```

---

# Namespace Hierarchy

Вместо поиска по 1000 инструментам:

```text
gmail
calendar
crm
files
database
```

Сначала выбрать namespace.

Потом инструменты внутри него.

---

# Использование истории

История влияет через:

1. Last Used Tools
2. Active Entity
3. Pending Action
4. Security State

Пример:

```text
Найди письмо
→ gmail.search_emails

Перешли последнее
→ gmail.forward_email
```

---

# Risk Levels

Каждый инструмент имеет уровень риска:

```text
read
write
external_send
financial
destructive
```

Политики безопасности:

```text
destructive
→ подтверждение пользователя

financial
→ подтверждение пользователя

external_send
→ проверка получателя
```

---

# Tool Set вместо одного инструмента

Почти всегда нужен набор инструментов.

Пример:

```text
Назначь встречу Сергею
```

Инструменты:

```text
contacts.search_contacts
calendar.search_events
calendar.create_event
```

---

# Архитектура сервисов

```text
Agent Orchestrator
 ├── Intent Detector
 ├── Dialog State Builder
 ├── Tool Router
 ├── Tool Retriever
 ├── Tool Reranker
 ├── Tool Executor
 └── Memory
```

---

# Кеширование

Три уровня:

## Intent Cache

```text
спасибо
→ NO_TOOL
```

## Tool Retrieval Cache

Ключ:

```text
intent
+ domain
+ entities
```

## Namespace Cache

```text
email_forward
→ gmail + contacts
```

---

# Абстрактные инструменты

Вместо:

```text
gmail.search_emails
outlook.search_messages
imap.search
```

Показывать агенту:

```text
email.search
```

А конкретного провайдера выбирать внутри executor.

---

# Иерархия выбора

```text
Intent
  ↓
Domain
  ↓
Capability
  ↓
Concrete Tool
```

Пример:

```text
Перешли письмо Сергею

↓

email

↓

forward

↓

gmail.forward_email
```

---

# Рекомендуемая архитектура

```text
1000 tools

↓

Domain Router

↓

50-150 tools

↓

Hybrid Retrieval

↓

30-80 tools

↓

Reranker

↓

5-15 tools

↓

Main Agent
```

---

# Главная рекомендация

Никогда не давай LLM выбирать напрямую из 1000 инструментов.

Используй:

```text
Intent Detection
→ Dialog State
→ Domain Routing
→ Hybrid Retrieval
→ Reranker
→ Top-K Tools
→ Main Agent
```

Для production-системы это лучший баланс:

- скорости
- стоимости
- масштабируемости
- качества выбора инструментов
