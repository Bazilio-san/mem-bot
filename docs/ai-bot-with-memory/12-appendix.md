# 12. Источники и раскладка кода

## Вкратце

Здесь собраны внешние источники, на которые опирается архитектура, и рекомендации по раскладке кода. Документ носит
нормативный и справочный характер: он не привязан к конкретному проекту и не содержит сведений о статусе реализации.

---

## Внешняя документация

Официальная документация OpenAI (актуальные модели и цены проверять перед продакшеном):

- Каталог моделей OpenAI API: https://developers.openai.com/api/docs/models/all
- Страница цен OpenAI API: https://openai.com/api/pricing/
- Function calling / tool calling: https://developers.openai.com/api/docs/guides/function-calling
- Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- Tools overview: https://developers.openai.com/api/docs/guides/tools
- Embeddings guide: https://developers.openai.com/api/docs/guides/embeddings

Протокол подключения внешних инструментов:

- Спецификация Model Context Protocol (MCP): https://modelcontextprotocol.io
- Транспорт Streamable HTTP (потоковый HTTP): https://modelcontextprotocol.io/docs/concepts/transports

---

## Рекомендованная раскладка кода

Рекомендованная раскладка кода: исходный код — каталог `src/`; миграции схемы памяти — каталог `migrations/`; реестр
skills (по каталогу на домен) — каталог `skills/`; проверки по слоям — каталог `tests/`.

---

## Связанные документы

- Конфигурация и выбор моделей — [08-prompts-and-models.md](08-prompts-and-models.md)
- Проверки и тесты — [10-operations.md](10-operations.md)
- Поджатие истории диалога — [13-history-compression.md](13-history-compression.md)
- Вернуться ко входу — [README.md](README.md)
