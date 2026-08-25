// Tests for the gold report job (method 2, section 4.10, DEC-31).
//
// Four concerns:
// 1. interval math: the Wilson implementation the report quotes (the
//    calibration job's, verbatim) reproduces known reference values and the
//    widths section 4.10 prices;
// 2. metric aggregation on synthetic scored tickets;
// 3. report-half-only discipline: the job refuses anything but the report
//    half at the declared 385-ticket size and never sees fit-half content;
// 4. artifact round-trip and tamper rejection.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { wilsonInterval } from '../calibration/calibrate.js';
import {
  aggregateReport,
  scoreTicket,
} from './score.js';
import type { ScoredTicket } from './score.js';
import {
  loadGoldReportArtifact,
  nextVersion,
  validateGoldReportArtifact,
  writeGoldReportArtifact,
} from './artifact.js';
import type { GoldReportArtifact } from './artifact.js';
import { runGoldReportJob } from './run.js';
import { FakeProvider } from '../models/fake.js';
import { loadGoldHalf } from '../fixtures/load.js';
import type { GoldFile, GoldTicket } from '../fixtures/load.js';

function tempDirUrl(): URL {
  return pathToFileURL(mkdtempSync(join(tmpdir(), 'auracle-goldrep-')));
}

describe('Wilson interval math (shared with the calibration job)', () => {
  it('reproduces reference values', () => {
    // Reference values computed independently from the textbook Wilson form
    // (2np + z^2 +- z*sqrt(z^2 + 4np(1-p))) / (2(n + z^2)) with z = 1.95996.
    expect(wilsonInterval(9, 10)).toEqual({
      confidence: 0.95,
      lower: expect.closeTo(0.59585, 5),
      upper: expect.closeTo(0.982124, 5),
    });
    // Perfect proportion: lower bound is 1/(1 + z^2/n), upper stays at 1.
    expect(wilsonInterval(10, 10)).toEqual({
      confidence: 0.95,
      lower: expect.closeTo(0.722467, 5),
      upper: 1,
    });
    // Empty proportion mirrors it.
    expect(wilsonInterval(0, 10)).toEqual({
      confidence: 0.95,
      lower: 0,
      upper: expect.closeTo(0.277533, 5),
    });
  });

  it('prices a 385-case interval near 3 points at p = 0.9 (section 4.10)', () => {
    const interval = wilsonInterval(350, 385); // p = 0.909
    const halfWidth = (interval.upper - interval.lower) / 2;
    expect(halfWidth).toBeGreaterThan(0.028);
    expect(halfWidth).toBeLessThan(0.031);
  });

  it('gives strata-sized samples wider intervals than the full half', () => {
    // Section 4.10: ~128 cases per tier widen the interval to about five
    // points; the full half of 385 holds about three.
    const stratum = wilsonInterval(118, 128); // p = 0.922
    const full = wilsonInterval(355, 385); // p = 0.922
    expect(stratum.upper - stratum.lower).toBeGreaterThan(full.upper - full.lower);
    const stratumHalf = (stratum.upper - stratum.lower) / 2;
    expect(stratumHalf).toBeGreaterThan(0.04);
    expect(stratumHalf).toBeLessThan(0.06);
  });

  it('rejects an empty sample', () => {
    expect(() => wilsonInterval(0, 0)).toThrow(/at least one observation/);
  });
});

describe('metric aggregation (section 4.10, DEC-32)', () => {
  const scored: ScoredTicket[] = [
    { ticketId: 'SYN-1', riskTier: 'low', decision: 'auto', observedEscalated: false },
    { ticketId: 'SYN-2', riskTier: 'low', decision: 'auto', observedEscalated: false },
    { ticketId: 'SYN-3', riskTier: 'medium', decision: 'auto', observedEscalated: true },
    { ticketId: 'SYN-4', riskTier: 'high', decision: 'gated', observedEscalated: true },
  ];

  it('scores one ticket against its observable disposition only', () => {
    expect(scoreTicket(scored[0]!)).toEqual({ actionMatch: true, contained: true });
    // Auto over a ticket whose history shows a person: containment without match.
    expect(scoreTicket(scored[2]!)).toEqual({ actionMatch: false, contained: true });
    expect(scoreTicket(scored[3]!)).toEqual({ actionMatch: true, contained: false });
  });

  it('aggregates rates, intervals and indication-only strata', () => {
    const metrics = aggregateReport(scored);

    expect(metrics.actionMatch.successes).toBe(3);
    expect(metrics.actionMatch.total).toBe(4);
    expect(metrics.actionMatch.rate).toBeCloseTo(0.75);
    expect(metrics.actionMatch.interval.lower).toBeLessThanOrEqual(metrics.actionMatch.rate);
    expect(metrics.actionMatch.interval.upper).toBeGreaterThanOrEqual(metrics.actionMatch.rate);
    expect(metrics.containment.successes).toBe(3);
    expect(metrics.containment.total).toBe(4);

    expect(metrics.strata.map((s) => s.riskTier)).toEqual(['low', 'medium', 'high']);
    expect(metrics.strata.map((s) => s.tickets)).toEqual([2, 1, 1]);
    for (const stratum of metrics.strata) {
      // Section 4.10: strata stay too small to publish. Always.
      expect(stratum.publishable).toBe(false);
      expect(stratum.actionMatch.interval.lower).toBeLessThanOrEqual(stratum.actionMatch.rate);
      expect(stratum.actionMatch.interval.upper).toBeGreaterThanOrEqual(stratum.actionMatch.rate);
    }
  });

  it('throws on an empty report', () => {
    expect(() => aggregateReport([])).toThrow(/at least one scored ticket/);
  });
});

