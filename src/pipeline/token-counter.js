// Оценка размера текста в токенах. Используется для решения, надо ли сжимать холодную зону истории,
// и для контроля итогового размера дайджеста. Размеры считаются НАШИМ кодом, а не моделью:
// языковая модель ненадёжно считает собственные токены, поэтому доверять ей расчёт порога нельзя.

// Грубая оценка числа токенов. Для кириллицы делитель меньше привычных 4 символов на токен,
// потому что кириллица кодируется плотнее и деление на 4 сильно занижает размер.
// Заниженная оценка опасна: сжатие запустится слишком поздно, и холодная зона раздуется сверх порога.
// Для срабатывания порога безопаснее завышать оценку, чем занижать.
export function estimateTokens(text) {
  if (!text) return 0;
  const chars = String(text).length;
  const hasCyrillic = /[Ѐ-ӿ]/.test(text);
  const charsPerToken = hasCyrillic ? 3 : 4;
  return Math.ceil(chars / charsPerToken);
}

// Сумма токенов набора сообщений. Если у сообщения уже проставлен token_count — берём его,
// иначе оцениваем по содержимому. Так считается размер непокрытой холодной зоны.
export function sumMessageTokens(messages = []) {
  let total = 0;
  for (const m of messages) {
    const known = Number(m?.token_count);
    total += Number.isFinite(known) && known > 0 ? known : estimateTokens(m?.content || '');
  }
  return total;
}

// Размер уже существующей активной сводки в токенах. Берём сохранённое значение, если оно есть,
// иначе оцениваем по тексту сводки.
export function estimateSummaryTokens(summary) {
  if (!summary) return 0;
  const known = Number(summary.summary_token_count);
  if (Number.isFinite(known) && known > 0) return known;
  return estimateTokens(summary.summary_text || '');
}
