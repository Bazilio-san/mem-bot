// Подготовка текста ответа к доставке в Telegram с разметкой HTML (parse_mode=HTML).
// Модуль относится к канальному слою: ядро ИИ-бота про него не знает. Здесь две обязанности:
//   1) telegramPostProcess — привести произвольный HTML от модели к подмножеству тегов, которое понимает
//      Telegram Bot API, и экранировать одиночные «&», «<», «>» в обычном тексте (через sanitize-html);
//   2) telegramSplit — разбить длинный текст на части под лимит Telegram так, чтобы ни один кусок не
//      содержал оборванный или незакрытый тег (разбивка по границам тегов с переносом разметки между частями).
import sanitizeHtml from 'sanitize-html';

// Белый список тегов разметки Telegram. Всё, что вне этого списка, sanitize-html экранирует как обычный
// текст (режим disallowedTagsMode: 'escape'), поэтому случайный или выдуманный моделью тег не ломает
// разметку, а показывается буквально. Перечень соответствует поддерживаемым Telegram стилям текста.
const TELEGRAM_ALLOWED_TAGS = [
  'b',
  'strong',
  'i',
  'em',
  'u',
  'ins',
  's',
  'strike',
  'del',
  'a',
  'code',
  'pre',
  'blockquote',
  'span',
  'tg-spoiler',
];

const SANITIZE_OPTIONS = {
  allowedTags: TELEGRAM_ALLOWED_TAGS,
  allowedAttributes: {
    a: ['href'],
    code: ['class'], // <code class="language-…"> внутри <pre> — подсветка языка в блоке кода
    span: ['class'], // <span class="tg-spoiler"> — спойлер
  },
  // Недопустимые теги не выкидываем, а экранируем — так текст вида «1 < 2» или случайный «<div>»
  // доходит до пользователя как написано, а не пропадает.
  disallowedTagsMode: 'escape',
  // Telegram принимает только http/https/tg-ссылки; прочие схемы (javascript: и т. п.) отсекаются.
  allowedSchemes: ['http', 'https', 'tg'],
  // Перенос строк в исходном тексте значим (списки, абзацы) — не даём библиотеке его «причёсывать».
  allowedSchemesByTag: {},
};

// Telegram-разметка HTML не знает тега переноса строки <br>: перенос задаётся символом «\n». Модель же
// нередко вставляет <br>, <br/> или <br />, и без этой замены sanitize-html экранировал бы их и показывал
// пользователю буквально. Поэтому до санитайза переводим любые варианты <br> в реальный перенос строки.
const BR_TAG = /<br\s*\/?>/gi;

// Привести HTML-ответ модели к разметке, которую безопасно принять Telegram с parse_mode=HTML.
export function telegramPostProcess(text) {
  const withLineBreaks = String(text ?? '').replace(BR_TAG, '\n');
  return sanitizeHtml(withLineBreaks, SANITIZE_OPTIONS);
}

// Разбить размеченный HTML-текст на части не длиннее limit по границам тегов.
//
// Текст разбирается на токены — теги и куски обычного текста. Куски набираются в текущую часть с учётом
// стека открытых тегов: когда добавление токена превысило бы лимит, текущая часть закрывается всеми
// открытыми тегами, а следующая начинается с их повторного открытия. Так ни одна часть не содержит
// оборванного тега и незакрытой разметки. Длинный кусок текста без тегов дополнительно режется по границе
// строки, а при её отсутствии — по пробелу либо жёстко по лимиту.
export function telegramSplit(text, limit) {
  const s = String(text ?? '');
  if (s.length <= limit) {
    return [s];
  }

  const tokens = tokenizeHtml(s);
  const parts = [];
  const open = []; // стек открытых тегов: { name, raw }
  let cur = '';

  const closingMarkup = () =>
    open
      .map((t) => `</${t.name}>`)
      .reverse()
      .join('');
  const openingMarkup = () => open.map((t) => t.raw).join('');

  // Закрыть текущую часть (дописав закрывающие теги) и начать новую с повторного открытия тех же тегов.
  const flush = () => {
    parts.push(cur + closingMarkup());
    cur = openingMarkup();
  };

  // Запас, который нужно держать свободным под закрывающие теги текущей части.
  const reserve = () => closingMarkup().length;

  for (const tok of tokens) {
    if (tok.type === 'tag') {
      if (cur.length + tok.value.length + reserve() > limit && cur.length > openingMarkup().length) {
        flush();
      }
      cur += tok.value;
      applyTag(open, tok);
      continue;
    }
    // Обычный текст: добавляем по кускам, пока влезает; иначе режем по границе и переносим часть.
    let rest = tok.value;
    while (rest.length) {
      const room = limit - cur.length - reserve();
      if (rest.length <= room) {
        cur += rest;
        break;
      }
      if (room <= 0) {
        flush();
        continue;
      }
      const cut = chooseCut(rest, room);
      cur += rest.slice(0, cut);
      rest = rest.slice(cut);
      flush();
    }
  }

  parts.push(cur);
  // Пустые хвостовые части (например, остаток только из реоткрытых тегов) отбрасываем.
  return parts.filter((p, i) => p.length || i === 0);
}

// Разобрать строку на токены: теги (<...>) и куски обычного текста между ними.
function tokenizeHtml(s) {
  const tokens = [];
  const re = /<\/?[A-Za-z][^>]*>/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) {
      tokens.push({ type: 'text', value: s.slice(last, m.index) });
    }
    tokens.push({ type: 'tag', value: m[0] });
    last = re.lastIndex;
  }
  if (last < s.length) {
    tokens.push({ type: 'text', value: s.slice(last) });
  }
  return tokens;
}

// Обновить стек открытых тегов по очередному тегу: открывающий — кладём в стек, закрывающий — снимаем
// парный. Самозакрывающихся тегов в разметке Telegram нет, поэтому их не рассматриваем.
function applyTag(open, tok) {
  const closing = tok.value.startsWith('</');
  const name = (tok.value.match(/^<\/?\s*([A-Za-z][A-Za-z0-9-]*)/) || [])[1];
  if (!name) {
    return;
  }
  if (closing) {
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].name === name) {
        open.splice(i, 1);
        break;
      }
    }
  } else {
    open.push({ name, raw: tok.value });
  }
}

// Выбрать место разреза куска текста в пределах room символов: предпочтительно по последнему переносу
// строки, затем по последнему пробелу; если удобной границы нет — режем ровно по room.
function chooseCut(text, room) {
  const slice = text.slice(0, room);
  const nl = slice.lastIndexOf('\n');
  if (nl >= room * 0.5) {
    return nl + 1;
  }
  const sp = slice.lastIndexOf(' ');
  if (sp >= room * 0.5) {
    return sp + 1;
  }
  return room;
}
