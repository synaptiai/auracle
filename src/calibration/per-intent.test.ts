// The per-intent fit, its trigger and its data floor (DEC-41).
//
// DEC-13 binds below the labelled-case trigger: one global threshold. DEC-41
// governs above it: a threshold for each intent that has enough cases to fit
// one. The amendment in the register states which governs when, and this
// suite is where that boundary is enforced rather than described.
//
// The failure this guards is a threshold fitted from too few cases. Such a
// number is noise wearing the shape of evidence, and it would gate live
// traffic. An intent below the floor keeps the global threshold, and the
// artifact names it so a reader can see which intents were not fitted.
import { describe, expect, it } from 'vitest';

import { TRIGGER_MIN_LABELLED, fitPerIntent } from './per-intent.js';
import type { IntentSample } from './per-intent.js';

/** `n` samples for one intent, `correct` of them right at agreement 0.9. */
function samplesFor(intent: string, n: number, correct: number): IntentSample[] {
  return Array.from({ length: n }, (_, i) => ({
    intent,
    agreement: 0.9,
    correct: i < correct,
  }));
}

const TARGET = 0.9;

describe('the per-intent fit', () => {
  // Below the trigger DEC-13 still binds, whatever the data would allow.
  it('fits nothing per intent below the trigger, and says so', () => {
    const cases = [...samplesFor('refund-request', 500, 500), ...samplesFor('other', 500, 500)];
    // A corpus of 2000, so the fit half of 1000 sits well below the trigger.
    const fit = fitPerIntent(cases, { targetPrecision: TARGET, labelledCases: 2_000 });

    expect(fit.labelled_cases).toBe(2_000);
    expect(fit.fit_cases).toBe(1_000);
    expect(fit.trigger_min_labelled).toBe(TRIGGER_MIN_LABELLED);
    expect(fit.per_intent).toEqual({});
    expect(fit.triggered).toBe(false);
  });

  // At or above it, DEC-41 governs.
  it('fits a threshold for each intent that clears the data floor', () => {
    const cases = [
      ...samplesFor('refund-request', 4_500, 4_400),
      ...samplesFor('billing-dispute', 3_600, 3_500),
    ];
    const fit = fitPerIntent(cases, { targetPrecision: TARGET, labelledCases: cases.length * 2 });

    expect(fit.triggered).toBe(true);
    expect(fit.labelled_cases).toBe(16_200);
    expect(fit.fit_cases).toBe(8_100);
    expect(Object.keys(fit.per_intent).sort()).toEqual(['billing-dispute', 'refund-request']);
    for (const threshold of Object.values(fit.per_intent)) {
      expect(threshold).toBeGreaterThan(0);
      expect(threshold).toBeLessThanOrEqual(1);
    }
  });

  // The failure mode the floor exists for.
  it('falls back to the global threshold below the data floor, and names the intent', () => {
    const cases = [
      ...samplesFor('refund-request', 8_000, 7_900),
      // Far too few to fit anything from.
      ...samplesFor('chargeback-notice', 12, 11),
    ];
    const fit = fitPerIntent(cases, { targetPrecision: TARGET, labelledCases: cases.length * 2 });

    expect(fit.triggered).toBe(true);
    expect(Object.keys(fit.per_intent)).toEqual(['refund-request']);
    expect(fit.below_floor).toEqual(['chargeback-notice']);
    // Naming it is the point: a reader can see which intents kept the global
    // threshold rather than inferring it from an absence.
    expect(fit.per_intent['chargeback-notice']).toBeUndefined();
  });

  // A threshold of zero passes every ticket, which is the gate switched off.
  //
  // It arises honestly rather than hypothetically: agreement is allowed to be
  // zero, so an intent whose cases all sit at zero agreement and are all
  // correct fits a threshold of exactly zero. That intent must fall back.
  it('refuses a fitted threshold of zero, which would pass every ticket', () => {
    const zeroed = Array.from({ length: 4_000 }, () => ({
      intent: 'billing-dispute',
      agreement: 0,
      correct: true,
    }));
    const cases = [...samplesFor('refund-request', 4_500, 4_400), ...zeroed];
    const fit = fitPerIntent(cases, { targetPrecision: TARGET, labelledCases: cases.length * 2 });

    expect(fit.triggered).toBe(true);
    expect(fit.per_intent['billing-dispute']).toBeUndefined();
    expect(fit.below_floor).toContain('billing-dispute');
    for (const [intent, threshold] of Object.entries(fit.per_intent)) {
      expect(threshold, intent).toBeGreaterThan(0);
      expect(threshold, intent).toBeLessThanOrEqual(1);
    }
  });

  // An intent whose cases cannot reach the precision floor has no fittable
  // threshold. It must fall back rather than ship a weak one.
  it('falls back for an intent that cannot reach the precision floor', () => {
    const cases = [
      ...samplesFor('refund-request', 8_000, 7_900),
      // Half wrong at every agreement value, so no threshold reaches 0.9.
      ...samplesFor('billing-dispute', 400, 200),
    ];
    const fit = fitPerIntent(cases, { targetPrecision: TARGET, labelledCases: cases.length * 2 });
    expect(Object.keys(fit.per_intent)).toEqual(['refund-request']);
    expect(fit.below_floor).toContain('billing-dispute');
  });
});

// The fit keys its map the same way the gate reads it.
describe('the intent vocabulary the fit writes', () => {
  it('keys the map on the normalised id, whatever the corpus spells', () => {
    const cases = [
      ...samplesFor('Refund-Request', 4_500, 4_400),
      ...samplesFor('  billing-dispute ', 3_600, 3_500),
    ];
    const fit = fitPerIntent(cases, { targetPrecision: TARGET, labelledCases: 16_200 });
    expect(Object.keys(fit.per_intent).sort()).toEqual(['billing-dispute', 'refund-request']);
  });
});
