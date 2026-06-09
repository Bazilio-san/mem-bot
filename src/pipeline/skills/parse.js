// Разбор файла SKILL.md на машинную часть (YAML-фронтматтер) и человеческие markdown-блоки.
//
// Runtime не угадывает смысл markdown произвольным парсингом: фронтматтер несёт строго заданные поля
// реестра и роутера, а тело делится на блоки со стабильными заголовками (# Skill Prompt,
// ## Fact Extraction Prompt, ## Domain Schema, ## References), которые извлекаются детерминированно.
//
// YAML-фронтматтер мы разбираем своим компактным разборщиком намеренно ограниченного подмножества: в проекте
// нет зависимости от внешней YAML-библиотеки, а формат самих файлов мы контролируем и покрываем тестами.
// Поддерживаются: вложенные отображения по отступам, последовательности (- элемент и поточные [a, b, c]),
// блочные скаляры «свёрнутый» (>) и «дословный» (|), а также скаляры — строка, число, true/false, null.

// Привести один скаляр к значению нужного типа. Кавычки снимаются, [..] разбирается как поточный список.
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

// Разобрать YAML-подмножество фронтматтера в объект JavaScript.
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

  // Разобрать узел (отображение или последовательность) с отступом не меньше minIndent.
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

    // Последовательность: строки вида «- значение» на одном отступе.
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

    // Отображение: строки вида «ключ: значение» или «ключ:» с вложенным узлом ниже.
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
        // Блочный скаляр: забираем все строки с отступом строго больше текущего.
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
        // Свёрнутый (>) склеивает строки пробелом; дословный (|) сохраняет переносы строк.
        obj[key] =
          rest === '>'
            ? block
                .map((s) => s.trim())
                .filter(Boolean)
                .join(' ')
            : block.join('\n').replace(/\s+$/, '');
      } else if (rest === '') {
        // Вложенный узел на большем отступе. Если его нет, значение — null.
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

// Разделить содержимое SKILL.md на фронтматтер (между первой парой строк «---») и тело markdown.
// Возвращает { frontmatter: <объект>, body: <строка> }. Если фронтматтера нет, объект пустой.
export function splitSkillFile(raw) {
  const text = String(raw).replace(/^﻿/, '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    return { frontmatter: {}, body: text };
  }
  return { frontmatter: parseFrontmatter(m[1]), body: m[2] };
}

// Извлечь содержимое markdown-раздела по точному заголовку (например «# Skill Prompt» или
// «## Fact Extraction Prompt»). Заголовки в SKILL.md трактуются как плоский список разделов: содержимое
// идёт от строки после заголовка до следующего заголовка любого уровня. Пустая строка — «раздела нет».
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
    } // следующий заголовок любого уровня закрывает раздел
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

// Достать первый блок ```json … ``` из текста раздела и разобрать его как JSON. null, если блока нет.
export function extractJsonBlock(sectionText) {
  const m = String(sectionText).match(/```json\s*\r?\n([\s\S]*?)```/);
  if (!m) {
    return null;
  }
  return JSON.parse(m[1]);
}
