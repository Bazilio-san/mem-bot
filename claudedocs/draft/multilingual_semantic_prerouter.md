# Multilingual semantic pre-router до LLM

Да, при i18n я бы ушёл от списков слов почти полностью. Тебе нужен не rule-based pre-router, а **дешёвый multilingual semantic router**.

Главная мысль:

> Не определять `это / туда / дальше / ok` на разных языках.  
> А классифицировать сообщение по смыслу:  
> **самостоятельное оно или зависит от прошлого контекста**.

---

# Вариант 1 — multilingual embedding router

Это самый практичный вариант.

Берёшь мультиязычную embedding-модель и сравниваешь короткое сообщение с заранее подготовленными примерами классов.

Например классы:

```ts
type RouteClass =
  | "STATIC_REACTION"       // привет, спасибо, ок, 👍
  | "SELF_CONTAINED"        // самостоятельный вопрос
  | "CONTEXT_DEPENDENT"     // продолжение прошлого диалога
  | "UNCERTAIN";
```

Примеры для `CONTEXT_DEPENDENT` могут быть на разных языках:

```txt
дальше
продолжай
сделай короче
а теперь то же самое
переделай
давай следующий
yes, continue
make it shorter
do the same
weiter
continúa
fais pareil
```

Примеры для `SELF_CONTAINED`:

```txt
что такое redis?
как работает jwt?
explain docker volumes
what is inflation?
cómo funciona redis?
qu'est-ce que le cache?
```

Примеры для `STATIC_REACTION`:

```txt
привет
спасибо
ок
thanks
hi
gracias
merci
👍
```

Дальше на старте приложения ты считаешь embedding для всех примеров, а на входе считаешь embedding нового сообщения и ищешь ближайший класс.

Для этого подходят multilingual Sentence Transformers: например, `paraphrase-multilingual-MiniLM-L12-v2` мапит предложения в 384-мерное векторное пространство, а в документации Sentence Transformers есть отдельные multilingual-модели для semantic similarity.

Схема:

```text
message
  ↓
embedding
  ↓
cosine similarity with class prototypes
  ↓
route decision
```

Пример логики:

```ts
if topClass === "STATIC_REACTION" && score > 0.78:
    return NO_LLM_STATIC_REPLY

if topClass === "SELF_CONTAINED" && score > 0.72:
    return LLM_MINIMAL_NO_HISTORY

if topClass === "CONTEXT_DEPENDENT" && score > 0.68:
    return LLM_WITH_CONTEXT

return LLM_WITH_CONTEXT
```

Важно: лучше использовать не один пример на класс, а **центроиды**.

То есть:

```txt
STATIC_REACTION centroid = средний embedding всех коротких реакций
SELF_CONTAINED centroid = средний embedding самостоятельных вопросов
CONTEXT_DEPENDENT centroid = средний embedding контекстных продолжений
```

И дополнительно смотреть не только `score`, но и `margin`:

```ts
margin = top1.score - top2.score

if margin < 0.08:
  return LLM_WITH_CONTEXT
```

Так ты не будешь ошибаться на пограничных случаях.

---

# Вариант 2 — SetFit classifier

Если хочется уже не similarity, а нормальную маленькую модель-классификатор, я бы смотрел в сторону **SetFit**.

Это способ дообучать Sentence Transformer под классификацию с небольшим количеством размеченных примеров. В документации Hugging Face SetFit описан как prompt-free few-shot framework, который может работать с multilingual Sentence Transformer-моделями.

Твои классы:

```txt
NO_LLM_STATIC_REPLY
LLM_MINIMAL_NO_HISTORY
LLM_WITH_CONTEXT
```

Пример датасета:

```json
{"text": "thanks", "label": "NO_LLM_STATIC_REPLY"}
{"text": "спасибо", "label": "NO_LLM_STATIC_REPLY"}
{"text": "merci", "label": "NO_LLM_STATIC_REPLY"}

{"text": "what is redis?", "label": "LLM_MINIMAL_NO_HISTORY"}
{"text": "что такое jwt?", "label": "LLM_MINIMAL_NO_HISTORY"}
{"text": "explain docker volumes", "label": "LLM_MINIMAL_NO_HISTORY"}

{"text": "make it shorter", "label": "LLM_WITH_CONTEXT"}
{"text": "переделай", "label": "LLM_WITH_CONTEXT"}
{"text": "а теперь то же самое", "label": "LLM_WITH_CONTEXT"}
```

Плюс большой плюс: можно обучить модель на 200–1000 примерах, а дальше дообновлять её на реальных логах.

