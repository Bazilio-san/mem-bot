// Temporal context: date, time, timezone, time of day, day type, the pause since the previous message and
// a hint about the mood of the moment. Date/time/timezone are emitted as an always-on block (formatDateTime),
// while the mood of the moment is emitted only in companion mode (formatTemporalContext).
// Pure module with no external dependencies or side effects. On an invalid timezone it falls back to Moscow time.
const DAYS_RU = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MONTHS_RU = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
];

function userLocalTime(timezone) {
  try {
    return new Date(new Date().toLocaleString('en-US', { timeZone: timezone }));
  } catch {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  }
}

function timeOfDay(hour) {
  if (hour >= 5 && hour < 12) {
    return 'утро';
  }
  if (hour >= 12 && hour < 17) {
    return 'день';
  }
  if (hour >= 17 && hour < 22) {
    return 'вечер';
  }
  return 'ночь';
}

function dayType(dow, hour) {
  if (dow === 0 || dow === 6) {
    return 'выходной';
  }
  if (dow === 5 && hour >= 17) {
    return 'пятница вечер';
  }
  if (dow === 1 && hour < 12) {
    return 'начало рабочей недели';
  }
  return 'будний день';
}

function plural(n, one, few, many) {
  const m10 = n % 10,
    m100 = n % 100;
  if (m100 >= 11 && m100 <= 19) {
    return many;
  }
  if (m10 === 1) {
    return one;
  }
  if (m10 >= 2 && m10 <= 4) {
    return few;
  }
  return many;
}

function timeSince(lastAt) {
  if (!lastAt) {
    return null;
  }
  const ms = Date.now() - new Date(lastAt).getTime();
  const min = Math.floor(ms / 60000),
    hr = Math.floor(ms / 3600000),
    d = Math.floor(ms / 86400000);
  if (min < 5) {
    return null;
  }
  if (min < 60) {
    return `${min} ${plural(min, 'минуту', 'минуты', 'минут')}`;
  }
  if (hr < 24) {
    return `${hr} ${plural(hr, 'час', 'часа', 'часов')}`;
  }
  if (d === 1) {
    return '1 день';
  }
  if (d < 7) {
    return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
  }
  if (d < 14) {
    return 'неделю';
  }
  if (d < 30) {
    return `${Math.floor(d / 7)} недели`;
  }
  return 'больше месяца';
}

function contextHint(tod, dt, since) {
  const h = [];
  if (tod === 'утро') {
    h.push('утро — время планов и энергии, можно спросить о настрое на день');
  }
  if (tod === 'день') {
    h.push('середина дня — человек скорее всего занят, будь краток');
  }
  if (tod === 'вечер') {
    h.push('вечер — время рефлексии, можно поговорить о прошедшем дне');
  }
  if (tod === 'ночь') {
    h.push('поздно — будь деликатен, не дави');
  }
  if (dt === 'выходной') {
    h.push('выходной — уместны отдых, хобби, планы');
  }
  if (dt === 'пятница вечер') {
    h.push('конец рабочей недели, настроение на отдых');
  }
  if (dt === 'начало рабочей недели') {
    h.push('понедельник — можно спросить о планах на неделю');
  }
  if (since && /день|недел|месяц/.test(since)) {
    h.push(`прошло ${since} — можно мягко поинтересоваться, что было`);
  }
  return h.join('; ');
}

export function buildTemporalContext(timezone, lastMessageAt) {
  const t = userLocalTime(timezone);
  const hour = t.getHours(),
    dow = t.getDay();
  const tod = timeOfDay(hour),
    dt = dayType(dow, hour),
    since = timeSince(lastMessageAt);
  return {
    currentDate: `${t.getDate()} ${MONTHS_RU[t.getMonth()]} ${t.getFullYear()}`,
    currentTime: `${String(hour).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`,
    timeOfDay: tod,
    dayOfWeek: DAYS_RU[dow],
    dayType: dt,
    timezone,
    timeSinceLastMessage: since,
    contextHint: contextHint(tod, dt, since),
  };
}

// Compact line with the date, time, day of week and timezone. Passed to the model on EVERY
// request (see agent.js), so we keep it on a single line independent of the pause and the mood of the moment.
export function formatDateTime(ctx) {
  return (
    `Текущая дата и время: ${ctx.currentDate}, ${ctx.currentTime} (${ctx.dayOfWeek}), ` +
    `часовой пояс ${ctx.timezone}.`
  );
}

// Mood of the moment for companion mode: time of day, the pause since the previous message and a tone hint.
// Date, time and timezone are NOT included here — they are emitted by a separate always-on block via formatDateTime.
export function formatTemporalContext(ctx) {
  const lines = [`Период суток: ${ctx.timeOfDay} (${ctx.dayType})`];
  if (ctx.timeSinceLastMessage) {
    lines.push(`Пользователь не писал: ${ctx.timeSinceLastMessage}`);
  }
  if (ctx.contextHint) {
    lines.push(`Подсказка по тону: ${ctx.contextHint}`);
  }
  return lines.join('\n');
}
