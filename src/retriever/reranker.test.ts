// Section 4.6 / DEC-21: the reranker is on, needs >=50 candidates, and must
// stand down below that. These tests pin the stand-down rule.
import { describe, expect, it, vi } from 'vitest';

import { applyRerank, lexicalRerank, RERANK_MIN_CANDIDATES } from './reranker.js';
import type { RetrievedDoc } from './types.js';

function doc(id: string, title: string): RetrievedDoc {
  return {
    docId: id,
    kind: 'document',
    title,
    body: '',
    owner: 'synthetic-owner',
    reviewBy: '2999-01-01',
    fresh: true,
  };
}

describe('applyRerank', () => {
  it('stands down below 50 candidates and returns the fused order untouched', async () => {
    const rerank = vi.fn(async (_q: string, docs: readonly RetrievedDoc[]) => [...docs].reverse());
    const candidates = Array.from({ length: RERANK_MIN_CANDIDATES - 1 }, (_, i) =>
      doc(`d${i}`, `t${i}`),
    );

    const result = await applyRerank('query', candidates, rerank);

    expect(result).toBe(candidates); // same array, same order — no rerank ran
    expect(rerank).not.toHaveBeenCalled();
  });

  it('engages at exactly 50 candidates', async () => {
    const rerank = vi.fn(async (_q: string, docs: readonly RetrievedDoc[]) =>
      [...docs].reverse(),
    );
    const candidates = Array.from({ length: RERANK_MIN_CANDIDATES }, (_, i) =>
      doc(`d${i}`, `t${i}`),
    );

    const result = await applyRerank('query', candidates, rerank);

    expect(rerank).toHaveBeenCalledOnce();
    expect(result[0]?.docId).toBe('d49');
  });

  it('stands down when no reranker is supplied even with enough candidates', async () => {
    const candidates = Array.from({ length: RERANK_MIN_CANDIDATES + 10 }, (_, i) =>
      doc(`d${i}`, `t${i}`),
    );
    expect(await applyRerank('query', candidates)).toBe(candidates);
  });

  it('exports the architecture minimum of 50', () => {
    // Section 4.6: "At 20 candidates it is worse than no reranker."
    expect(RERANK_MIN_CANDIDATES).toBe(50);
  });
});

describe('lexicalRerank', () => {
  it('moves lexically relevant candidates to the front of a large fused list', async () => {
    const candidates = Array.from({ length: 60 }, (_, i) =>
      doc(`d${i}`, `unrelated topic ${i}`),
    );
    // Token overlap, not stemming: 'refund' must appear verbatim.
    candidates.push(doc('refund-doc', 'refund processing guide', 'how a refund works'));
    candidates.push(doc('error-doc', 'ERR_4471 refund failure code', 'the gateway returns ERR_4471 when the provider rejects'));

    const result = await lexicalRerank('refund ERR_4471', candidates);

    expect(result.slice(0, 2).map((d) => d.docId)).toEqual(['error-doc', 'refund-doc']);
  });

  it('keeps ties in fused order (stable sort)', async () => {
    const candidates = Array.from({ length: 55 }, (_, i) => doc(`d${i}`, `topic ${i}`));
    const result = await lexicalRerank('nothing matches here', candidates);
    expect(result.map((d) => d.docId)).toEqual(candidates.map((d) => d.docId));
  });
});
