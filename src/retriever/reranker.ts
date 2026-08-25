// Reranker gate and reference reranker — section 4.6, DEC-21.
//
// DEC-21 makes the reranker active: it gives the largest single quality
// increase (~17 points of MRR@3). But it needs a minimum of 50 candidates;
// at 20 candidates it is worse than no reranker. The stand-down below is the
// rule under test, not a tunable.

import type { RetrievedDoc } from './types.js';

/** Section 4.6: "The reranker needs a minimum of 50 candidates." */
export const RERANK_MIN_CANDIDATES = 50;

/**
 * The reranker is a port so adopters can supply a cross-encoder through
 * OpenRouter (DEC-16) without touching the retrieval path.
 */
export type Rerank = (query: string, docs: readonly RetrievedDoc[]) => Promise<RetrievedDoc[]>;

/**
 * Applies `rerank` only when enough candidates exist; otherwise stands down
 * and returns the fused order unchanged.
 */
export async function applyRerank(
  query: string,
  candidates: RetrievedDoc[],
  rerank?: Rerank,
): Promise<RetrievedDoc[]> {
  if (!rerank || candidates.length < RERANK_MIN_CANDIDATES) {
    return candidates;
  }
  return rerank(query, candidates);
}

/**
 * Reference reranker: orders candidates by lexical overlap with the query.
 * Implementation detail — replaceable by any cross-encoder behind Rerank.
 * Ties keep the incoming (fused) order via a stable sort.
 */
export const lexicalRerank: Rerank = async (query, docs) => {
  const terms = new Set(tokenize(query));
  const scored = docs.map((doc, position) => ({
    doc,
    position,
    hits: tokenize(`${doc.title} ${doc.body}`).filter((t) => terms.has(t)).length,
  }));
  return scored
    .sort((a, b) => b.hits - a.hits || a.position - b.position)
    .map((s) => s.doc);
};

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
