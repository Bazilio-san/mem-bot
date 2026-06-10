// Parsing of a SKILL.md file into a machine part (YAML frontmatter) and human markdown blocks.
//
// The runtime does not guess the meaning of markdown via arbitrary parsing: the frontmatter carries the strictly
// defined registry and router fields, while the body is split into blocks with stable headings (# Skill Prompt,
// ## Fact Extraction Prompt, ## Domain Schema, ## References) that are extracted deterministically.
//
// We parse the YAML frontmatter with our own compact parser of a deliberately limited subset: the project has no
// dependency on an external YAML library, and we control the format of the files themselves and cover it with tests.
// Supported: nested indentation-based mappings, sequences (- item and flow [a, b, c]),
// block scalars "folded" (>) and "literal" (|), and scalars — string, number, true/false, null.

// Convert a single scalar to a value of the appropriate type. Quotes are stripped, [..] is parsed as a flow list.
function parseScalar(token) {
  const t = String(token).trim();
  if (t === '' || t === 'null' || t === '~') {
    return t === '' ? '' : null;
  }
  if (t === 'true') {
    return true;
  }
  if (t === 'false') {
    return false;
  }
  if (/^-?\d+$/.test(t)) {
    return Number(t);
  }
  if (/^-?\d*\.\d+$/.test(t)) {
    return Number(t);
  }
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner.split(',').map((x) => parseScalar(x));
  }
  return t;
}

// Parse the YAML subset of the frontmatter into a JavaScript object.
export function parseFrontmatter(text) {
  const lines = String(text).split(/\r?\n/);
  let pos = 0;

  const indentOf = (s) => s.match(/^ */)[0].length;
  const isBlank = (s) => s.trim() === '';
  const isComment = (s) => s.trim().startsWith('#');

  const skipIgnorable = () => {
    while (pos < lines.length && (isBlank(lines[pos]) || isComment(lines[pos]))) {
      pos++;
    }
  };

  // Parse a node (mapping or sequence) with an indent of at least minIndent.
  function parseNode(minIndent) {
    skipIgnorable();
    if (pos >= lines.length) {
      return null;
    }
    const indent = indentOf(lines[pos]);
    if (indent < minIndent) {
      return null;
    }

    const firstContent = lines[pos].slice(indent);

    // Sequence: lines of the form "- value" at the same indent.
    if (firstContent.startsWith('- ') || firstContent === '-') {
      const arr = [];
      while (pos < lines.length) {
        skipIgnorable();
        if (pos >= lines.length) {
          break;
        }
        if (indentOf(lines[pos]) !== indent) {
          break;
        }
        const content = lines[pos].slice(indent);
        if (!content.startsWith('-')) {
          break;
        }
        const itemValue = content.slice(1).trim();
        pos++;
        arr.push(parseScalar(itemValue));
      }
      return arr;
    }

    // Mapping: lines of the form "key: value" or "key:" with a nested node below.
    const obj = {};
    while (pos < lines.length) {
      skipIgnorable();
      if (pos >= lines.length) {
        break;
      }
      if (indentOf(lines[pos]) !== indent) {
        break;
      }
      const content = lines[pos].slice(indent);
      const m = content.match(/^([^:]+):(.*)$/);
      if (!m) {
        break;
      }
      const key = m[1].trim();
      const rest = m[2].trim();
      pos++;

      if (rest === '>' || rest === '|') {
        // Block scalar: take all lines indented strictly more than the current one.
        const block = [];
        while (pos < lines.length) {
          if (isBlank(lines[pos])) {
            block.push('');
            pos++;
            continue;
          }
          if (indentOf(lines[pos]) <= indent) {
            break;
          }
          block.push(lines[pos].trim());
          pos++;
        }
        // Folded (>) joins lines with a space; literal (|) preserves line breaks.
        obj[key] =
          rest === '>'
            ? block
                .map((s) => s.trim())
                .filter(Boolean)
                .join(' ')
            : block.join('\n').replace(/\s+$/, '');
      } else if (rest === '') {
        // Nested node at a greater indent. If there is none, the value is null.
        const child = parseNode(indent + 1);
        obj[key] = child === null ? null : child;
      } else {
        obj[key] = parseScalar(rest);
      }
    }
    return obj;
  }

  const result = parseNode(0);
  return result && typeof result === 'object' && !Array.isArray(result) ? result : {};
}

// Split SKILL.md contents into frontmatter (between the first pair of "---" lines) and the markdown body.
// Returns { frontmatter: <object>, body: <string> }. If there is no frontmatter, the object is empty.
export function splitSkillFile(raw) {
  const text = String(raw).replace(/^﻿/, '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    return { frontmatter: {}, body: text };
  }
  return { frontmatter: parseFrontmatter(m[1]), body: m[2] };
}

// Extract the contents of a markdown section by its exact heading (e.g. "# Skill Prompt" or
// "## Fact Extraction Prompt"). Headings in SKILL.md are treated as a flat list of sections: the contents
// run from the line after the heading to the next heading of any level. An empty string means "no such section".
export function extractSection(body, heading) {
  const lines = String(body).split(/\r?\n/);
  const headMatch = heading.match(/^(#+)\s+(.*)$/);
  if (!headMatch) {
    return '';
  }
  const level = headMatch[1].length;
  const titleNorm = headMatch[2].trim().toLowerCase();

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const lm = lines[i].match(/^(#+)\s+(.*)$/);
    if (lm && lm[1].length === level && lm[2].trim().toLowerCase() === titleNorm) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) {
    return '';
  }

  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (/^#+\s+/.test(lines[i])) {
      break;
    } // the next heading of any level closes the section
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

// Take the first ```json … ``` block from the section text and parse it as JSON. null if there is no block.
export function extractJsonBlock(sectionText) {
  const m = String(sectionText).match(/```json\s*\r?\n([\s\S]*?)```/);
  if (!m) {
    return null;
  }
  return JSON.parse(m[1]);
}
