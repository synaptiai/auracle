// What the ledger records as the approver — DEC-42.
//
// The value arrives from a header a trusted proxy set. It is a claim rather
// than an authentication, and the bound and the character check live at the
// approval chokepoint rather than in a caller, so a console that forgets them
// cannot bypass them.
import { describe, expect, it } from 'vitest';

import { approverFrom, UNATTRIBUTED } from './approve.js';

describe('the approver a reply records', () => {
  it('takes the name a trusted proxy supplied', () => {
    expect(approverFrom('ops-oncall')).toBe('ops-oncall');
  });

  it('trims what the header padded', () => {
    expect(approverFrom('  ops-oncall  ')).toBe('ops-oncall');
  });

  it('records that nobody was named when nobody was', () => {
    expect(approverFrom(undefined)).toBe(UNATTRIBUTED);
    expect(approverFrom('')).toBe(UNATTRIBUTED);
    expect(approverFrom('   ')).toBe(UNATTRIBUTED);
  });

  // A control character in an audit value is a log-injection primitive: it
  // lets one recorded approver forge the appearance of another line.
  it('names nobody rather than record a control character', () => {
    for (const code of [0x00, 0x07, 0x0a, 0x0d, 0x09, 0x1b, 0x7f]) {
      const claimed = `ops${String.fromCharCode(code)}admin`;
      expect(approverFrom(claimed), `U+${code.toString(16)}`).toBe(UNATTRIBUTED);
    }
  });

  it('keeps an ordinary name that merely contains a space', () => {
    expect(approverFrom('ops oncall')).toBe('ops oncall');
  });

  // `text` is unbounded in Postgres, so the bound is this function's own.
  it('names nobody rather than record an unbounded value', () => {
    expect(approverFrom('a'.repeat(256))).toBe('a'.repeat(256));
    expect(approverFrom('a'.repeat(257))).toBe(UNATTRIBUTED);
  });

  // It never throws. DEC-42 says an unnamed approver is a recorded fact, and
  // refusing the approval over the audit field would put a customer reply
  // behind a header's formatting.
  it('never refuses the approval over the shape of this value', () => {
    for (const claimed of ['', '   ', 'a'.repeat(10_000), 'ok']) {
      expect(() => approverFrom(claimed)).not.toThrow();
    }
  });
});
