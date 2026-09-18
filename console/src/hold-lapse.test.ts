// The hold period, and the default three documents state (DEC-46, #107).
//
// A behaviour test rather than a reading of `main.ts`: the entry point runs
// `main()` when it is imported, so the period it uses is a value only this
// module can be asked about.
import { describe, expect, it } from 'vitest';

import { HOLD_LAPSE_MS, requireHoldLapse } from './hold-lapse.js';

describe('the period a case counts as held', () => {
  // The number the design notes card says, the runbook repeats and
  // `.env.example` documents: twenty minutes.
  it('defaults to the twenty minutes the pages state', () => {
    expect(requireHoldLapse(undefined)).toBe(HOLD_LAPSE_MS);
    expect(HOLD_LAPSE_MS).toBe(20 * 60 * 1_000);
    // An empty or whitespace value is no value: an operator who wrote the
    // variable and left it blank wants the default, not a refusal.
    expect(requireHoldLapse('')).toBe(HOLD_LAPSE_MS);
    expect(requireHoldLapse('   ')).toBe(HOLD_LAPSE_MS);
  });

  it('takes the period the operator names', () => {
    expect(requireHoldLapse('60000')).toBe(60_000);
    expect(requireHoldLapse(' 900000 ')).toBe(900_000);
  });

  // A period of nothing holds nothing, and a fractional one is a unit
  // mistake. Both are refused at startup rather than at the first take.
  it('refuses a period that is not whole milliseconds above zero', () => {
    for (const raw of ['0', '-1', '1.5', 'abc', 'NaN', 'Infinity', '60s']) {
      expect(() => requireHoldLapse(raw), raw).toThrow(
        `CONSOLE_HOLD_LAPSE_MS must be whole milliseconds above zero, got '${raw}'`,
      );
    }
  });
});