// --- scripted end-to-end -----------------------------------------------------

const TEST_TAXONOMY = {
  intents: [
    { id: 'a', label: 'Intent A', risk_tier: 'low' },
    { id: 'b', label: 'Intent B', risk_tier: 'medium' },
    { id: 'c', label: 'Intent C', risk_tier: 'high' },
  ],
} as const;

/**
 * A synthetic report half with fully predictable outcomes.
 *
 * Ticket i (0..384): predicted intent cycles low/medium/high, so every
 * sample answers its label unanimously (agreement 1). Policy then sends
 * i % 3 !== 2 down the automatic path and gates the high tier. The observed
 * disposition disagrees exactly when i % 17 === 0, giving 362 matches out
 * of 385 and 257 contained.
 */
function makeScriptedReportHalf(): { half: GoldFile; steps: { text: string }[] } {
  const labels = ['a', 'b', 'c'];
  const tickets: GoldTicket[] = [];
  const steps: { text: string }[] = [];
  for (let i = 0; i < 385; i++) {
    const label = labels[i % 3]!;
    tickets.push({
      ticket_id: `SYN-R${String(i).padStart(3, '0')}`,
      source: 'synthetic',
      intent: label,
      queue: 'billing',
      disposition: {
        escalated: (i % 3 === 2) !== (i % 17 === 0),
        macro_applied: null,
        refund_issued: false,
        first_reply_minutes: 30,
      },
      subject: `REPORT-ONLY subject ${i}`,
      body: `REPORT-ONLY body ${i}`,
    });
    for (let k = 0; k < 9; k++) steps.push({ text: label });
  }
  return {
    half: { split: 'report', source: 'synthetic', count: 385, tickets },
    steps,
  };
}

