// The corpus clears the per-intent trigger, and every case says what
// labelled it (issue #26).
//
// Section 3.3's arithmetic puts the rank-20 intent at about 7 700 cases, and
// DEC-41 fits a threshold for each intent above that trigger. A corpus below
// it can never exercise the per-intent path with a real fit, so the size is a
// property of the design and not a preference.
//
// The other half of DEC-41 is provenance. A threshold states what labelled
// the cases behind it, so every case carries that name. `method:
// "human-review"` keeps one meaning, and a model label never enters it.
import { describe, expect, it } from 'vitest';

import { FIT_COUNT, INTENT_CAP, REPORT_COUNT } from '../domain/gold-types.js';
import { loadGoldSet } from './load.js';

/**
 * The trigger, from section 3.3.
 *
 * One global threshold needs 385 labelled cases for an interval of 5 per
 * cent. A threshold for each of 25 intents needs about 2 400. Intent
 * frequencies obey a Zipf distribution, so the intent at rank 20 needs about
 * 7 700. The roadmap rounds that to 8 000.
 */
const TRIGGER_MIN_LABELLED = 8_000;

describe('the gold corpus', () => {
  it('clears the per-intent trigger, so the fit has something to fit', () => {
    expect(FIT_COUNT + REPORT_COUNT).toBeGreaterThanOrEqual(TRIGGER_MIN_LABELLED);
  });

  // DEC-31 splits one gold set in two. An asymmetric pair would give the two
  // halves different meanings, which that decision does not contemplate.
  it('grows both halves together, never one of them', () => {
    expect(Math.abs(FIT_COUNT - REPORT_COUNT)).toBeLessThanOrEqual(1);
    const { fit, report } = loadGoldSet();
    expect(fit.count).toBe(FIT_COUNT);
    expect(report.count).toBe(REPORT_COUNT);
  });

  it('names what labelled every case, in both halves', () => {
    const { fit, report } = loadGoldSet();
    for (const half of [fit, report]) {
      for (const ticket of half.tickets) {
        expect(typeof ticket.labelled_by).toBe('string');
        expect(ticket.labelled_by).not.toBe('');
        // The provenance rule of DEC-41. A model label is never a human one.
        expect(ticket.labelled_by).not.toBe('human-review');
      }
    }
  });

  // The trigger is about the rank-20 intent, so the count alone is not
  // enough: the fit needs cases for each intent, not 8 200 of one.
  it('keeps the stratification the split had, in both halves', () => {
    const { fit, report } = loadGoldSet();
    const countBy = (tickets: readonly { intent: string }[]): Map<string, number> => {
      const seen = new Map<string, number>();
      for (const t of tickets) seen.set(t.intent, (seen.get(t.intent) ?? 0) + 1);
      return seen;
    };
    const inFit = countBy(fit.tickets);
    const inReport = countBy(report.tickets);

    expect(inFit.size).toBeLessThanOrEqual(INTENT_CAP);
    // Every intent reaches both halves. An intent present in one alone would
    // make the two halves score different populations.
    expect([...inFit.keys()].sort()).toEqual([...inReport.keys()].sort());

    // And each intent lands in the two halves in nearly equal number, which
    // is what the alternating split gives.
    for (const [intent, n] of inFit) {
      expect(Math.abs(n - (inReport.get(intent) ?? 0))).toBeLessThanOrEqual(1);
    }
  });
});