Я бы делал так:

```text
1. Сначала ручной датасет: 300–500 сообщений.
2. Потом логировать реальные решения.
3. Ошибки докидывать в датасет.
4. Раз в неделю переобучать маленький классификатор.
```

---

# Вариант 3 — multilingual zero-shot NLI classifier

Это вариант без обучения.

Берёшь zero-shot NLI-модель и даёшь ей гипотезы:

```txt
This message is only a greeting or short reaction.
This message is a complete standalone user request.
This message depends on previous conversation context.
```

На вход:

```txt
"сделай короче"
```

Модель должна выбрать:

```txt
This message depends on previous conversation context.
```

Есть multilingual NLI-модели, например `mDeBERTa-v3-base-mnli-xnli`, у которой в карточке указано, что она подходит для multilingual zero-shot classification и поддерживает NLI на 100 языках.

Минус: это обычно медленнее, чем embedding router или SetFit.

Я бы использовал NLI не на каждый запрос, а как **второй слой**, если первый роутер не уверен:

```text
embedding router уверен
→ сразу решение

embedding router не уверен
→ NLI classifier

NLI тоже не уверен
→ LLM_WITH_CONTEXT
```

---

# Вариант 4 — маленький локальный LLM как router

Можно использовать маленькую локальную модель и просить её вернуть строгий JSON:

```json
{
  "route": "LLM_WITH_CONTEXT",
  "confidence": 0.91,
  "reason": "The message asks to modify previous output."
}
```

Например, можно смотреть в сторону маленьких Qwen-моделей. У Qwen3 есть модель 0.6B, а в описании серии заявлены multilingual capabilities и instruction-following.

Но для pre-router это часто избыточно.

Я бы использовал маленький LLM только так:

```text
дешёвый embedding / SetFit router
→ если confidence низкий
→ маленький LLM-router
→ если всё равно непонятно
→ full context
```

Почему не первым слоем? Потому что даже маленький LLM дороже и медленнее, чем embedding/classifier.

---

# Вариант 5 — language detection + local intent model

Можно отдельно определять язык, но я бы не делал это главным механизмом.

Language detection полезен для:

```text
- выбора языка статического ответа;
- аналитики;
- отдельных порогов по языкам;
- fallback на минимальный LLM, если язык плохо поддержан.
```

Например, fastText language identification models умеют распознавать 176 языков.

Но сам по себе language detection не решает задачу. Он скажет:

```json
{"lang": "es"}
```

А тебе нужно:

```json
{"route": "LLM_WITH_CONTEXT"}
```

Поэтому правильнее:

```text
language detector — вспомогательный модуль
semantic router — основной модуль
```

---

# Какой вариант я бы выбрал

Я бы сделал так:

```text
1. Embedding router
   быстрый, мультиязычный, без обучения

2. SetFit classifier
   когда накопишь датасет

3. Small LLM fallback
   только для серой зоны

4. Full context
   если router не уверен
```

Итоговая схема:

```text
user message
  ↓
normalize only technically
  ↓
language id, optional
  ↓
multilingual embedding router
  ↓
if confident:
      route
  else:
      SetFit / NLI / small LLM classifier
  ↓
if still uncertain:
      LLM_WITH_CONTEXT
```

---

# Конкретная архитектура

```ts
type PreRouterResult = {
  route:
    | "NO_LLM_STATIC_REPLY"
    | "LLM_MINIMAL_NO_HISTORY"
    | "LLM_WITH_CONTEXT";

  intent?:
    | "greeting"
    | "thanks"
    | "ack"
    | "standalone_question"
    | "context_followup"
    | "edit_previous"
    | "continue_previous";

  lang?: string;
  confidence: number;
  reason: string;
};
```

Пример результата:

```json
{
  "route": "LLM_WITH_CONTEXT",
  "intent": "edit_previous",
  "lang": "ru",
  "confidence": 0.87,
  "reason": "Message is semantically close to requests that modify previous assistant output."
}
```

---

# Минимальный рабочий вариант

## Шаг 1. Подготовить seed examples