describe('runGoldReportJob (section 4.10, DEC-31)', () => {
  it('scores only report-half tickets and publishes the expected numbers', async () => {
    const dir = tempDirUrl();
    try {
      const { half, steps } = makeScriptedReportHalf();
      const fitTicketText = 'FIT-ONLY subject marker';
      const provider = new FakeProvider([...steps]);

      const { artifact } = await runGoldReportJob({
        provider,
        taxonomy: TEST_TAXONOMY,
        reportHalf: half,
        artifactDir: dir,
        promptVer: 'classify-p1',
        modelVer: 'test-stub',
      });

      // Nine samples per report ticket, nothing else.
      expect(provider.calls.filter((c) => c.kind === 'chat')).toHaveLength(385 * 9);
      // DEC-31: no fit-half content ever reached the provider.
      const serialized = JSON.stringify(provider.calls);
      expect(serialized).not.toContain(fitTicketText);

      expect(artifact.artifact).toBe('gold-report');
      expect(artifact.method).toBe('human-review');
      expect(artifact.split_used).toBe('report');
      expect(artifact.gold_source).toBe('synthetic');
      expect(artifact.report_tickets).toBe(385);
      expect(artifact.gate_agreement).toBe(0.6);

      // 23 of the 385 tickets sit on a multiple of 17 and mismatch.
      expect(artifact.action_match.successes).toBe(362);
      expect(artifact.action_match.total).toBe(385);
      expect(artifact.action_match.interval.lower).toBeLessThanOrEqual(
        artifact.action_match.rate,
      );
      expect(artifact.action_match.interval.upper).toBeGreaterThanOrEqual(
        artifact.action_match.rate,
      );
      // High-tier tickets are gated to a person: i % 3 === 2 gives 128.
      expect(artifact.containment.successes).toBe(257);
      expect(artifact.containment.total).toBe(385);

      expect(artifact.strata.map((s) => s.risk_tier)).toEqual(['low', 'medium', 'high']);
      expect(artifact.strata.map((s) => s.tickets)).toEqual([129, 128, 128]);
      for (const stratum of artifact.strata) {
        expect(stratum.publishable).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('refuses to run against the fit half (DEC-31)', async () => {
    await expect(
      runGoldReportJob({
        provider: new FakeProvider([]),
        taxonomy: TEST_TAXONOMY,
        reportHalf: loadGoldHalf('fit'),
        artifactDir: tempDirUrl(),
        modelVer: 'test-stub',
      }),
    ).rejects.toThrow(/report half only/);
  });

  it('requires exactly the committed 385 report tickets (DEC-31)', async () => {
    const short = makeScriptedReportHalf();
    short.half.tickets.length = 384;
    short.half.count = 384;
    await expect(
      runGoldReportJob({
        provider: new FakeProvider([]),
        taxonomy: TEST_TAXONOMY,
        reportHalf: short.half,
        artifactDir: tempDirUrl(),
        modelVer: 'test-stub',
      }),
    ).rejects.toThrow(/expected 385/);
  });

  it('rejects non-synthetic halves (DEC-18)', async () => {
    const { half } = makeScriptedReportHalf();
    half.source = 'production';
    await expect(
      runGoldReportJob({
        provider: new FakeProvider([]),
        taxonomy: TEST_TAXONOMY,
        reportHalf: half,
        artifactDir: tempDirUrl(),
        modelVer: 'test-stub',
      }),
    ).rejects.toThrow(/synthetic/);
  });

  it('needs a pinned model version (DEC-26)', async () => {
    const { half } = makeScriptedReportHalf();
    await expect(
      runGoldReportJob({
        provider: new FakeProvider([]),
        taxonomy: TEST_TAXONOMY,
        reportHalf: half,
        artifactDir: tempDirUrl(),
      }),
    ).rejects.toThrow(/modelVer/);
  });
});

describe('gold report artifact round-trip', () => {
  function makeArtifact(version: number): GoldReportArtifact {
    return {
      artifact: 'gold-report',
      version,
      generated_at: '2026-01-01T00:00:00.000Z',
      method: 'human-review',
      gold_source: 'synthetic',
      split_used: 'report',
      report_tickets: 385,
      prompt_ver: 'classify-p1',
      model_ver: 'test-stub',
      gate_agreement: 0.6,
      action_match: {
        rate: 362 / 385,
        successes: 362,
        total: 385,
        interval: wilsonInterval(362, 385),
      },
      containment: {
        rate: 257 / 385,
        successes: 257,
        total: 385,
        interval: wilsonInterval(257, 385),
      },
      strata: [
        {
          risk_tier: 'low',
          tickets: 129,
          action_match: {
            rate: 125 / 129,
            successes: 125,
            total: 129,
            interval: wilsonInterval(125, 129),
          },
          containment: {
            rate: 129 / 129,
            successes: 129,
            total: 129,
            interval: wilsonInterval(129, 129),
          },
          publishable: false,
        },
      ],
    };
  }

  it('writes versioned files and loads the highest back', async () => {
    const dir = tempDirUrl();
    try {
      await writeGoldReportArtifact(makeArtifact(await nextVersion(dir)), dir);
      await writeGoldReportArtifact(makeArtifact(await nextVersion(dir)), dir);

      const loaded = await loadGoldReportArtifact(undefined, dir);
      expect(loaded?.version).toBe(2);
      expect(loaded?.action_match.successes).toBe(362);
      const v1 = await loadGoldReportArtifact(1, dir);
      expect(v1?.version).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when nothing has been reported yet', async () => {
    const loaded = await loadGoldReportArtifact(undefined, tempDirUrl());
    expect(loaded).toBeNull();
  });

  it('fails validation on tampered fields', () => {
    expect(() =>
      validateGoldReportArtifact({ ...makeArtifact(1), split_used: 'fit' }),
    ).toThrow(/split_used/);
    expect(() =>
      validateGoldReportArtifact({ ...makeArtifact(1), method: 'action-match' }),
    ).toThrow(/method/);
    expect(() =>
      validateGoldReportArtifact({
        ...makeArtifact(1),
        action_match: {
          ...makeArtifact(1).action_match,
          interval: { confidence: 0.95, lower: 0.99, upper: 1 },
        },
      }),
    ).toThrow(/bracket/);
  });

  it('refuses a stratum that claims to be publishable (section 4.10)', () => {
    const artifact = makeArtifact(1);
    expect(() =>
      validateGoldReportArtifact({
        ...artifact,
        strata: [{ ...artifact.strata[0]!, publishable: true }],
      }),
    ).toThrow(/publishable/);
  });
});
