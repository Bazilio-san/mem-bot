// Порт кастомной версии pretty-print-json (multi-bot, common/lib/af-tools-ts/pretty-print-json.ts):
// pretty-печать JSON в HTML с раскраской типов (классы json-key/string/number/boolean/null/mark),
// кликабельными ссылками (target=_blank) и прокручиваемыми контейнерами для длинных строк.
// Поверх порта — слой вложенного сериализованного JSON (renderJsonHtml): строковые значения, которые
// парсятся как объект или массив, получают инлайн-селект JSON | RAW. Селект — обычный <select> с
// data-атрибутом пути; обработка переключения — делегированием события change на контейнере
// (HTML вставляется через v-html, Vue-биндинги внутри него не работают).

export const prettyPrintJson = {
  toHtml(thing, options) {
    const defaults = {
      indent: 3,
      lineNumbers: false,
      linkUrls: true,
      linksNewTab: true,
      quoteKeys: false,
      trailingComma: true,
      maxTextLength: 100, // максимальная длина строки для показа в одну строку
      minTextContainerWidth: 300, // минимальная ширина контейнера длинного текста, px
    };
    const settings = { ...defaults, ...options };

    const htmlEntities = (text) =>
      text.replace(/[<>&]/g, (char) => {
        switch (char) {
          case '<':
            return '&lt;';
          case '>':
            return '&gt;';
          default:
            return '&amp;';
        }
      });

    // Разэкранирование спецсимволов в длинных строках: контейнер показывает человекочитаемый текст.
    const deserializeString = (str) =>
      str
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\b/g, '\b')
        .replace(/\\f/g, '\f')
        .replace(/\\v/g, '\v')
        .replace(/\\0/g, '\0')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\');

    const spanTag = (type, display) => (display ? `<span class=json-${type}>${display}</span>` : '');

    const buildValueHtml = (value) => {
      const strType = value.startsWith('"') && 'string';
      const boolType = ['true', 'false'].includes(value) && 'boolean';
      const nullType = value === 'null' && 'null';
      const type = boolType || nullType || strType || 'number';

      if (strType) {
        const stringContent = value.slice(1, -1);
        if (stringContent.length > settings.maxTextLength) {
          const deserializedContent = deserializeString(stringContent);
          return `<span class=json-${type}><span class="json-long-text-inline" style="--min-text-width: ${settings.minTextContainerWidth}px;"><div class="json-long-text-content">${htmlEntities(
            deserializedContent,
          )}</div></span></span>`;
        }
      }

      const urlPattern = /https?:\/\/[^\s"]+?(?="|$)/g;
      const target = settings.linksNewTab ? ' target=_blank' : '';
      const makeLink = (link) => `<a class=json-link href="${link}"${target}>${link}</a>`;
      const display = strType && settings.linkUrls ? value.replace(urlPattern, makeLink) : value;
      return spanTag(type, display);
    };

    const replacer = (match, p1, p2, p3, p4) => {
      // Четыре скобочные группы строки (отступ, ключ, значение, конец) превращаются в HTML.
      const part = { indent: p1, key: p2, value: p3, end: p4 };
      const findName = settings.quoteKeys ? /(.*)(): / : /"([\w$]+)": |(.*): /;
      const indentHtml = part.indent || '';
      const keyName = part.key && part.key.replace(findName, '$1$2');
      const keyHtml = part.key ? spanTag('key', keyName) + spanTag('mark', ': ') : '';
      const valueHtml = part.value ? buildValueHtml(part.value) : '';
      const lastChar = (match && match[match.length - 1]) || '';
      const noComma = !part.end || [']', '}'].includes(lastChar);
      const addComma = settings.trailingComma && match[0] === ' ' && noComma;
      const endHtml = spanTag('mark', addComma ? `${part.end ?? ''},` : part.end);

      const hasLongText = valueHtml.includes('json-long-text-inline');
      if (hasLongText && part.key) {
        // Для строк с длинными текстами — отдельная структура: ключ в своём контейнере.
        return `${indentHtml}<span class="json-key-container">${keyHtml}</span>${valueHtml}${endHtml}`;
      }
      return indentHtml + keyHtml + valueHtml + endHtml;
    };

    // Регулярка разбирает каждую строку JSON на четыре части: отступ, ключ, значение, завершение.
    const jsonLine = /^( *)("[^"]+": )?((?:"(?:[^"\\]|\\.)*")|[\w.+-]*)?([{}[\],]*)?$/gm;
    const json = JSON.stringify(thing, null, settings.indent) || 'undefined';
    const html = htmlEntities(json).replace(jsonLine, replacer);
    const makeLine = (line) => {
      const hasLongText = line.includes('json-long-text-inline');
      const className = hasLongText ? ' class="json-line-with-long-text"' : '';
      return `   <li${className}>${line}</li>`;
    };
    const addLineNumbers = (html_) => ['<ol class=json-lines>', ...html_.split('\n').map(makeLine), '</ol>'].join('\n');
    return settings.lineNumbers ? addLineNumbers(html) : html;
  },
};

