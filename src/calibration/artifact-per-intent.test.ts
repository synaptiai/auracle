// The artifact carries the per-intent fit, and refuses a malformed one
// (DEC-41).
//
// DEC-41 requires the artifact to record the count and the accuracy of each
// kind of label, and to state which path ran. A reader who cannot tell a
// global fit from a per-intent one cannot tell what gates their traffic.
//
// Every new field is optional on read and refused when present and
// malformed. That is the rule the existing count fields already follow: this
// file is read at startup by every daemon, so an adopter holding an older
// artifact must still start, while a corrupt field must still stop.
import { describe, expect, it } from 'vitest';

import { validateCalibrationArtifact } from './artifact.js';

function artifact(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifact: 'agreement-threshold',
    version: 1,
    fitted_at: '2026-09-05T00:00:00.000Z',
    gold_source: 'synthetic',
    split_used: 'fit',
    scope: 'all_turns',
    fit_tickets: 4100,
    fit_half_digest: null,
    report_half_digest: null,
    prompt_ver: 'p1',
    model_ver: 'm1',
    target_precision: 0.9,
    threshold: 0.7,
    precision_at_threshold: 0.91,
    coverage_at_threshold: 0.8,
    interval: { confidence: 0.95, lower: 0.9, upper: 0.93 },
    ...extra,
  };
}

describe('the calibration artifact with a per-intent fit', () => {
  it('loads an artifact written before these fields existed', () => {
    const loaded = validateCalibrationArtifact(artifact());
    expect(loaded.per_intent).toBeUndefined();
    expect(loaded.labellers).toBeUndefined();
  });

  it('carries the per-intent map, the trigger and the labelled count', () => {
    const loaded = validateCalibrationArtifact(
      artifact({
        trigger_min_labelled: 8_000,
        labelled_cases: 8_200,
        per_intent: { 'refund-request': 0.72 },
        below_floor: ['chargeback-notice'],
      }),
    );
    expect(loaded.per_intent).toEqual({ 'refund-request': 0.72 });
    expect(loaded.trigger_min_labelled).toBe(8_000);
    expect(loaded.labelled_cases).toBe(8_200);
    expect(loaded.below_floor).toEqual(['chargeback-notice']);
  });

  // A zero threshold passes every ticket. It must not survive a round trip
  // any more than it survives the fit.
  it('refuses a per-intent threshold outside (0, 1]', () => {
    for (const bad of [0, -0.1, 1.01]) {
      expect(() =>
        validateCalibrationArtifact(artifact({ per_intent: { 'refund-request': bad } })),
      ).toThrow(/per_intent/);
    }
  });

  it('refuses a per-intent map that is not a map of numbers', () => {
    expect(() => validateCalibrationArtifact(artifact({ per_intent: [] }))).toThrow(/per_intent/);
    expect(() =>
      validateCalibrationArtifact(artifact({ per_intent: { 'refund-request': 'high' } })),
    ).toThrow(/per_intent/);
  });

  // DEC-41's provenance half. A threshold states what labelled its cases and
  // how accurate that labeller was.
  it('carries the labeller kind, pin and agreement', () => {
    const loaded = validateCalibrationArtifact(
      artifact({
        labellers: [{ kind: 'stub', pin: 'stub-labeller-v1', agreement: 0.9015, cases: 4100 }],
      }),
    );
    expect(loaded.labellers?.[0]?.kind).toBe('stub');
    expect(loaded.labellers?.[0]?.pin).toBe('stub-labeller-v1');
    expect(loaded.labellers?.[0]?.agreement).toBeCloseTo(0.9015, 6);
  });

  // DEC-41 asks for the count and the accuracy of each kind, so a corpus
  // labelled by two producers must be representable. An earlier version
  // carried a single entry and published nothing at all when it saw two,
  // which read exactly like a corpus that predates DEC-41.
  it('carries one entry for each labeller a corpus used', () => {
    const loaded = validateCalibrationArtifact(
      artifact({
        labellers: [
          { kind: 'stub', pin: 'stub-labeller-v1', agreement: 0.9, cases: 3000 },
          { kind: 'model', pin: 'z-ai/glm-5.3-flash', agreement: 0.95, cases: 1100 },
        ],
      }),
    );
    expect(loaded.labellers).toHaveLength(2);
    expect(loaded.labellers?.map((l) => l.kind)).toEqual(['stub', 'model']);
    // The counts are each labeller's own, so they total the population.
    expect(loaded.labellers?.reduce((n, l) => n + l.cases, 0)).toBe(4100);
  });

  it('refuses two entries for one pin, which would split a labeller in two', () => {
    expect(() =>
      validateCalibrationArtifact(
        artifact({
          labellers: [
            { kind: 'stub', pin: 'stub-labeller-v1', agreement: 0.9, cases: 10 },
            { kind: 'stub', pin: 'stub-labeller-v1', agreement: 0.8, cases: 20 },
          ],
        }),
      ),
    ).toThrow(/repeats pin/);
  });

  // A stand-in's agreement read as a model's score is the confusion this
  // field exists to prevent, so the kind is a closed set.
  it('refuses a labeller kind outside the closed set', () => {
    expect(() =>
      validateCalibrationArtifact(
        artifact({ labellers: [{ kind: 'human-review', pin: 'p', agreement: 1, cases: 1 }] }),
      ),
    ).toThrow(/labellers/);
  });

  it('refuses a labeller agreement outside [0, 1]', () => {
    expect(() =>
      validateCalibrationArtifact(
        artifact({ labellers: [{ kind: 'stub', pin: 'p', agreement: 1.5, cases: 1 }] }),
      ),
    ).toThrow(/labellers/);
  });
});
