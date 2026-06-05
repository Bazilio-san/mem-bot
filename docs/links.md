# https://github.com/pydantic/skills?utm_source=chatgpt.com

## Install In Claude Code

Add this marketplace to Claude Code:

```
claude plugin marketplace add pydantic/skills
```

Then install a plugin:

```
claude plugin install logfire@pydantic-skills
claude plugin install ai@pydantic-skills
claude plugin install pydantic-ai-harness@pydantic-skills
```

## Install In Codex

Add the published Pydantic marketplace to Codex:

```bash
codex plugin marketplace add pydantic/skills
```

Then open Codex's plugin UI and enable the plugins you want from the **Pydantic** marketplace:

- **Logfire** - installs Logfire skills and the hosted Logfire MCP server.
- **Logfire Exporter** - installs Codex lifecycle hooks that export completed Codex turns and tool calls to Logfire.

Configure **Logfire Exporter** with a Logfire write token in your environment or
`${XDG_CONFIG_HOME:-~/.config}/logfire-exporter/config.env`. Restart Codex after configuration, and run `/hooks` if
Codex asks you to review or trust the new hooks.

To use the EU Logfire MCP endpoint in Codex without editing plugin files, replace the MCP entry and re-authenticate:

```bash
codex mcp remove logfire
codex mcp add logfire --url https://logfire-eu.pydantic.dev/mcp
codex mcp login logfire
codex mcp get logfire
```

Start a new Codex conversation after switching so the MCP tools reload.dantic-skills

# 

скаячай в .claude скилл telegram-bot-builder отсюда
https://github.com/davila7/claude-code-templates/tree/main/cli-tool/components/skills/development/telegram-bot-builder