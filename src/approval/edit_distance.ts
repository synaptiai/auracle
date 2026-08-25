/**
 * Approval-edit distance metric (section 4.10, Phase 2 online measurement).
 *
 * The measure is a normalized token-level Levenshtein distance between the
 * parked draft body and the final text the person sent:
 *
 *   distance(parked, final) =
 *     levenshtein(tokens(parked), tokens(final))
 *       / max(|tokens(parked)|, |tokens(final)|)
 *
 * Properties the measurement relies on:
 * - 0.0 when the person sent the draft unchanged.
 * - Grows with every inserted, deleted or replaced token.
 * - 1.0 when nothing of the draft survived, or when one side has no tokens.
 * - Normalizing by the longer token count keeps drafts of different lengths
 *   comparable, so the daily sample mixes ticket sizes safely (section 4.10).
 * - Tokens are lowercased words and digits, so casing and punctuation
 *   changes do not register as edits.
 */
const WORD_SPLIT = /[^a-z0-9]+/;

/** Lowercased word tokens of one draft body. Punctuation never survives. */
export function tokenizeBody(text: string): readonly string[] {
  return text.toLowerCase().split(WORD_SPLIT).filter(Boolean);
}

/** Levenshtein edit distance over two token sequences (two-row DP). */
function tokenLevenshtein(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) {
    prev[j] = j;
  }
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitute = prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, substitute);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/**
 * How much the person changed the parked draft before sending it. Pure
 * function; it reads nothing and calls nothing. The result is always in
 * [0, 1].
 */
export function approvalEditDistance(parked: string, final: string): number {
  const parkedTokens = tokenizeBody(parked);
  const finalTokens = tokenizeBody(final);
  const longest = Math.max(parkedTokens.length, finalTokens.length);
  if (longest === 0) {
    return 0;
  }
  return tokenLevenshtein(parkedTokens, finalTokens) / longest;
}
