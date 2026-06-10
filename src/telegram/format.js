// Prepares the answer text for delivery to Telegram with HTML markup (parse_mode=HTML).
// The module belongs to the channel layer: the AI bot core knows nothing about it. It has two responsibilities:
//   1) telegramPostProcess — reduce arbitrary HTML from the model to the subset of tags the Telegram Bot API
//      understands, and escape stray "&", "<", ">" in plain text (via sanitize-html);
//   2) telegramSplit — split a long text into parts under the Telegram limit so that no chunk contains a
//      truncated or unclosed tag (splitting at tag boundaries, carrying markup over between parts).
import sanitizeHtml from 'sanitize-html';

// Allowlist of Telegram markup tags. Anything outside this list is escaped by sanitize-html as plain text
// (disallowedTagsMode: 'escape'), so a stray or model-invented tag does not break the markup but is shown
// literally. The list matches the text styles Telegram supports.
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
    code: ['class'], // <code class="language-…"> inside <pre> — language highlighting in a code block
    span: ['class'], // <span class="tg-spoiler"> — spoiler
  },
  // Disallowed tags are escaped rather than dropped — so text like "1 < 2" or a stray "<div>"
  // reaches the user as written instead of disappearing.
  disallowedTagsMode: 'escape',
  // Telegram accepts only http/https/tg links; other schemes (javascript:, etc.) are cut off.
  allowedSchemes: ['http', 'https', 'tg'],
  // Line breaks in the source text are meaningful (lists, paragraphs) — don't let the library "tidy" them.
  allowedSchemesByTag: {},
};

// Telegram HTML markup has no line-break tag <br>: a break is given by the "\n" character. The model, however,
// often inserts <br>, <br/> or <br />, and without this replacement sanitize-html would escape them and show
// them to the user literally. So before sanitizing we convert any <br> variant into a real line break.
const BR_TAG = /<br\s*\/?>/gi;

// Reduce the model's HTML answer to markup that Telegram can safely accept with parse_mode=HTML.
export function telegramPostProcess(text) {
  const withLineBreaks = String(text ?? '').replace(BR_TAG, '\n');
  return sanitizeHtml(withLineBreaks, SANITIZE_OPTIONS);
}

// Split marked-up HTML text into parts no longer than limit at tag boundaries.
//
// The text is broken into tokens — tags and chunks of plain text. Chunks are accumulated into the current part
// taking the stack of open tags into account: when adding a token would exceed the limit, the current part is
// closed with all open tags, and the next one starts by reopening them. This way no part contains a truncated
// tag or unclosed markup. A long chunk of text without tags is additionally cut at a line boundary, or at a
// space if there is none, or hard at the limit.
export function telegramSplit(text, limit) {
  const s = String(text ?? '');
  if (s.length <= limit) {
    return [s];
  }

  const tokens = tokenizeHtml(s);
  const parts = [];
  const open = []; // stack of open tags: { name, raw }
  let cur = '';

  const closingMarkup = () =>
    open
      .map((t) => `</${t.name}>`)
      .reverse()
      .join('');
  const openingMarkup = () => open.map((t) => t.raw).join('');

  // Close the current part (appending closing tags) and start a new one by reopening the same tags.
  const flush = () => {
    parts.push(cur + closingMarkup());
    cur = openingMarkup();
  };

  // Reserve that must be kept free for the closing tags of the current part.
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
    // Plain text: append in chunks while it fits; otherwise cut at a boundary and carry the part over.
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
  // Drop empty trailing parts (e.g. a remainder consisting only of reopened tags).
  return parts.filter((p, i) => p.length || i === 0);
}

// Break the string into tokens: tags (<...>) and chunks of plain text between them.
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

// Update the stack of open tags for the next tag: an opening tag is pushed onto the stack, a closing tag pops
// its matching one. There are no self-closing tags in Telegram markup, so we don't consider them.
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

// Choose where to cut a chunk of text within room characters: preferably at the last line break, then at the
// last space; if there is no convenient boundary, cut exactly at room.
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
