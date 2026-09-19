// DEC-51: how long a console send waits before the relay may post it.
//
// The period is what the pages promise, so the default is asserted here
// rather than only in the module that reads it: a card or a runbook stating a
// window the console does not use would be a sentence about another console.
import { describe, expect, it } from 'vitest';

import { MAX_SEND_HOLD_MS, SEND_HOLD_MS, requireSendHold } from './send-hold.js';

describe('the period a console send waits (DEC-51)', () => {
  it('defaults to the twelve seconds the undo button counts', () => {
    expect(SEND_HOLD_MS).toBe(12_000);
    expect(requireSendHold(undefined)).toBe(SEND_HOLD_MS);
    expect(requireSendHold('')).toBe(SEND_HOLD_MS);
    expect(requireSendHold('   ')).toBe(SEND_HOLD_MS);
  });

  it('reads the period an operator sets', () => {
    expect(requireSendHold('45000')).toBe(45_000);
    // Zero is a decision, not a mistake: an adopter who wants no window says
    // so rather than losing the feature by accident.
    expect(requireSendHold('0')).toBe(0);
  });

  it('refuses a period that is not whole milliseconds at or above zero', () => {
    for (const raw of ['-1', '1.5', 'soon', '12s', '1e309']) {
      expect(() => requireSendHold(raw), raw).toThrow(/CONSOLE_SEND_HOLD_MS/);
    }
  });

  // The bound, from both sides: the last value it accepts, and the first it
  // refuses. A cap asserted only from above would pass on a module that
  // refused everything.
  it('refuses a period above the bound, and takes the bound itself', () => {
    expect(requireSendHold(String(MAX_SEND_HOLD_MS))).toBe(MAX_SEND_HOLD_MS);
    for (const raw of [String(MAX_SEND_HOLD_MS + 1), '600000', '86400000']) {
      expect(() => requireSendHold(raw), raw).toThrow(/CONSOLE_SEND_HOLD_MS/);
    }
  });
});
