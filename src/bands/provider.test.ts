// A band never compares across a provider change.
//
// The bulk history composes through the offline stand-in, and a demo day
// composes through a real model. A band across that boundary measures the
// provider and not the system. It is the same defect `gate_pass_rate` carried
// before the reason vocabulary landed: a number that moved because the thing
// producing it changed, read as though the system had changed.
//
// So a window whose measured days do not all share one provider emits no
// verdict and names that as the shortfall, exactly as a thin window does.
import { describe, expect, it } from 'vitest';

import { evaluateMetric, type DailySample } from './evaluate.js';
import { METRICS, WINDOW_DAYS } from './metrics.js';

const METRIC = METRICS.find((m) => m.name === 'abstain_rate')!;

function day(index: number, value: number, provider: string | null): DailySample {
  const date = new Date(Date.UTC(2026, 0, 1) + index * 86_400_000);
  return {
    day: date.toISOString().slice(0, 10),
    value,
    count: 10,
    notReached: 0,
    unrecorded: 0,
    pending: 0,
    provider,
  };
}

/** A full window of ordinary days, all from one provider. */
function window(provider: string | null): DailySample[] {
  return Array.from({ length: WINDOW_DAYS }, (_, i) => day(i, 0.20 + (i % 5) * 0.01, provider));
}

describe('a band across a provider change', () => {
  it('emits a verdict when every day shares one provider', () => {
    const result = evaluateMetric(METRIC, day(40, 0.21, 'stub'), window('stub'));
    expect(result.shortfallCode).toBeNull();
    expect(result.band).not.toBeNull();
  });

  it('emits no verdict when the baseline spans two providers', () => {
    const prior = window('stub');
    prior[0] = day(0, 0.20, 'model');
    const result = evaluateMetric(METRIC, day(40, 0.21, 'stub'), prior);
    expect(result.band).toBeNull();
    expect(result.shortfallCode).toBe('provider_change');
  });

  // The day under test is part of the comparison, so a model-produced day
  // judged against a stub baseline is the same defect from the other side.
  it('emits no verdict when today differs from its baseline', () => {
    const result = evaluateMetric(METRIC, day(40, 0.21, 'model'), window('stub'));
    expect(result.band).toBeNull();
    expect(result.shortfallCode).toBe('provider_change');
  });

  it('names both providers in the shortfall, so a reader knows which boundary', () => {
    const prior = window('stub');
    prior[0] = day(0, 0.20, 'model');
    const result = evaluateMetric(METRIC, day(40, 0.21, 'stub'), prior);
    expect(result.shortfall).toContain('provider');
    expect(result.shortfall).toContain('stub');
    expect(result.shortfall).toContain('model');
  });

  // A window of nothing but days that each mixed providers. Every day reads
  // as the mixed sentinel, so nothing is named and the earlier rule — which
  // activated only on a named provider — stayed silent and emitted a verdict.
  // That is a band across the exact boundary the guard exists to refuse.
  it('emits no verdict when every day in the window mixed providers', () => {
    const prior = Array.from({ length: WINDOW_DAYS }, (_, i) =>
      day(i, 0.20 + (i % 5) * 0.01, 'mixed'));
    const result = evaluateMetric(METRIC, day(40, 0.21, 'mixed'), prior);
    expect(result.band).toBeNull();
    expect(result.shortfallCode).toBe('provider_change');
    expect(result.shortfall).toContain('held more than one');
  });

  it('emits no verdict when one day in the window mixed providers', () => {
    const prior = window('stub');
    prior[0] = day(0, 0.20, 'mixed');
    const result = evaluateMetric(METRIC, day(40, 0.21, 'stub'), prior);
    expect(result.band).toBeNull();
    expect(result.shortfallCode).toBe('provider_change');
  });

  // A ledger written before the field existed names no provider at all, which
  // is the state db/005 describes for its own columns. Refusing every verdict
  // on it would take the report away from the adopters with the most history,
  // and such a window is not spanning a change — nothing says it changed.
  it('emits a verdict when no day in the window names a provider', () => {
    const prior = window(null);
    const result = evaluateMetric(METRIC, day(40, 0.21, null), prior);
    expect(result.shortfallCode).toBeNull();
    expect(result.band).not.toBeNull();
  });

  // Once one day names a provider, an unrecorded day beside it could be a
  // second provider. A band must not rest on that guess.
  it('emits no verdict when a named provider sits beside an unrecorded day', () => {
    const prior = window('stub');
    prior[0] = day(0, 0.20, null);
    const result = evaluateMetric(METRIC, day(40, 0.21, 'stub'), prior);
    expect(result.band).toBeNull();
    expect(result.shortfallCode).toBe('provider_change');
    expect(result.shortfall).toContain('unrecorded');
  });

  // A thin window is the more basic shortfall: a window that does not exist
  // cannot span a provider change. Reporting the provider first would send a
  // reader to the wrong remedy.
  it('reports a thin window before a provider change', () => {
    const prior = window('stub').slice(0, 5);
    prior[0] = day(0, 0.20, 'model');
    const result = evaluateMetric(METRIC, day(40, 0.21, 'stub'), prior);
    expect(result.shortfallCode).toBe('thin_window');
  });

  // And a day with no value of its own is more basic still.
  it('reports an unmeasured day before a provider change', () => {
    const prior = window('stub');
    prior[0] = day(0, 0.20, 'model');
    const today: DailySample = { ...day(40, 0, 'stub'), value: null };
    const result = evaluateMetric(METRIC, today, prior);
    expect(result.shortfallCode).toBe('day_unmeasured');
  });

  // A dropped day is dropped before the provider check too. An unmeasured day
  // contributes no value to the baseline, so its provider cannot bias one.
  it('ignores the provider of a day that carries no value', () => {
    const prior = window('stub');
    prior[0] = { ...day(0, 0, 'model'), value: null };
    // 29 measured stub days is a thin window, so extend it by one.
    prior.push(day(31, 0.22, 'stub'));
    const result = evaluateMetric(METRIC, day(40, 0.21, 'stub'), prior);
    expect(result.shortfallCode).toBeNull();
    expect(result.band).not.toBeNull();
  });
});