```ts
const examples = [
  {
    text: "привет",
    route: "NO_LLM_STATIC_REPLY",
    intent: "greeting"
  },
  {
    text: "thanks",
    route: "NO_LLM_STATIC_REPLY",
    intent: "thanks"
  },
  {
    text: "what is redis?",
    route: "LLM_MINIMAL_NO_HISTORY",
    intent: "standalone_question"
  },
  {
    text: "что такое redis?",
    route: "LLM_MINIMAL_NO_HISTORY",
    intent: "standalone_question"
  },
  {
    text: "сделай короче",
    route: "LLM_WITH_CONTEXT",
    intent: "edit_previous"
  },
  {
    text: "make it shorter",
    route: "LLM_WITH_CONTEXT",
    intent: "edit_previous"
  },
  {
    text: "continue",
    route: "LLM_WITH_CONTEXT",
    intent: "continue_previous"
  },
  {
    text: "давай следующий",
    route: "LLM_WITH_CONTEXT",
    intent: "continue_previous"
  }
];
```

## Шаг 2. Посчитать embedding для каждого примера

На старте сервиса:

```ts
const indexedExamples = await Promise.all(
  examples.map(async item => ({
    ...item,
    embedding: await embed(item.text)
  }))
);
```

## Шаг 3. На входе сравнить сообщение с примерами

```ts
async function routeMessage(message: string): Promise<PreRouterResult> {
  const embedding = await embed(message);

  const scored = indexedExamples
    .map(item => ({
      ...item,
      score: cosineSimilarity(embedding, item.embedding)
    }))
    .sort((a, b) => b.score - a.score);

  const top1 = scored[0];
  const top2 = scored[1];

  const margin = top1.score - top2.score;

  if (top1.score < 0.62 || margin < 0.05) {
    return {
      route: "LLM_WITH_CONTEXT",
      confidence: top1.score,
      reason: "Low confidence or low margin"
    };
  }

  return {
    route: top1.route,
    intent: top1.intent,
    confidence: top1.score,
    reason: `Nearest semantic example: "${top1.text}"`
  };
}
```

---

# Как сделать статические ответы при i18n

Не хардкодить фразы в логике. Роутер должен вернуть только intent:

```json
{
  "route": "NO_LLM_STATIC_REPLY",
  "intent": "thanks",
  "lang": "fr"
}
```

А ответ брать из i18n-файла:

```json
{
  "ru": {
    "greeting": "Привет!",
    "thanks": "Пожалуйста!",
    "ack": "Окей."
  },
  "en": {
    "greeting": "Hi!",
    "thanks": "You're welcome!",
    "ack": "Okay."
  },
  "fr": {
    "greeting": "Salut !",
    "thanks": "Avec plaisir !",
    "ack": "D'accord."
  }
}
```

Если языка нет:

```ts
if (!i18n[lang]?.[intent]) {
  return "LLM_MINIMAL_NO_HISTORY";
}
```

---

# Как оптимизировать по скорости

Модель лучше вынести в отдельный microservice:

```text
Node.js backend
  ↓ HTTP / gRPC
Python router service
  ↓
ONNX / PyTorch model
```

Для production можно экспортировать модель в ONNX и квантовать. ONNX Runtime официально поддерживает конвертацию FP32-моделей в INT8 через quantization API, а также имеет отдельные оптимизации для transformer-моделей.

Схема:

```text
SentenceTransformer / SetFit
  ↓
export to ONNX
  ↓
INT8 quantization
  ↓
router service
  ↓
cache embeddings for repeated short messages
```

Для коротких сообщений кеш даст много:

```txt
"ок"
"спасибо"
"да"
"continue"
"thanks"
"make it shorter"
```

---

# Что логировать

Обязательно логируй:

```json
{
  "message": "сделай короче",
  "route": "LLM_WITH_CONTEXT",
  "intent": "edit_previous",
  "confidence": 0.84,
  "model": "multilingual-minilm-router-v1",
  "fallbackUsed": false
}
```

Потом можно собрать ошибки:

```json
{
  "message": "давай",
  "predicted": "NO_LLM_STATIC_REPLY",
  "actual": "LLM_WITH_CONTEXT"
}
```

И докинуть их в обучение.

---

# Лучший итоговый вариант для тебя

Я бы не делал один pre-router. Я бы сделал **каскад**:

```text
Layer 1: cache
- если сообщение уже встречалось → готовое решение

Layer 2: multilingual embedding router
- дешево и быстро
- работает с i18n
- не требует обучения на старте

Layer 3: SetFit classifier
- когда накопятся реальные данные
- лучше ловит твои конкретные кейсы

Layer 4: small LLM / NLI fallback
- только если confidence низкий

Layer 5: safe default
- если сомневаемся → LLM_WITH_CONTEXT
```

Самая рабочая формула:

```text
cache → embeddings → SetFit → fallback classifier → full context
```

Это даст экономию, но не привяжет тебя к русскому/английскому словарю.
