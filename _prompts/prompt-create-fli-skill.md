Посмотри на проект D:\DEV\VENDOR\fli 
Надо создать skill, который помогает использовать это решение либо как MCP,
либо как составляющую часть python или TS проекта через программное API через Agent tool, 
либо через CLI в случае Claude Code или Codex.

Проанализируй весь репозиторий D:\DEV\VENDOR\fl и создай Skill для Claude Code. Разбей знания на:
* overview
* architecture
* python api
* typescript api
* mcp
* cli
* examples
* limitations

Скилл должен быть progressive disclosure.

Примерная организация файлов:

skills/
└── fli-flight-search/
    ├── SKILL.md
    ├── docs/
    │   ├── overview.md
    │   ├── python-api.md
    │   ├── typescript-api.md
    │   ├── mcp.md
    │   ├── cli.md
    │   ├── limitations.md
    │   └── examples.md
    └── examples/
        ├── search_flights.py
        ├── search_dates.py
        └── claude_mcp_config.json

Дока по SKILL: docs/anthropic-skills.md