// Строка с сериализованным JSON-объектом/массивом внутри? Только такие значения получают
// инлайн-селект JSON | RAW (примитивы в строках — «"42"», «"true"» — переключателя не стоят).
function looksNestedJson(v) {
  if (typeof v !== 'string') {
    return false;
  }
  const t = v.trim();
  if (t.length <= 2 || !((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) {
    return false;
  }
  try {
    const parsed = JSON.parse(t);
    return parsed !== null && typeof parsed === 'object';
  } catch {
    return false;
  }
}

const OPTS = { indent: 2 };

// Основной рендер для просмотрщика: src — строка с JSON, modes — карта «путь поля → 'JSON' | 'RAW'»
// для вложенного сериализованного JSON (по умолчанию JSON — распарсенное дерево на месте строки).
// withEmbeds=false отключает слой вложенного JSON (для блоков без обработчика change, например схемы).
// Возвращает HTML или null, если src — не валидный JSON.
export function renderJsonHtml(src, modes = {}, { withEmbeds = true } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(src);
  } catch {
    return null;
  }
  if (!withEmbeds) {
    return prettyPrintJson.toHtml(parsed, OPTS);
  }
  return renderValue(parsed, '$', modes, { n: 0 });
}

// Рекурсивный рендер уровня: вложенные JSON-строки заменяются на placeholder-токены, дерево
// печатается целиком, затем каждый токен заменяется на «селект + содержимое» (распарсенное дерево
// в режиме JSON или исходная строка в режиме RAW). Токен — алфавитно-цифровой, переживает и
// экранирование HTML, и построчную регулярку toHtml.
function renderValue(value, basePath, modes, counter) {
  const embeds = [];
  const strip = (v, path) => {
    if (looksNestedJson(v)) {
      const id = counter.n++;
      embeds.push({ id, path, raw: v, parsed: JSON.parse(v) });
      return `@@CV_EMBED_${id}@@`;
    }
    if (Array.isArray(v)) {
      return v.map((x, i) => strip(x, `${path}.${i}`));
    }
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = strip(val, `${path}.${k}`);
      }
      return out;
    }
    return v;
  };
  const transformed = strip(value, basePath);
  let html = prettyPrintJson.toHtml(transformed, OPTS);
  for (const e of embeds) {
    const mode = modes[e.path] === 'RAW' ? 'RAW' : 'JSON';
    const token = `<span class=json-string>"@@CV_EMBED_${e.id}@@"</span>`;
    const lines = html.split('\n');
    const li = lines.findIndex((l) => l.includes(token));
    if (li === -1) {
      continue;
    }
    const indent = (lines[li].match(/^ */) || [''])[0];
    const select = `<select class="cv-embed-sel" data-embed-path="${encodeURIComponent(e.path)}"><option value="JSON"${
      mode === 'JSON' ? ' selected' : ''
    }>JSON</option><option value="RAW"${mode === 'RAW' ? ' selected' : ''}>RAW</option></select>`;
    let content;
    if (mode === 'JSON') {
      // Вложенное дерево печатается с продолжением отступа родительской строки.
      const inner = renderValue(e.parsed, e.path, modes, counter);
      content = inner
        .split('\n')
        .map((l, i) => (i === 0 ? l : `${indent}  ${l}`))
        .join('\n');
    } else {
      content = prettyPrintJson.toHtml(e.raw, OPTS);
    }
    lines[li] = lines[li].replace(token, `${select} ${content}`);
    html = lines.join('\n');
  }
  return html;
}
