// Estimates the size of text in tokens. Used to decide whether to compress the cold zone of history,
// and to control the final digest size. Sizes are computed by OUR code, not by the model: a language
// model counts its own tokens unreliably, so its threshold calculation can't be trusted.

// Rough estimate of the token count. For Cyrillic the divisor is smaller than the usual 4 chars per token,
// because Cyrillic is encoded more densely and dividing by 4 badly underestimates the size.
// An underestimate is dangerous: compression would start too late and the cold zone would swell past the
// threshold. For triggering the threshold it's safer to overestimate than to underestimate.
export function estimateTokens(text) {
  if (!text) {
    return 0;
  }
  const chars = String(text).length;
  const hasCyrillic = /[Ѐ-ӿ]/.test(text);
  const charsPerToken = hasCyrillic ? 3 : 4;
  return Math.ceil(chars / charsPerToken);
}

// Sum of tokens across a set of messages. If a message already has token_count set, we take it,
// otherwise we estimate from its content. This is how the size of the uncovered cold zone is computed.
export function sumMessageTokens(messages = []) {
  let total = 0;
  for (const m of messages) {
    const known = Number(m?.token_count);
    total += Number.isFinite(known) && known > 0 ? known : estimateTokens(m?.content || '');
  }
  return total;
}

// Size of an already existing active summary in tokens. We take the stored value if present,
// otherwise we estimate from the summary text.
export function estimateSummaryTokens(summary) {
  if (!summary) {
    return 0;
  }
  const known = Number(summary.summary_token_count);
  if (Number.isFinite(known) && known > 0) {
    return known;
  }
  return estimateTokens(summary.summary_text || '');
}
