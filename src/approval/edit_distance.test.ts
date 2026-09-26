// Tests for the approval-edit distance metric (section 4.10).
//
// The E2E suites pin an unchanged draft at exactly 0 and a partial edit
// strictly between 0 and 1 (src/e2e/v1-flow.db.test.ts). What is here: a
// fully rewritten draft reads exactly 1, the empty-body edges, and what does
// not count as an edit: casing, punctuation and whitespace.

import { describe, expect, it } from 'vitest';

import { approvalEditDistance, tokenizeBody } from './edit_distance.js';

describe('approvalEditDistance', () => {
  it('reads 1 when nothing of the draft survived', () => {
    expect(approvalEditDistance('ship it today', 'totally different words here')).toBe(1);
  });

  it('does not count casing, punctuation or extra spacing as edits', () => {
    expect(approvalEditDistance('Reset your PIN now.', 'reset your PIN  now!')).toBe(0);
  });

  it('treats two empty bodies as identical', () => {
    expect(approvalEditDistance('', '')).toBe(0);
  });

  it('reads 1 when one side carries no tokens at all', () => {
    expect(approvalEditDistance('', 'words only here')).toBe(1);
    expect(approvalEditDistance('some words', '!!! ...')).toBe(1);
  });
});

describe('tokenizeBody', () => {
  it('keeps words and digits and drops punctuation', () => {
    expect(tokenizeBody('Order 47 arrived broken!')).toEqual(['order', '47', 'arrived', 'broken']);
  });
});
