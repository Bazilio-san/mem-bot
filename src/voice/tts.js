// Синтез голосового ответа (текст в речь, TTS) для Telegram-канала.
// Модуль относится к канальному слою: ядро ИИ-бота про него не знает и его не вызывает. Здесь собраны
// три обязанности голосовой доставки, скрытые от адаптера за простыми функциями:
//   1) выбор текста для озвучивания (целиком короткий ответ либо краткое резюме длинного/со списками/кодом);
//   2) сам синтез речи через OpenAI-совместимый прокси (конечная точка audio/speech), возвращающий байты OGG/OPUS;
//   3) вспомогательные проверки разметки и соблюдение жёсткого лимита длины.
// Поставщик и модель скрыты внутри: при необходимости их меняют через конфигурацию, не трогая адаптер.
import { config } from '../config.js';
import { chat } from '../llm.js';

// Снять разметку перед синтезом речи. Ответ может прийти с разметкой канала (теги HTML для Telegram либо
// Markdown для веб-чата), и эти знаки нельзя отдавать в синтез — иначе бот зачитает теги и звёздочки вслух.
// Удаляются HTML-теги, восстанавливаются экранированные сущности (&lt; &gt; &amp;) и снимаются основные
// знаки Markdown (звёздочки, подчёркивания, обратные кавычки, решётки заголовков, маркеры цитат).
export function stripMarkup(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')                                       // HTML-теги
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') // экранированные сущности обратно
    .replace(/`{1,3}/g, '')                                        // обратные кавычки кода
    .replace(/(\*\*|__|\*|_)/g, '')                                // жирный/курсив Markdown
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')                            // решётки заголовков в начале строки
    .replace(/^\s*>\s?/gm, '');                                    // маркеры цитат в начале строки
}

// Признак, что ответ содержит код или длинные списки и потому плохо звучит вслух. Срабатывает на блоки кода
// в тройных обратных кавычках и на два и более подряд идущих пунктов маркированного или нумерованного списка.
export function hasCodeOrList(text) {
  const s = String(text || '');
  if (/```/.test(s)) return true;
  const listLines = s.split('\n').filter((line) => /^\s*([-*•]|\d+[.)])\s+/.test(line));
  return listLines.length >= 2;
}

// Обрезать строку до предела по возможности на границе предложения. Если подходящей границы в пределах лимита
// нет (она пришлась бы на самое начало), режем жёстко по лимиту. Результат очищается от крайних пробелов.
export function clampToLimit(text, limit) {
  const s = String(text || '').trim();
  if (s.length <= limit) return s;
  const slice = s.slice(0, limit);
  const m = slice.match(/[\s\S]*[.!?…](?:\s|$)/);
  let cut = m ? m[0].length : -1;
  if (cut < limit * 0.5) cut = limit;                              // удобной границы нет — режем по лимиту
  return s.slice(0, cut).trim();
}

// Построить краткое резюме длинного ответа вспомогательной быстрой моделью. Инструкция требует уложиться в
// заданный предел символов и передать смысл без кода и списков, потому что озвучивается именно это резюме.
async function summarizeForVoice(answer, summaryLimit) {
  const messages = [
    {
      role: 'system',
      content: `Ты сжимаешь ответ ассистента в короткое резюме для озвучивания вслух. Правила: передай суть на том
же языке, что и исходный ответ; не включай код, разметку, ссылки и перечни по пунктам; пиши связными
предложениями; уложись строго в ${summaryLimit} символов. Верни только текст резюме без пояснений.`,
    },
    { role: 'user', content: answer },
  ];
  const msg = await chat({ model: config.voiceOutput.summaryModel, messages });
  return (msg.content || '').trim();
}

// Выбрать текст для озвучивания и признак того, что это резюме (а не полный ответ).
// Короткий ответ без кода и списков озвучивается целиком. Иначе строится резюме в пределах лимита; если резюме
// получить не удалось (пустой ответ модели), возвращается text: null — это сигнал каналу откатиться на текст.
// Параметр opts.summarize позволяет подменить построение резюме в тестах; по умолчанию используется модель.
export async function buildVoiceText(answer, opts = {}) {
  const hardLimit = config.voiceOutput.maxChars;
  const summaryLimit = Math.min(config.voiceOutput.summaryMaxChars, hardLimit);
  const raw = String(answer || '').trim();
  // Признак кода и списков проверяется по исходному размеченному тексту: именно разметка (блоки кода,
  // пункты списка) служит сигналом построить резюме, поэтому снимать её до проверки нельзя.
  const codeOrList = hasCodeOrList(raw);
  const clean = stripMarkup(raw).trim();

  if (clean.length <= hardLimit && !codeOrList) {
    return { text: clean, summarized: false };
  }

  const summarize = opts.summarize || summarizeForVoice;
  let summary = '';
  try {
    summary = await summarize(clean, summaryLimit);
  } catch {
    summary = '';
  }
  const text = clampToLimit(stripMarkup(summary), summaryLimit);
  return { text: text || null, summarized: true };
}

// Синтезировать речь из текста и вернуть байты голосового сообщения в формате OGG/OPUS.
// Запрос идёт напрямую (fetch) к конечной точке audio/speech того же прокси, что и остальные вызовы модели.
// Прокси периодически обрывает соединение по тайм-ауту, поэтому делаем несколько повторных попыток. Заголовок
// content-type ответа у прокси недостоверен (всегда audio/mpeg), поэтому ориентируемся на запрошенный формат.
// Параметр opts.fetch позволяет подменить сеть в тестах; по умолчанию используется глобальный fetch.
export async function synthesizeSpeech(text, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const baseURL = config.llm.baseURL.replace(/\/$/, '');
  const url = `${baseURL}/audio/speech`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.llm.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.voiceOutput.model,
          input: text,
          voice: config.voiceOutput.voice,
          response_format: config.voiceOutput.format,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`HTTP ${res.status}: ${errText.slice(0, 200)}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('прокси вернул пустой аудиоответ');
      return buf;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
