// One definition of the last complete UTC day (issue #73).
import { describe, expect, it } from 'vitest';

import { lastCompleteDay } from './day.js';

describe('lastCompleteDay', () => {
  it('names yesterday, not today', () => {
    // A partial day compared against whole-day baselines reads as an
    // excursion every morning, and the three-sigma action is a pull request.
    expect(lastCompleteDay(new Date('2026-09-12T03:00:00.000Z'))).toBe('2026-09-11');
  });

  it('crosses a month boundary', () => {
    expect(lastCompleteDay(new Date('2026-09-01T00:00:00.000Z'))).toBe('2026-08-31');
  });

  it('crosses a year boundary', () => {
    expect(lastCompleteDay(new Date('2026-01-01T12:00:00.000Z'))).toBe('2025-12-31');
  });

  it('is stable across the whole of a UTC day', () => {
    expect(lastCompleteDay(new Date('2026-09-12T00:00:00.000Z'))).toBe('2026-09-11');
    expect(lastCompleteDay(new Date('2026-09-12T23:59:59.999Z'))).toBe('2026-09-11');
  });

  it('refuses an invalid date by name', () => {
    // The seed copy had no check, so an invalid date reached `toISOString`
    // and threw a bare RangeError that said nothing about what was wrong.
    expect(() => lastCompleteDay(new Date('not a date'))).toThrow(
      /cannot name the last complete day from an invalid date/,
    );
  });
});
