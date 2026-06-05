# Skills for Claude: Combined Guide

> This document combines two sources:
> - **Part 1**: Official Claude Code documentation — [Extend Claude with skills](https://code.claude.com/docs/en/skills)
> - **Part 2**: "The Complete Guide to Building Skills for Claude" (Anthropic PDF guide)

---

# Part 1: Extend Claude with skills

> Create, manage, and share skills to extend Claude's capabilities in Claude Code. Includes custom commands and bundled skills.

Skills extend what Claude can do. Create a `SKILL.md` file with instructions, and Claude adds it to its toolkit. Claude uses skills when relevant, or you can invoke one directly with `/skill-name`.

Create a skill when you keep pasting the same playbook, checklist, or multi-step procedure into chat, or when a section of CLAUDE.md has grown into a procedure rather than a fact. Unlike CLAUDE.md content, a skill's body loads only when it's used, so long reference material costs almost nothing until you need it.

> **Note:** For built-in commands like `/help` and `/compact`, and bundled skills like `/debug` and `/simplify`, see the [commands reference](https://code.claude.com/docs/en/commands).
>
> **Custom commands have been merged into skills.** A file at `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same way. Your existing `.claude/commands/` files keep working. Skills add optional features: a directory for supporting files, frontmatter to control whether you or Claude invokes them, and the ability for Claude to load them automatically when relevant.

Claude Code skills follow the [Agent Skills](https://agentskills.io) open standard, which works across multiple AI tools. Claude Code extends the standard with additional features like invocation control, subagent execution, and dynamic context injection.

## Bundled skills

Claude Code includes a set of bundled skills that are available in every session, including `/simplify`, `/batch`, `/debug`, `/loop`, and `/claude-api`. Unlike built-in commands, which execute fixed logic directly, bundled skills are prompt-based: they give Claude a detailed playbook and let it orchestrate the work using its tools. You invoke them the same way as any other skill, by typing `/` followed by the skill name.

Bundled skills are listed alongside built-in commands in the [commands reference](https://code.claude.com/docs/en/commands), marked **Skill** in the Purpose column.

## Getting started

### Create your first skill

This example creates a skill that teaches Claude to explain code using visual diagrams and analogies. Since it uses default frontmatter, Claude can load it automatically when you ask how something works, or you can invoke it directly with `/explain-code`.

**Step 1: Create the skill directory**

Create a directory for the skill in your personal skills folder. Personal skills are available across all your projects.

```bash
mkdir -p ~/.claude/skills/explain-code
```

**Step 2: Write SKILL.md**

Every skill needs a `SKILL.md` file with two parts: YAML frontmatter (between `---` markers) that tells Claude when to use the skill, and markdown content with instructions Claude follows when the skill is invoked. The `name` field becomes the `/slash-command`, and the `description` helps Claude decide when to load it automatically.

Create `~/.claude/skills/explain-code/SKILL.md`:

```yaml
---
name: explain-code
description: Explains code with visual diagrams and analogies. Use when explaining how code works, teaching about a codebase, or when the user asks "how does this work?"
---

When explaining code, always include:

1. **Start with an analogy**: Compare the code to something from everyday life
2. **Draw a diagram**: Use ASCII art to show the flow, structure, or relationships
3. **Walk through the code**: Explain step-by-step what happens
4. **Highlight a gotcha**: What's a common mistake or misconception?

Keep explanations conversational. For complex concepts, use multiple analogies.
```

**Step 3: Test the skill**

You can test it two ways:

**Let Claude invoke it automatically** by asking something that matches the description:

```
How does this code work?
```

**Or invoke it directly** with the skill name:

```
/explain-code src/auth/login.ts
```

Either way, Claude should include an analogy and ASCII diagram in its explanation.

### Where skills live

Where you store a skill determines who can use it:

| Location   | Path                                                | Applies to                     |
|:-----------|:----------------------------------------------------|:-------------------------------|
| Enterprise | See [managed settings](https://code.claude.com/docs/en/settings#settings-files) | All users in your organization |
| Personal   | `~/.claude/skills/<skill-name>/SKILL.md`            | All your projects              |
| Project    | `.claude/skills/<skill-name>/SKILL.md`              | This project only              |
| Plugin     | `<plugin>/skills/<skill-name>/SKILL.md`             | Where plugin is enabled        |

When skills share the same name across levels, higher-priority locations win: enterprise > personal > project. Plugin skills use a `plugin-name:skill-name` namespace, so they cannot conflict with other levels. If you have files in `.claude/commands/`, those work the same way, but if a skill and a command share the same name, the skill takes precedence.

#### Live change detection

Claude Code watches skill directories for file changes. Adding, editing, or removing a skill under `~/.claude/skills/`, the project `.claude/skills/`, or a `.claude/skills/` inside an `--add-dir` directory takes effect within the current session without restarting. Creating a top-level skills directory that did not exist when the session started requires restarting Claude Code so the new directory can be watched.

#### Automatic discovery from nested directories

When you work with files in subdirectories, Claude Code automatically discovers skills from nested `.claude/skills/` directories. For example, if you're editing a file in `packages/frontend/`, Claude Code also looks for skills in `packages/frontend/.claude/skills/`. This supports monorepo setups where packages have their own skills.

Each skill is a directory with `SKILL.md` as the entrypoint:

```
my-skill/
├── SKILL.md           # Main instructions (required)
├── template.md        # Template for Claude to fill in
├── examples/
│   └── sample.md      # Example output showing expected format
└── scripts/
    └── validate.sh    # Script Claude can execute
```

The `SKILL.md` contains the main instructions and is required. Other files are optional and let you build more powerful skills: templates for Claude to fill in, example outputs showing the expected format, scripts Claude can execute, or detailed reference documentation. Reference these files from your `SKILL.md` so Claude knows what they contain and when to load them. See [Add supporting files](#add-supporting-files) for more details.

> Files in `.claude/commands/` still work and support the same frontmatter. Skills are recommended since they support additional features like supporting files.

#### Skills from additional directories

The `--add-dir` flag grants file access rather than configuration discovery, but skills are an exception: `.claude/skills/` within an added directory is loaded automatically. See [Live change detection](#live-change-detection) for how edits are picked up during a session.

Other `.claude/` configuration such as subagents, commands, and output styles is not loaded from additional directories.

> CLAUDE.md files from `--add-dir` directories are not loaded by default. To load them, set `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.

## Configure skills

Skills are configured through YAML frontmatter at the top of `SKILL.md` and the markdown content that follows.

### Types of skill content

Skill files can contain any instructions, but thinking about how you want to invoke them helps guide what to include:

**Reference content** adds knowledge Claude applies to your current work. Conventions, patterns, style guides, domain knowledge. This content runs inline so Claude can use it alongside your conversation context.

```yaml
---
name: api-conventions
description: API design patterns for this codebase
---

When writing API endpoints:
- Use RESTful naming conventions
- Return consistent error formats
- Include request validation
```

**Task content** gives Claude step-by-step instructions for a specific action, like deployments, commits, or code generation. These are often actions you want to invoke directly with `/skill-name` rather than letting Claude decide when to run them. Add `disable-model-invocation: true` to prevent Claude from triggering it automatically.

```yaml
---
name: deploy
description: Deploy the application to production
context: fork
disable-model-invocation: true
---

Deploy the application:
1. Run the test suite
2. Build the application
3. Push to the deployment target
```

### Frontmatter reference

Beyond the markdown content, you can configure skill behavior using YAML frontmatter fields between `---` markers at the top of your `SKILL.md` file:

```yaml
---
name: my-skill
description: What this skill does
disable-model-invocation: true
allowed-tools: Read Grep
---

Your skill instructions here...
```

All fields are optional. Only `description` is recommended so Claude knows when to use the skill.

| Field                      | Required    | Description                                                                                                                                                                                                                                                                                                         |
|:---------------------------|:------------|:--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `name`                     | No          | Display name for the skill. If omitted, uses the directory name. Lowercase letters, numbers, and hyphens only (max 64 characters).                                                                                                                                                                                  |
| `description`              | Recommended | What the skill does and when to use it. Claude uses this to decide when to apply the skill. If omitted, uses the first paragraph of markdown content. Front-load the key use case: the combined `description` and `when_to_use` text is truncated at 1,536 characters in the skill listing to reduce context usage. |
| `when_to_use`              | No          | Additional context for when Claude should invoke the skill, such as trigger phrases or example requests. Appended to `description` in the skill listing and counts toward the 1,536-character cap.                                                                                                                  |
| `argument-hint`            | No          | Hint shown during autocomplete to indicate expected arguments. Example: `[issue-number]` or `[filename] [format]`.                                                                                                                                                                                                  |
| `disable-model-invocation` | No          | Set to `true` to prevent Claude from automatically loading this skill. Use for workflows you want to trigger manually with `/name`. Default: `false`.                                                                                                                                                               |
| `user-invocable`           | No          | Set to `false` to hide from the `/` menu. Use for background knowledge users shouldn't invoke directly. Default: `true`.                                                                                                                                                                                            |
| `allowed-tools`            | No          | Tools Claude can use without asking permission when this skill is active. Accepts a space-separated string or a YAML list.                                                                                                                                                                                          |
| `model`                    | No          | Model to use when this skill is active.                                                                                                                                                                                                                                                                             |
| `effort`                   | No          | Effort level when this skill is active. Overrides the session effort level. Default: inherits from session. Options: `low`, `medium`, `high`, `max` (Opus 4.6 only).                                                                                                                                                |
| `context`                  | No          | Set to `fork` to run in a forked subagent context.                                                                                                                                                                                                                                                                  |
| `agent`                    | No          | Which subagent type to use when `context: fork` is set.                                                                                                                                                                                                                                                             |
| `hooks`                    | No          | Hooks scoped to this skill's lifecycle. See [Hooks in skills and agents](https://code.claude.com/docs/en/hooks#hooks-in-skills-and-agents) for configuration format.                                                                                                                                                |
| `paths`                    | No          | Glob patterns that limit when this skill is activated. Accepts a comma-separated string or a YAML list. When set, Claude loads the skill automatically only when working with files matching the patterns.                                                                                                           |
| `shell`                    | No          | Shell to use for `` !`command` `` and ` ```! ` blocks in this skill. Accepts `bash` (default) or `powershell`. Setting `powershell` runs inline shell commands via PowerShell on Windows. Requires `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`.                                                                             |

#### Available string substitutions

Skills support string substitution for dynamic values in the skill content:

| Variable               | Description                                                                                                                                                                                                                                                                              |
|:-----------------------|:-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `$ARGUMENTS`           | All arguments passed when invoking the skill. If `$ARGUMENTS` is not present in the content, arguments are appended as `ARGUMENTS: <value>`.                                                                                                                                             |
| `$ARGUMENTS[N]`        | Access a specific argument by 0-based index, such as `$ARGUMENTS[0]` for the first argument.                                                                                                                                                                                             |
| `$N`                   | Shorthand for `$ARGUMENTS[N]`, such as `$0` for the first argument or `$1` for the second.                                                                                                                                                                                               |
| `${CLAUDE_SESSION_ID}` | The current session ID. Useful for logging, creating session-specific files, or correlating skill output with sessions.                                                                                                                                                                  |
| `${CLAUDE_SKILL_DIR}`  | The directory containing the skill's `SKILL.md` file. For plugin skills, this is the skill's subdirectory within the plugin, not the plugin root. Use this in bash injection commands to reference scripts or files bundled with the skill, regardless of the current working directory. |

Indexed arguments use shell-style quoting, so wrap multi-word values in quotes to pass them as a single argument. For example, `/my-skill "hello world" second` makes `$0` expand to `hello world` and `$1` to `second`. The `$ARGUMENTS` placeholder always expands to the full argument string as typed.

**Example using substitutions:**

```yaml
---
name: session-logger
description: Log activity for this session
---

Log the following to logs/${CLAUDE_SESSION_ID}.log:

$ARGUMENTS
```

### Add supporting files

Skills can include multiple files in their directory. This keeps `SKILL.md` focused on the essentials while letting Claude access detailed reference material only when needed. Large reference docs, API specifications, or example collections don't need to load into context every time the skill runs.

```
my-skill/
├── SKILL.md (required - overview and navigation)
├── reference.md (detailed API docs - loaded when needed)
├── examples.md (usage examples - loaded when needed)
└── scripts/
    └── helper.py (utility script - executed, not loaded)
```

Reference supporting files from `SKILL.md` so Claude knows what each file contains and when to load it:

```markdown
## Additional resources

- For complete API details, see [reference.md](reference.md)
- For usage examples, see [examples.md](examples.md)
```

> **Tip:** Keep `SKILL.md` under 500 lines. Move detailed reference material to separate files.

### Control who invokes a skill

By default, both you and Claude can invoke any skill. You can type `/skill-name` to invoke it directly, and Claude can load it automatically when relevant to your conversation. Two frontmatter fields let you restrict this:

* **`disable-model-invocation: true`**: Only you can invoke the skill. Use this for workflows with side effects or that you want to control timing, like `/commit`, `/deploy`, or `/send-slack-message`. You don't want Claude deciding to deploy because your code looks ready.

* **`user-invocable: false`**: Only Claude can invoke the skill. Use this for background knowledge that isn't actionable as a command. A `legacy-system-context` skill explains how an old system works. Claude should know this when relevant, but `/legacy-system-context` isn't a meaningful action for users to take.

This example creates a deploy skill that only you can trigger:

```yaml
---
name: deploy
description: Deploy the application to production
disable-model-invocation: true
---

Deploy $ARGUMENTS to production:

1. Run the test suite
2. Build the application
3. Push to the deployment target
4. Verify the deployment succeeded
```

Here's how the two fields affect invocation and context loading:

| Frontmatter                      | You can invoke | Claude can invoke | When loaded into context                                     |
|:---------------------------------|:---------------|:------------------|:-------------------------------------------------------------|
| (default)                        | Yes            | Yes               | Description always in context, full skill loads when invoked |
| `disable-model-invocation: true` | Yes            | No                | Description not in context, full skill loads when you invoke |
| `user-invocable: false`          | No             | Yes               | Description always in context, full skill loads when invoked |

> In a regular session, skill descriptions are loaded into context so Claude knows what's available, but full skill content only loads when invoked. Subagents with preloaded skills work differently: the full skill content is injected at startup.

### Skill content lifecycle

When you or Claude invoke a skill, the rendered `SKILL.md` content enters the conversation as a single message and stays there for the rest of the session. Claude Code does not re-read the skill file on later turns, so write guidance that should apply throughout a task as standing instructions rather than one-time steps.

Auto-compaction carries invoked skills forward within a token budget. When the conversation is summarized to free context, Claude Code re-attaches the most recent invocation of each skill after the summary, keeping the first 5,000 tokens of each. Re-attached skills share a combined budget of 25,000 tokens. Claude Code fills this budget starting from the most recently invoked skill, so older skills can be dropped entirely after compaction if you have invoked many in one session.

If a skill seems to stop influencing behavior after the first response, the content is usually still present and the model is choosing other tools or approaches. Strengthen the skill's `description` and instructions so the model keeps preferring it, or use hooks to enforce behavior deterministically. If the skill is large or you invoked several others after it, re-invoke it after compaction to restore the full content.

### Pre-approve tools for a skill

The `allowed-tools` field grants permission for the listed tools while the skill is active, so Claude can use them without prompting you for approval. It does not restrict which tools are available: every tool remains callable, and your permission settings still govern tools that are not listed.

This skill lets Claude run git commands without per-use approval whenever you invoke it:

```yaml
---
name: commit
description: Stage and commit the current changes
disable-model-invocation: true
allowed-tools: Bash(git add *) Bash(git commit *) Bash(git status *)
---
```

To block a skill from using certain tools, add deny rules in your permission settings instead.

### Pass arguments to skills

Both you and Claude can pass arguments when invoking a skill. Arguments are available via the `$ARGUMENTS` placeholder.

This skill fixes a GitHub issue by number:

```yaml
---
name: fix-issue
description: Fix a GitHub issue
disable-model-invocation: true
---

Fix GitHub issue $ARGUMENTS following our coding standards.

1. Read the issue description
2. Understand the requirements
3. Implement the fix
4. Write tests
5. Create a commit
```

When you run `/fix-issue 123`, Claude receives "Fix GitHub issue 123 following our coding standards..."

If you invoke a skill with arguments but the skill doesn't include `$ARGUMENTS`, Claude Code appends `ARGUMENTS: <your input>` to the end of the skill content so Claude still sees what you typed.

To access individual arguments by position, use `$ARGUMENTS[N]` or the shorter `$N`:

```yaml
---
name: migrate-component
description: Migrate a component from one framework to another
---

Migrate the $ARGUMENTS[0] component from $ARGUMENTS[1] to $ARGUMENTS[2].
Preserve all existing behavior and tests.
```

Running `/migrate-component SearchBar React Vue` replaces `$ARGUMENTS[0]` with `SearchBar`, `$ARGUMENTS[1]` with `React`, and `$ARGUMENTS[2]` with `Vue`. The same skill using the `$N` shorthand:

```yaml
---
name: migrate-component
description: Migrate a component from one framework to another
---

Migrate the $0 component from $1 to $2.
Preserve all existing behavior and tests.
```

## Advanced patterns

### Inject dynamic context

The `` !`<command>` `` syntax runs shell commands before the skill content is sent to Claude. The command output replaces the placeholder, so Claude receives actual data, not the command itself.

This skill summarizes a pull request by fetching live PR data with the GitHub CLI:

```yaml
---
name: pr-summary
description: Summarize changes in a pull request
context: fork
agent: Explore
allowed-tools: Bash(gh *)
---

## Pull request context
- PR diff: !`gh pr diff`
- PR comments: !`gh pr view --comments`
- Changed files: !`gh pr diff --name-only`

## Your task
Summarize this pull request...
```

When this skill runs:

1. Each `` !`<command>` `` executes immediately (before Claude sees anything)
2. The output replaces the placeholder in the skill content
3. Claude receives the fully-rendered prompt with actual PR data

This is preprocessing, not something Claude executes. Claude only sees the final result.

For multi-line commands, use a fenced code block opened with `` ```! `` instead of the inline form:

````markdown
## Environment
```!
node --version
npm --version
git status --short
```
````

To disable this behavior, set `"disableSkillShellExecution": true` in settings. Each command is replaced with `[shell command execution disabled by policy]` instead of being run. Bundled and managed skills are not affected.

> **Tip:** To enable extended thinking in a skill, include the word "ultrathink" anywhere in your skill content.

### Run skills in a subagent

Add `context: fork` to your frontmatter when you want a skill to run in isolation. The skill content becomes the prompt that drives the subagent. It won't have access to your conversation history.

> **Warning:** `context: fork` only makes sense for skills with explicit instructions. If your skill contains guidelines like "use these API conventions" without a task, the subagent receives the guidelines but no actionable prompt, and returns without meaningful output.

Skills and subagents work together in two directions:

| Approach                     | System prompt                             | Task                        | Also loads                   |
|:-----------------------------|:------------------------------------------|:----------------------------|:-----------------------------|
| Skill with `context: fork`   | From agent type (`Explore`, `Plan`, etc.) | SKILL.md content            | CLAUDE.md                    |
| Subagent with `skills` field | Subagent's markdown body                  | Claude's delegation message | Preloaded skills + CLAUDE.md |

With `context: fork`, you write the task in your skill and pick an agent type to execute it. For the inverse (defining a custom subagent that uses skills as reference material), see [Subagents](https://code.claude.com/docs/en/sub-agents#preload-skills-into-subagents).

#### Example: Research skill using Explore agent

This skill runs research in a forked Explore agent:

```yaml
---
name: deep-research
description: Research a topic thoroughly
context: fork
agent: Explore
---

Research $ARGUMENTS thoroughly:

1. Find relevant files using Glob and Grep
2. Read and analyze the code
3. Summarize findings with specific file references
```

When this skill runs:

1. A new isolated context is created
2. The subagent receives the skill content as its prompt
3. The `agent` field determines the execution environment (model, tools, and permissions)
4. Results are summarized and returned to your main conversation

The `agent` field specifies which subagent configuration to use. Options include built-in agents (`Explore`, `Plan`, `general-purpose`) or any custom subagent from `.claude/agents/`. If omitted, uses `general-purpose`.

### Restrict Claude's skill access

By default, Claude can invoke any skill that doesn't have `disable-model-invocation: true` set. Three ways to control which skills Claude can invoke:

**Disable all skills** by denying the Skill tool in `/permissions`:

```
# Add to deny rules:
Skill
```

**Allow or deny specific skills** using permission rules:

```
# Allow only specific skills
Skill(commit)
Skill(review-pr *)

# Deny specific skills
Skill(deploy *)
```

Permission syntax: `Skill(name)` for exact match, `Skill(name *)` for prefix match with any arguments.

**Hide individual skills** by adding `disable-model-invocation: true` to their frontmatter.

> The `user-invocable` field only controls menu visibility, not Skill tool access. Use `disable-model-invocation: true` to block programmatic invocation.

## Share skills

Skills can be distributed at different scopes depending on your audience:

* **Project skills**: Commit `.claude/skills/` to version control
* **Plugins**: Create a `skills/` directory in your plugin
* **Managed**: Deploy organization-wide through managed settings

### Generate visual output

Skills can bundle and run scripts in any language, giving Claude capabilities beyond what's possible in a single prompt. One powerful pattern is generating visual output: interactive HTML files that open in your browser for exploring data, debugging, or creating reports.

This example creates a codebase explorer: an interactive tree view where you can expand and collapse directories, see file sizes at a glance, and identify file types by color.

Create the Skill directory:

```bash
mkdir -p ~/.claude/skills/codebase-visualizer/scripts
```

Create `~/.claude/skills/codebase-visualizer/SKILL.md`:

````yaml
---
name: codebase-visualizer
description: Generate an interactive collapsible tree visualization of your codebase. Use when exploring a new repo, understanding project structure, or identifying large files.
allowed-tools: Bash(python *)
---

# Codebase Visualizer

Generate an interactive HTML tree view that shows your project's file structure with collapsible directories.

## Usage

Run the visualization script from your project root:

```bash
python ~/.claude/skills/codebase-visualizer/scripts/visualize.py .
```

This creates `codebase-map.html` in the current directory and opens it in your default browser.

## What the visualization shows

- **Collapsible directories**: Click folders to expand/collapse
- **File sizes**: Displayed next to each file
- **Colors**: Different colors for different file types
- **Directory totals**: Shows aggregate size of each folder
````

Create `~/.claude/skills/codebase-visualizer/scripts/visualize.py` (Python script that scans a directory tree and generates a self-contained HTML file with a summary sidebar, bar chart by file type, and collapsible tree with color-coded file type indicators). The script requires Python but uses only built-in libraries.

This pattern works for any visual output: dependency graphs, test coverage reports, API documentation, or database schema visualizations. The bundled script does the heavy lifting while Claude handles orchestration.

## Troubleshooting

### Skill not triggering

If Claude doesn't use your skill when expected:

1. Check the description includes keywords users would naturally say
2. Verify the skill appears in `What skills are available?`
3. Try rephrasing your request to match the description more closely
4. Invoke it directly with `/skill-name` if the skill is user-invocable

### Skill triggers too often

If Claude uses your skill when you don't want it:

1. Make the description more specific
2. Add `disable-model-invocation: true` if you only want manual invocation

### Skill descriptions are cut short

Skill descriptions are loaded into context so Claude knows what's available. All skill names are always included, but if you have many skills, descriptions are shortened to fit the character budget, which can strip the keywords Claude needs to match your request. The budget scales dynamically at 1% of the context window, with a fallback of 8,000 characters.

To raise the limit, set the `SLASH_COMMAND_TOOL_CHAR_BUDGET` environment variable. Or trim the `description` and `when_to_use` text at the source: front-load the key use case, since each entry's combined text is capped at 1,536 characters regardless of budget.

## Related resources

* **[Subagents](https://code.claude.com/docs/en/sub-agents)**: delegate tasks to specialized agents
* **[Plugins](https://code.claude.com/docs/en/plugins)**: package and distribute skills with other extensions
* **[Hooks](https://code.claude.com/docs/en/hooks)**: automate workflows around tool events
* **[Memory](https://code.claude.com/docs/en/memory)**: manage CLAUDE.md files for persistent context
* **[Commands](https://code.claude.com/docs/en/commands)**: reference for built-in commands and bundled skills
* **[Permissions](https://code.claude.com/docs/en/permissions)**: control tool and skill access

---

# Part 2: The Complete Guide to Building Skills for Claude

> Source: Anthropic PDF guide "The Complete Guide to Building Skills for Claude"

## Introduction

A **skill** is a set of instructions - packaged as a simple folder - that teaches Claude how to handle specific tasks or workflows. Skills are one of the most powerful ways to customize Claude for your specific needs. Instead of re-explaining your preferences, processes, and domain expertise in every conversation, skills let you teach Claude once and benefit every time.

Skills are powerful when you have repeatable workflows: generating frontend designs from specs, conducting research with consistent methodology, creating documents that follow your team's style guide, or orchestrating multi-step processes. They work well with Claude's built-in capabilities like code execution and document creation. For those building MCP integrations, skills add another powerful layer helping turn raw tool access into reliable, optimized workflows.

**What you'll learn:**

- Technical requirements and best practices for skill structure
- Patterns for standalone skills and MCP-enhanced workflows
- Patterns we've seen work well across different use cases
- How to test, iterate, and distribute your skills

**Who this is for:**

- Developers who want Claude to follow specific workflows consistently
- Power users who want Claude to follow specific workflows
- Teams looking to standardize how Claude works across their organization

**Two Paths Through This Guide:**

Building standalone skills? Focus on Fundamentals, Planning and Design, and category 1-2. Enhancing an MCP integration? The "Skills + MCP" section and category 3 are for you. Both paths share the same technical requirements, but you choose what's relevant to your use case.

**What you'll get out of this guide:** By the end, you'll be able to build a functional skill in a single sitting. Expect about 15-30 minutes to build and test your first working skill using the skill-creator.

---

## Chapter 1: Fundamentals

### What is a skill?

A skill is a folder containing:

- **SKILL.md** (required): Instructions in Markdown with YAML frontmatter
- **scripts/** (optional): Executable code (Python, Bash, etc.)
- **references/** (optional): Documentation loaded as needed
- **assets/** (optional): Templates, fonts, icons used in output

### Core design principles

#### Progressive Disclosure

Skills use a three-level system:

- **First level (YAML frontmatter):** Always loaded in Claude's system prompt. Provides just enough information for Claude to know when each skill should be used without loading all of it into context.
- **Second level (SKILL.md body):** Loaded when Claude thinks the skill is relevant to the current task. Contains the full instructions and guidance.
- **Third level (Linked files):** Additional files bundled within the skill directory that Claude can choose to navigate and discover only as needed.

This progressive disclosure minimizes token usage while maintaining specialized expertise.

#### Composability

Claude can load multiple skills simultaneously. Your skill should work well alongside others, not assume it's the only capability available.

#### Portability

Skills work identically across Claude.ai, Claude Code, and API. Create a skill once and it works across all surfaces without modification, provided the environment supports any dependencies the skill requires.

### For MCP Builders: Skills + Connectors

If you already have a working MCP server, you've done the hard part. Skills are the knowledge layer on top - capturing the workflows and best practices you already know, so Claude can apply them consistently.

#### The kitchen analogy

**MCP provides the professional kitchen:** access to tools, ingredients, and equipment.

**Skills provide the recipes:** step-by-step instructions on how to create something valuable.

Together, they enable users to accomplish complex tasks without needing to figure out every step themselves.

#### How they work together

| MCP (Connectivity) | Skills (Knowledge) |
|---|---|
| Connects Claude to your service (Notion, Asana, Linear, etc.) | Teaches Claude how to use your service effectively |
| Provides real-time data access and tool invocation | Captures workflows and best practices |
| What Claude can do | How Claude should do it |

#### Why this matters for your MCP users

**Without skills:**

- Users connect your MCP but don't know what to do next
- Support tickets asking "how do I do X with your integration"
- Each conversation starts from scratch
- Inconsistent results because users prompt differently each time
- Users blame your connector when the real issue is workflow guidance

**With skills:**

- Pre-built workflows activate automatically when needed
- Consistent, reliable tool usage
- Best practices embedded in every interaction
- Lower learning curve for your integration

---

## Chapter 2: Planning and design

### Start with use cases

Before writing any code, identify 2-3 concrete use cases your skill should enable.

**Good use case definition:**

```
Use Case: Project Sprint Planning
Trigger: User says "help me plan this sprint" or "create sprint tasks"
Steps:
  1. Fetch current project status from Linear (via MCP)
  2. Analyze team velocity and capacity
  3. Suggest task prioritization
  4. Create tasks in Linear with proper labels and estimates
Result: Fully planned sprint with tasks created
```

**Ask yourself:**

- What does a user want to accomplish?
- What multi-step workflows does this require?
- Which tools are needed (built-in or MCP?)
- What domain knowledge or best practices should be embedded?

### Common skill use case categories

#### Category 1: Document & Asset Creation

Used for: Creating consistent, high-quality output including documents, presentations, apps, designs, code, etc.

*Real example: frontend-design skill*

"Create distinctive, production-grade frontend interfaces with high design quality. Use when building web components, pages, artifacts, posters, or applications."

**Key techniques:**

- Embedded style guides and brand standards
- Template structures for consistent output
- Quality checklists before finalizing
- No external tools required - uses Claude's built-in capabilities

#### Category 2: Workflow Automation

Used for: Multi-step processes that benefit from consistent methodology, including coordination across multiple MCP servers.

*Real example: skill-creator skill*

"Interactive guide for creating new skills. Walks the user through use case definition, frontmatter generation, instruction writing, and validation."

**Key techniques:**

- Step-by-step workflow with validation gates
- Templates for common structures
- Built-in review and improvement suggestions
- Iterative refinement loops

#### Category 3: MCP Enhancement

Used for: Workflow guidance to enhance the tool access an MCP server provides.

*Real example: sentry-code-review skill (from Sentry)*

"Automatically analyzes and fixes detected bugs in GitHub Pull Requests using Sentry's error monitoring data via their MCP server."

**Key techniques:**

- Coordinates multiple MCP calls in sequence
- Embeds domain expertise
- Provides context users would otherwise need to specify
- Error handling for common MCP issues

### Define success criteria

How will you know your skill is working?

These are aspirational targets - rough benchmarks rather than precise thresholds. Aim for rigor but accept that there will be an element of vibes-based assessment.

**Quantitative metrics:**

- **Skill triggers on 90% of relevant queries**
  - *How to measure:* Run 10-20 test queries that should trigger your skill. Track how many times it loads automatically vs. requires explicit invocation.
- **Completes workflow in X tool calls**
  - *How to measure:* Compare the same task with and without the skill enabled. Count tool calls and total tokens consumed.
- **0 failed API calls per workflow**
  - *How to measure:* Monitor MCP server logs during test runs. Track retry rates and error codes.

**Qualitative metrics:**

- **Users don't need to prompt Claude about next steps**
  - *How to assess:* During testing, note how often you need to redirect or clarify. Ask beta users for feedback.
- **Workflows complete without user correction**
  - *How to assess:* Run the same request 3-5 times. Compare outputs for structural consistency and quality.
- **Consistent results across sessions**
  - *How to assess:* Can a new user accomplish the task on first try with minimal guidance?

### Technical requirements

#### File structure

```
your-skill-name/
├── SKILL.md                # Required - main skill file
├── scripts/                # Optional - executable code
│   ├── process_data.py     # Example
│   └── validate.sh         # Example
├── references/             # Optional - documentation
│   ├── api-guide.md        # Example
│   └── examples/           # Example
└── assets/                 # Optional - templates, etc.
    └── report-template.md  # Example
```

#### Critical rules

**SKILL.md naming:**

- Must be exactly `SKILL.md` (case-sensitive)
- No variations accepted (SKILL.MD, skill.md, etc.)

**Skill folder naming:**

- Use kebab-case: `notion-project-setup` ✅
- No spaces: `Notion Project Setup` ❌
- No underscores: `notion_project_setup` ❌
- No capitals: `NotionProjectSetup` ❌

**No README.md:**

- Don't include README.md inside your skill folder
- All documentation goes in SKILL.md or references/
- Note: when distributing via GitHub, you'll still want a repo-level README for human users -- see Distribution and Sharing.

#### YAML frontmatter: The most important part

The YAML frontmatter is how Claude decides whether to load your skill. Get this right.

**Minimal required format:**

```yaml
---
name: your-skill-name
description: What it does. Use when user asks to [specific phrases].
---
```

That's all you need to start.

#### Field requirements

**name** (required):

- kebab-case only
- No spaces or capitals
- Should match folder name

**description** (required):

- MUST include BOTH:
  - What the skill does
  - When to use it (trigger conditions)
- Under 1024 characters
- No XML tags (< or >)
- Include specific tasks users might say
- Mention file types if relevant

**license** (optional):

- Use if making skill open source
- Common: MIT, Apache-2.0

**compatibility** (optional):

- 1-500 characters
- Indicates environment requirements: e.g. intended product, required system packages, network access needs, etc.

**metadata** (optional):

- Any custom key-value pairs
- Suggested: author, version, mcp-server
- Example:

```yaml
metadata:
  author: ProjectHub
  version: 1.0.0
  mcp-server: projecthub
```

#### Security restrictions

**Forbidden in frontmatter:**

- XML angle brackets (< >)
- Skills with "claude" or "anthropic" in name (reserved)

**Why:** Frontmatter appears in Claude's system prompt. Malicious content could inject instructions.

### Writing effective skills

#### The description field

According to Anthropic's engineering blog: "This metadata...provides just enough information for Claude to know when each skill should be used without loading all of it into context." This is the first level of progressive disclosure.

**Structure:**

```
[What it does] + [When to use it] + [Key capabilities]
```

**Examples of good descriptions:**

```yaml
# Good - specific and actionable
description: Analyzes Figma design files and generates developer handoff documentation. Use when user uploads .fig files, asks for "design specs", "component documentation", or "design-to-code handoff".

# Good - includes trigger phrases
description: Manages Linear project workflows including sprint planning, task creation, and status tracking. Use when user mentions "sprint", "Linear tasks", "project planning", or asks to "create tickets".

# Good - clear value proposition
description: End-to-end customer onboarding workflow for PayFlow. Handles account creation, payment setup, and subscription management. Use when user says "onboard new customer", "set up subscription", or "create PayFlow account".
```

**Examples of bad descriptions:**

```yaml
# Too vague
description: Helps with projects.

# Missing triggers
description: Creates sophisticated multi-page documentation systems.

# Too technical, no user triggers
description: Implements the Project entity model with hierarchical relationships.
```

#### Writing the main instructions

After the frontmatter, write the actual instructions in Markdown.

**Recommended structure:**

```yaml
---
name: your-skill
description: [...]
---

# Your Skill Name

## Instructions

### Step 1: [First Major Step]
Clear explanation of what happens.

Example:
```bash
python scripts/fetch_data.py --project-id PROJECT_ID
Expected output: [describe what success looks like]
```

(Add more steps as needed)

## Examples

### Example 1: [common scenario]

User says: "Set up a new marketing campaign"

Actions:
1. Fetch existing campaigns via MCP
2. Create new campaign with provided parameters

Result: Campaign created with confirmation link

(Add more examples as needed)

## Troubleshooting

### Error: [Common error message]
**Cause:** [Why it happens]
**Solution:** [How to fix]

(Add more error cases as needed)
```

#### Best Practices for Instructions

**Be Specific and Actionable**

✅ Good:

```
Run `python scripts/validate.py --input {filename}` to check data format.
If validation fails, common issues include:
- Missing required fields (add them to the CSV)
- Invalid date formats (use YYYY-MM-DD)
```

❌ Bad:

```
Validate the data before proceeding.
```

**Include error handling:**

```markdown
## Common Issues

### MCP Connection Failed
If you see "Connection refused":
1. Verify MCP server is running: Check Settings > Extensions
2. Confirm API key is valid
3. Try reconnecting: Settings > Extensions > [Your Service] > Reconnect
```

**Reference bundled resources clearly:**

```
Before writing queries, consult `references/api-patterns.md` for:
- Rate limiting guidance
- Pagination patterns
- Error codes and handling
```

**Use progressive disclosure:**

Keep SKILL.md focused on core instructions. Move detailed documentation to `references/` and link to it.

---

## Chapter 3: Testing and iteration

Skills can be tested at varying levels of rigor depending on your needs:

- **Manual testing in Claude.ai** - Run queries directly and observe behavior. Fast iteration, no setup required.
- **Scripted testing in Claude Code** - Automate test cases for repeatable validation across changes.
- **Programmatic testing via skills API** - Build evaluation suites that run systematically against defined test sets.

Choose the approach that matches your quality requirements and the visibility of your skill.

> **Pro Tip: Iterate on a single task before expanding**
>
> We've found that the most effective skill creators iterate on a single challenging task until Claude succeeds, then extract the winning approach into a skill. This leverages Claude's in-context learning and provides faster signal than broad testing. Once you have a working foundation, expand to multiple test cases for coverage.

### Recommended Testing Approach

#### 1. Triggering tests

**Goal:** Ensure your skill loads at the right times.

**Test cases:**

- ✅ Triggers on obvious tasks
- ✅ Triggers on paraphrased requests
- ❌ Doesn't trigger on unrelated topics

**Example test suite:**

```
Should trigger:
- "Help me set up a new ProjectHub workspace"
- "I need to create a project in ProjectHub"
- "Initialize a ProjectHub project for Q4 planning"

Should NOT trigger:
- "What's the weather in San Francisco?"
- "Help me write Python code"
- "Create a spreadsheet" (unless ProjectHub skill handles sheets)
```

#### 2. Functional tests

**Goal:** Verify the skill produces correct outputs.

**Test cases:**

- Valid outputs generated
- API calls succeed
- Error handling works
- Edge cases covered

**Example:**

```
Test: Create project with 5 tasks
Given: Project name "Q4 Planning", 5 task descriptions
When: Skill executes workflow
Then:
  - Project created in ProjectHub
  - 5 tasks created with correct properties
  - All tasks linked to project
  - No API errors
```

#### 3. Performance comparison

**Goal:** Prove the skill improves results vs. baseline.

**Baseline comparison:**

```
Without skill:
- User provides instructions each time
- 15 back-and-forth messages
- 3 failed API calls requiring retry
- 12,000 tokens consumed

With skill:
- Automatic workflow execution
- 2 clarifying questions only
- 0 failed API calls
- 6,000 tokens consumed
```

### Using the skill-creator skill

The `skill-creator` skill - available in Claude.ai via plugin directory or download for Claude Code - can help you build and iterate on skills. If you have an MCP server and know your top 2-3 workflows, you can build and test a functional skill in a single sitting - often in 15-30 minutes.

**Creating skills:**

- Generate skills from natural language descriptions
- Produce properly formatted SKILL.md with frontmatter
- Suggest trigger phrases and structure

**Reviewing skills:**

- Flag common issues (vague descriptions, missing triggers, structural problems)
- Identify potential over/under-triggering risks
- Suggest test cases based on the skill's stated purpose

**Iterative improvement:**

- After using your skill and encountering edge cases or failures, bring those examples back to skill-creator
- Example: "Use the issues & solution identified in this chat to improve how the skill handles [specific edge case]"

**To use:**

```
"Use the skill-creator skill to help me build a skill for [your use case]"
```

> *Note: skill-creator helps you design and refine skills but does not execute automated test suites or produce quantitative evaluation results.*

### Iteration based on feedback

Skills are living documents. Plan to iterate based on:

**Undertriggering signals:**

- Skill doesn't load when it should
- Users manually enabling it
- Support questions about when to use it

> **Solution:** Add more detail and nuance to the description - this may include keywords particularly for technical terms

**Overtriggering signals:**

- Skill loads for irrelevant queries
- Users disabling it
- Confusion about purpose

> **Solution:** Add negative triggers, be more specific

**Execution issues:**

- Inconsistent results
- API call failures
- User corrections needed

> **Solution:** Improve instructions, add error handling

---

## Chapter 4: Distribution and sharing

Skills make your MCP integration more complete. As users compare connectors, those with skills offer a faster path to value, giving you an edge over MCP-only alternatives.

### Current distribution model (January 2026)

**How individual users get skills:**

1. Download the skill folder
2. Zip the folder (if needed)
3. Upload to Claude.ai via Settings > Capabilities > Skills
4. Or place in Claude Code skills directory

**Organization-level skills:**

- Admins can deploy skills workspace-wide (shipped December 18, 2025)
- Automatic updates
- Centralized management

### An open standard

Agent Skills has been published as an open standard. Like MCP, skills should be portable across tools and platforms - the same skill should work whether you're using Claude or other AI platforms. That said, some skills are designed to take full advantage of a specific platform's capabilities; authors can note this in the skill's `compatibility` field.

### Using skills via API

For programmatic use cases - such as building applications, agents, or automated workflows that leverage skills - the API provides direct control over skill management and execution.

**Key capabilities:**

- `/v1/skills` endpoint for listing and managing skills
- Add skills to Messages API requests via the `container.skills` parameter
- Version control and management through the Claude Console
- Works with the Claude Agent SDK for building custom agents

**When to use skills via the API vs. Claude.ai:**

| Use Case | Best Surface |
|---|---|
| End users interacting with skills directly | Claude.ai / Claude Code |
| Manual testing and iteration during development | Claude.ai / Claude Code |
| Individual, ad-hoc workflows | Claude.ai / Claude Code |
| Applications using skills programmatically | API |
| Production deployments at scale | API |
| Automated pipelines and agent systems | API |

> **Note:** Skills in the API require the Code Execution Tool beta, which provides the secure environment skills need to run.

### Recommended approach today

Start by hosting your skill on GitHub with a public repo, clear README (for human visitors -- this is separate from your skill folder, which should not contain a README.md), and example usage with screenshots. Then add a section to your MCP documentation that links to the skill, explains why using both together is valuable, and provides a quick-start guide.

1. **Host on GitHub**
   - Public repo for open-source skills
   - Clear README with installation instructions
   - Example usage and screenshots

2. **Document in Your MCP Repo**
   - Link to skills from MCP documentation
   - Explain the value of using both together
   - Provide quick-start guide

3. **Create an Installation Guide**

```markdown
## Installing the [Your Service] skill

1. Download the skill:
   - Clone repo: `git clone https://github.com/yourcompany/skills`
   - Or download ZIP from Releases

2. Install in Claude:
   - Open Claude.ai > Settings > Skills
   - Click "Upload skill"
   - Select the skill folder (zipped)

3. Enable the skill:
   - Toggle on the [Your Service] skill
   - Ensure your MCP server is connected

4. Test:
   - Ask Claude: "Set up a new project in [Your Service]"
```

### Positioning your skill

**Focus on outcomes, not features:**

✅ Good:

```
"The ProjectHub skill enables teams to set up complete project workspaces
in seconds -- including pages, databases, and templates -- instead of
spending 30 minutes on manual setup."
```

❌ Bad:

```
"The ProjectHub skill is a folder containing YAML frontmatter and Markdown
instructions that calls our MCP server tools."
```

**Highlight the MCP + skills story:**

```
"Our MCP server gives Claude access to your Linear projects. Our skills
teach Claude your team's sprint planning workflow. Together, they enable
AI-powered project management."
```

---

## Chapter 5: Patterns and troubleshooting

These patterns emerged from skills created by early adopters and internal teams. They represent common approaches we've seen work well, not prescriptive templates.

### Choosing your approach: Problem-first vs. tool-first

Think of it like Home Depot. You might walk in with a problem - "I need to fix a kitchen cabinet" - and an employee points you to the right tools. Or you might pick out a new drill and ask how to use it for your specific job.

Skills work the same way:

- **Problem-first:** "I need to set up a project workspace" -> Your skill orchestrates the right MCP calls in the right sequence. Users describe outcomes; the skill handles the tools.
- **Tool-first:** "I have Notion MCP connected" -> Your skill teaches Claude the optimal workflows and best practices. Users have access; the skill provides expertise.

Most skills lean one direction. Knowing which framing fits your use case helps you choose the right pattern below.

### Pattern 1: Sequential workflow orchestration

**Use when:** Your users need multi-step processes in a specific order.

**Example structure:**

```markdown
## Workflow: Onboard New Customer

### Step 1: Create Account
Call MCP tool: `create_customer`
Parameters: name, email, company

### Step 2: Setup Payment
Call MCP tool: `setup_payment_method`
Wait for: payment method verification

### Step 3: Create Subscription
Call MCP tool: `create_subscription`
Parameters: plan_id, customer_id (from Step 1)

### Step 4: Send Welcome Email
Call MCP tool: `send_email`
Template: welcome_email_template
```

**Key techniques:**

- Explicit step ordering
- Dependencies between steps
- Validation at each stage
- Rollback instructions for failures

### Pattern 2: Multi-MCP coordination

**Use when:** Workflows span multiple services.

**Example: Design-to-development handoff**

```markdown
### Phase 1: Design Export (Figma MCP)
1. Export design assets from Figma
2. Generate design specifications
3. Create asset manifest

### Phase 2: Asset Storage (Drive MCP)
1. Create project folder in Drive
2. Upload all assets
3. Generate shareable links

### Phase 3: Task Creation (Linear MCP)
1. Create development tasks
2. Attach asset links to tasks
3. Assign to engineering team

### Phase 4: Notification (Slack MCP)
1. Post handoff summary to #engineering
2. Include asset links and task references
```

**Key techniques:**

- Clear phase separation
- Data passing between MCPs
- Validation before moving to next phase
- Centralized error handling

### Pattern 3: Iterative refinement

**Use when:** Output quality improves with iteration.

**Example: Report generation**

```markdown
## Iterative Report Creation

### Initial Draft
1. Fetch data via MCP
2. Generate first draft report
3. Save to temporary file

### Quality Check
1. Run validation script: `scripts/check_report.py`
2. Identify issues:
   - Missing sections
   - Inconsistent formatting
   - Data validation errors

### Refinement Loop
1. Address each identified issue
2. Regenerate affected sections
3. Re-validate
4. Repeat until quality threshold met

### Finalization
1. Apply final formatting
2. Generate summary
3. Save final version
```

**Key techniques:**

- Explicit quality criteria
- Iterative improvement
- Validation scripts
- Know when to stop iterating

### Pattern 4: Context-aware tool selection

**Use when:** Same outcome, different tools depending on context.

**Example: File storage**

```markdown
## Smart File Storage

### Decision Tree
1. Check file type and size
2. Determine best storage location:
   - Large files (>10MB): Use cloud storage MCP
   - Collaborative docs: Use Notion/Docs MCP
   - Code files: Use GitHub MCP
   - Temporary files: Use local storage

### Execute Storage
Based on decision:
- Call appropriate MCP tool
- Apply service-specific metadata
- Generate access link

### Provide Context to User
Explain why that storage was chosen
```

**Key techniques:**

- Clear decision criteria
- Fallback options
- Transparency about choices

### Pattern 5: Domain-specific intelligence

**Use when:** Your skill adds specialized knowledge beyond tool access.

**Example: Financial compliance**

```markdown
## Payment Processing with Compliance

### Before Processing (Compliance Check)
1. Fetch transaction details via MCP
2. Apply compliance rules:
   - Check sanctions lists
   - Verify jurisdiction allowances
   - Assess risk level
3. Document compliance decision

### Processing
IF compliance passed:
    - Call payment processing MCP tool
    - Apply appropriate fraud checks
    - Process transaction
ELSE:
    - Flag for review
    - Create compliance case

### Audit Trail
- Log all compliance checks
- Record processing decisions
- Generate audit report
```

**Key techniques:**

- Domain expertise embedded in logic
- Compliance before action
- Comprehensive documentation
- Clear governance

### Troubleshooting (PDF Guide)

#### Skill won't upload

**Error: "Could not find SKILL.md in uploaded folder"**

- **Cause:** File not named exactly SKILL.md
- **Solution:** Rename to `SKILL.md` (case-sensitive). Verify with: `ls -la` should show `SKILL.md`

**Error: "Invalid frontmatter"**

- **Cause:** YAML formatting issue
- Common mistakes:

```yaml
# Wrong - missing delimiters
name: my-skill
description: Does things

# Wrong - unclosed quotes
name: my-skill
description: "Does things

# Correct
---
name: my-skill
description: Does things
---
```

**Error: "Invalid skill name"**

- **Cause:** Name has spaces or capitals

```yaml
# Wrong
name: My Cool Skill

# Correct
name: my-cool-skill
```

#### Skill doesn't trigger

**Symptom:** Skill never loads automatically

**Fix:** Revise your description field.

Quick checklist:

- Is it too generic? ("Helps with projects" won't work)
- Does it include trigger phrases users would actually say?
- Does it mention relevant file types if applicable?

**Debugging approach:** Ask Claude: "When would you use the [skill name] skill?" Claude will quote the description back. Adjust based on what's missing.

#### Skill triggers too often

**Symptom:** Skill loads for unrelated queries

**Solutions:**

1. **Add negative triggers**

```yaml
description: Advanced data analysis for CSV files. Use for statistical modeling, regression, clustering. Do NOT use for simple data exploration (use data-viz skill instead).
```

2. **Be more specific**

```yaml
# Too broad
description: Processes documents

# More specific
description: Processes PDF legal documents for contract review
```

3. **Clarify scope**

```yaml
description: PayFlow payment processing for e-commerce. Use specifically for online payment workflows, not for general financial queries.
```

#### MCP connection issues

**Symptom:** Skill loads but MCP calls fail

**Checklist:**

1. **Verify MCP server is connected**
   - Claude.ai: Settings > Extensions > [Your Service]
   - Should show "Connected" status

2. **Check authentication**
   - API keys valid and not expired
   - Proper permissions/scopes granted
   - OAuth tokens refreshed

3. **Test MCP independently**
   - Ask Claude to call MCP directly (without skill)
   - "Use [Service] MCP to fetch my projects"
   - If this fails, issue is MCP not skill

4. **Verify tool names**
   - Skill references correct MCP tool names
   - Check MCP server documentation
   - Tool names are case-sensitive

#### Instructions not followed

**Symptom:** Skill loads but Claude doesn't follow instructions

**Common causes:**

1. **Instructions too verbose**
   - Keep instructions concise
   - Use bullet points and numbered lists
   - Move detailed reference to separate files

2. **Instructions buried**
   - Put critical instructions at the top
   - Use `## Important` or `## Critical` headers
   - Repeat key points if needed

3. **Ambiguous language**

```
# Bad
Make sure to validate things properly

# Good
CRITICAL: Before calling create_project, verify:
- Project name is non-empty
- At least one team member assigned
- Start date is not in the past
```

> **Advanced technique:** For critical validations, consider bundling a script that performs the checks programmatically rather than relying on language instructions. Code is deterministic; language interpretation isn't.

4. **Model "laziness"** - Add explicit encouragement:

```markdown
## Performance Notes
- Take your time to do this thoroughly
- Quality is more important than speed
- Do not skip validation steps
```

> Note: Adding this to user prompts is more effective than in SKILL.md

#### Large context issues

**Symptom:** Skill seems slow or responses degraded

**Causes:**

- Skill content too large
- Too many skills enabled simultaneously
- All content loaded instead of progressive disclosure

**Solutions:**

1. **Optimize SKILL.md size**
   - Move detailed docs to references/
   - Link to references instead of inline
   - Keep SKILL.md under 5,000 words

2. **Reduce enabled skills**
   - Evaluate if you have more than 20-50 skills enabled simultaneously
   - Recommend selective enablement
   - Consider skill "packs" for related capabilities

---

## Chapter 6: Resources and references

### Official Documentation

**Anthropic Resources:**

- Best Practices Guide
- Skills Documentation
- API Reference
- MCP Documentation

**Blog Posts:**

- Introducing Agent Skills
- Engineering Blog: Equipping Agents for the Real World
- Skills Explained
- How to Create Skills for Claude
- Building Skills for Claude Code
- Improving Frontend Design through Skills

### Example skills

**Public skills repository:**

- GitHub: `anthropics/skills`
- Contains Anthropic-created skills you can customize

### Tools and Utilities

**skill-creator skill:**

- Built into Claude.ai and available for Claude Code
- Can generate skills from descriptions
- Reviews and provides recommendations
- Use: "Help me build a skill using skill-creator"

**Validation:**

- skill-creator can assess your skills
- Ask: "Review this skill and suggest improvements"

### Getting Support

**For Technical Questions:**

- General questions: Community forums at the Claude Developers Discord

**For Bug Reports:**

- GitHub Issues: `anthropics/skills/issues`
- Include: Skill name, error message, steps to reproduce

---

## Reference A: Quick checklist

Use this checklist to validate your skill before and after upload.

### Before you start

- [ ] Identified 2-3 concrete use cases
- [ ] Tools identified (built-in or MCP)
- [ ] Reviewed this guide and example skills
- [ ] Planned folder structure

### During development

- [ ] Folder named in kebab-case
- [ ] SKILL.md file exists (exact spelling)
- [ ] YAML frontmatter has `---` delimiters
- [ ] name field: kebab-case, no spaces, no capitals
- [ ] description includes WHAT and WHEN
- [ ] No XML tags (< >) anywhere
- [ ] Instructions are clear and actionable
- [ ] Error handling included
- [ ] Examples provided
- [ ] References clearly linked

### Before upload

- [ ] Tested triggering on obvious tasks
- [ ] Tested triggering on paraphrased requests
- [ ] Verified doesn't trigger on unrelated topics
- [ ] Functional tests pass
- [ ] Tool integration works (if applicable)
- [ ] Compressed as .zip file

### After upload

- [ ] Test in real conversations
- [ ] Monitor for under/over-triggering
- [ ] Collect user feedback
- [ ] Iterate on description and instructions
- [ ] Update version in metadata

---

## Reference B: YAML frontmatter

### Required fields

```yaml
---
name: skill-name-in-kebab-case
description: What it does and when to use it. Include specific trigger phrases.
---
```

### All optional fields

```yaml
name: skill-name
description: [required description]
license: MIT                                        # Optional: License for open-source
allowed-tools: "Bash(python:*) Bash(npm:*) WebFetch" # Optional: Restrict tool access
metadata:                                           # Optional: Custom fields
  author: Company Name
  version: 1.0.0
  mcp-server: server-name
  category: productivity
  tags: [project-management, automation]
  documentation: https://example.com/docs
  support: support@example.com
```

### Security notes

**Allowed:**

- Any standard YAML types (strings, numbers, booleans, lists, objects)
- Custom metadata fields
- Long descriptions (up to 1024 characters)

**Forbidden:**

- XML angle brackets (< >) - security restriction
- Code execution in YAML (uses safe YAML parsing)
- Skills named with "claude" or "anthropic" prefix (reserved)

---

## Reference C: Complete skill examples

For full, production-ready skills demonstrating the patterns in this guide:

- **Document Skills** - PDF, DOCX, PPTX, XLSX creation
- **Example Skills** - Various workflow patterns
- **Partner Skills Directory** - View skills from various partners such as Asana, Atlassian, Canva, Figma, Sentry, Zapier, and more

These repositories stay up-to-date and include additional examples beyond what's covered here. Clone them, modify them for your use case, and use them as templates.
