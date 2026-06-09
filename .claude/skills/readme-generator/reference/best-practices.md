# Documentation Best Practices

## Writing Style

### Be Clear and Concise

**Good:**
> Install the package using npm.

**Bad:**
> You can install this package by utilizing the npm package manager which is included with Node.js.

### Use Active Voice

**Good:**
> The function returns a promise.

**Bad:**
> A promise is returned by the function.

### Write for Your Audience

- **Developers**: Include technical details, API references
- **End Users**: Focus on features, benefits, screenshots
- **Contributors**: Explain architecture, setup, testing

## Structure

### Start with the Most Important Information

1. What is it?
2. Why should I use it?
3. How do I get started?

### Progressive disclosure

A long README is fine — a *cluttered* one is not. Two devices shrink perceived volume without
dropping content the reader (or any doc-assembly tooling) may need:

- **Quick Links** right after the badges. List only the major `##` sections (8–14 entries),
  never a full TOC. The reader who knows what they want jumps; the reader who is browsing
  ignores the list and keeps scrolling.
- **`<details>` collapsible blocks** for sections that *must* live inline but would otherwise
  dominate the page — the canonical case is a large reference table (an API, command, or endpoint
  listing) that runs dozens of lines. The heading stays visible and anchor-linkable; the bulk is
  one click away.

Reach for `<details>` only when the content (a) belongs in this section, (b) is long enough to
push the next section off-screen, and (c) is not needed at a glance. Do *not* hide Quick Start
commands, Key Features bullets, a compact config table, or integration snippets.

Required markup (GitHub Markdown):

```markdown
<details><summary>Expand to view <what is inside></summary><br>


<bulky content>

</details>
```

The `<br>` after `</summary>` is mandatory — GitHub otherwise collapses the first child block
against the summary line.

### Use Headings Effectively

```markdown
# Main Title (H1) - Only one per document

## Major Sections (H2)

### Subsections (H3)

#### Details (H4) - Use sparingly
```

### Keep Paragraphs Short

- 2-4 sentences per paragraph
- One idea per paragraph
- Use bullet points for lists

## Code Examples

### Make Examples Runnable

**Good:**
```javascript
const api = require('my-api');
api.connect('https://api.example.com');
const users = await api.getUsers();
console.log(users);
```

**Bad:**
```javascript
// Connect to API
api.connect(url);
// Get users
getUsers();
```

### Show Expected Output

```javascript
const result = add(2, 3);
console.log(result);
// Output: 5
```

### Include Error Handling

```javascript
try {
  const data = await fetchData();
} catch (error) {
  console.error('Failed to fetch:', error.message);
}
```

## Formatting

### Use Consistent Terminology

Pick one term and stick with it:
- "function" not "function/method/procedure"
- "parameter" not "parameter/argument/input"

### Format Code Inline

Use backticks for:
- Function names: `getData()`
- Variables: `userId`
- File names: `config.json`
- Commands: `npm install`

### Use Tables for Comparisons

| Feature | Option A | Option B |
|---------|----------|----------|
| Speed   | Fast     | Slow     |
| Memory  | Low      | High     |

## Common Sections

### Installation

Always include:
- Prerequisites (if any)
- Installation command
- Verification step

```markdown
## Installation

**Prerequisites:** Node.js 18+

\`\`\`bash
npm install package-name
\`\`\`

Verify installation:
\`\`\`bash
package-name --version
\`\`\`
```

### Configuration

Show default values:

```markdown
## Configuration

\`\`\`json
{
  "timeout": 5000,     // Default: 5000ms
  "retries": 3,        // Default: 3
  "debug": false       // Default: false
}
\`\`\`
```

### Troubleshooting

Address common issues:

```markdown
## Troubleshooting

### Error: "Module not found"

**Cause:** Package not installed

**Solution:**
\`\`\`bash
npm install missing-package
\`\`\`
```

## Maintenance

### Keep Documentation Updated

- Update docs with code changes
- Review docs during code review
- Mark deprecated features clearly

### Version Documentation

```markdown
## Version 2.0.0 (Breaking Changes)

- Removed: `oldFunction()`
- Changed: `newFunction()` now returns Promise
- Added: `anotherFunction()`
```

### Link to External Resources

```markdown
For more information, see:
- [Official Docs](https://example.com/docs)
- [API Reference](https://example.com/api)
- [Tutorial](https://example.com/tutorial)
```

## Accessibility

### Use Descriptive Link Text

**Good:**
> See the [installation guide](link) for details.

**Bad:**
> Click [here](link) for more information.

### Provide Alt Text for Images

```markdown
![Dashboard showing user analytics with graphs](screenshot.png)
```

### Use Semantic Markdown

- Use proper heading hierarchy
- Use lists for lists
- Use code blocks for code
