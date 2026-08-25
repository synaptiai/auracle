// Reciprocal Rank Fusion — section 4.6, DEC-21.
//
// "RRF uses the ranks. It does not use the scores." BM25 scores have no upper
// limit and cosine values do, so a weighted average of the scores is not
// stable. This module accepts only ordered id lists; it has no way to receive
// a score, which makes a score blend impossible to write.

const DEFAULT_K = 60;

/**
 * Fuses ranked lists into one ordering. `k` dampens the weight of top ranks;
 * the standard value is 60.
 *
 * @param rankedLists - each list holds document ids, best rank first.
 * @returns document ids sorted by descending fused RRF score.
 */
export function rrfFuse(rankedLists: readonly string[][], k: number = DEFAULT_K): string[] {
  if (k <= 0 || !Number.isInteger(k)) {
    throw new RangeError(`RRF k must be a positive integer, got ${k}`);
  }
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    for (const [position, docId] of list.entries()) {
      // Ranks are 1-based; only the position contributes, never a raw score.
      scores.set(docId, (scores.get(docId) ?? 0) + 1 / (k + position + 1));
    }
  }
  return [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)!);
}
