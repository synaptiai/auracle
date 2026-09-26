// DEC-21: RRF fuses ranks only. These tests pin the property that makes the
// fusion stable — a weighted average of scores would break every one of them.
import { describe, expect, it } from 'vitest';

import { rrfFuse } from './rrf.js';

describe('rrfFuse', () => {
  it('ignores score magnitude entirely: lists are ordered positions, so rescaled inputs fuse identically', () => {
    // BM25 scores are unbounded and cosine values are not. If the fusion read
    // a score instead of a rank, these two inputs could not give one result.
    const lexical = ['a', 'b', 'c'];
    const dense = ['b', 'c', 'd'];

    // b: 1/61 + 1/61; c: 1/62 + 1/62; a: 1/61 + 1/63; d: 1/63.
    expect(rrfFuse([lexical, dense])).toEqual(['b', 'c', 'a', 'd']);
  });

  it('raises a document that both channels agree on above single-channel leaders', () => {
    const lexical = ['onlyLexical', 'both', 'filler'];
    const dense = ['onlyDense1', 'both', 'filler'];
    const fused = rrfFuse([lexical, dense]);

    expect(fused.indexOf('both')).toBeLessThan(fused.indexOf('onlyLexical'));
    expect(fused.indexOf('both')).toBeLessThan(fused.indexOf('onlyDense1'));
  });

  it('handles empty lists and an empty input', () => {
    expect(rrfFuse([])).toEqual([]);
    expect(rrfFuse([[]])).toEqual([]);
    expect(rrfFuse([[], ['a']])).toEqual(['a']);
  });

  it('rejects a non-positive or fractional k', () => {
    expect(() => rrfFuse([['a']], 0)).toThrow(RangeError);
    expect(() => rrfFuse([['a']], 1.5)).toThrow(RangeError);
  });
});
