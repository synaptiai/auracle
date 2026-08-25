// Tests for the approval-edit distance metric (section 4.10).
//
// Three bands pin the contract the daily sample depends on: an unchanged
// draft reads exactly 0, a partially edited draft lands strictly between
// 0 and 1, and a fully rewritten draft reads exactly 1. A second group
// pins what does not count as an edit: casing, punctuation and whitespace.

import { describe, expect, it } from 'vitest';

import { approvalEditDistance, tokenizeBody } from './edit_distance.js';

describe('approvalEditDistance', () => {
  it('reads 0 when the person sent the draft unchanged', () => {
    const body = 'Please reset your password from the login page.';
    expect(approvalEditDistance(body, body)).toBe(0);
  });

  it('reads strictly between 0 and 1 for a partially edited draft', () => {
    const parked = 'Please reset your password from the login page.';
    const final = 'Please reset your password from the login page within one hour.';

    const distance = approvalEditDistance(parked, final);

    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThan(1);
  });

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
