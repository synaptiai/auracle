// Tests for the gold report job (method 2, section 4.10, DEC-31).
//
// Four concerns:
// 1. interval math: the Wilson implementation the report quotes (the
//    calibration job's, verbatim) reproduces known reference values and the
//    widths section 4.10 prices;
// 2. metric aggregation on synthetic scored tickets;
// 3. report-half-only discipline: the job refuses anything but the report
//    half at the declared committed size and never sees fit-half content;
// 4. artifact round-trip and tamper rejection.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { wilsonInterval } from '../calibration/calibrate.js';
import { REPORT_COUNT } from '../fixtures/load.js';
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
import { SEED_THRESHOLDS, makeThresholds } from '../policy/policy.js';
import { FakeProvider } from '../models/fake.js';
import { isFirstTurn, loadGoldHalf } from '../fixtures/load.js';
import { halfDigest, identityOf } from '../fixtures/load.js';
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

  it('prices a full-half interval near one point at p = 0.9 (section 4.10)', () => {
    // Restated at the committed half size, and stated as a rate so it
    // survives the next growth. The corpus grew because a precision floor
    // read against an interval needs support, and the same growth narrows
    // every published interval: three points at 385 cases, two at 1062, and
    // about 0.9 at 4100. That narrowing is the point of the growth, so the
    // band is asserted rather than the old figure kept.
    const successes = Math.round(0.9096 * REPORT_COUNT);
    const interval = wilsonInterval(successes, REPORT_COUNT); // p = 0.9096
    const halfWidth = (interval.upper - interval.lower) / 2;
    expect(halfWidth).toBeGreaterThan(0.008);
    expect(halfWidth).toBeLessThan(0.010);
  });

  it('gives strata-sized samples wider intervals than the full half', () => {
    // Section 4.10: a tier of about 128 cases widens the interval to some
    // five points, where the full half holds about two.
    const stratum = wilsonInterval(118, 128); // p = 0.922
    const full = wilsonInterval(979, REPORT_COUNT); // p = 0.9218
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
 * Ticket i: predicted intent cycles low/medium/high, so every sample answers
 * its label unanimously (agreement 1). Policy then sends i % 3 !== 2 down the
 * automatic path and gates the high tier. The observed disposition disagrees
 * exactly when i % 17 === 0. The counts follow from REPORT_COUNT, so they are
 * computed rather than pinned and the half tracks the committed size.
 */
function makeScriptedReportHalf(): { half: GoldFile; steps: { text: string }[] } {
  const labels = ['a', 'b', 'c'];
  const tickets: GoldTicket[] = [];
  const steps: { text: string }[] = [];
  for (let i = 0; i < REPORT_COUNT; i++) {
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
    half: { split: 'report', source: 'synthetic', count: REPORT_COUNT, tickets },
    steps,
  };
}


/**
 * A report half whose agreement values straddle a threshold.
 *
 * makeScriptedReportHalf gives every ticket nine identical samples, so
 * agreement is 1.0 everywhere and no threshold below 1.0 changes a decision.
 * That is why a broken threshold wiring is invisible to it. Here every third
 * ticket takes 7 of 9 samples, so it clears a 0.6 gate and fails a 0.8 one.
 */
function makeMixedAgreementReportHalf(): { half: GoldFile; steps: { text: string }[] } {
  const labels = ['a', 'b', 'c'];
  const tickets: GoldTicket[] = [];
  const steps: { text: string }[] = [];
  for (let i = 0; i < REPORT_COUNT; i++) {
    const label = labels[i % 3]!;
    const other = labels[(i + 1) % 3]!;
    tickets.push({
      ticket_id: `SYN-M${String(i).padStart(3, '0')}`,
      source: 'synthetic',
      intent: label,
      queue: 'billing',
      disposition: {
        escalated: false,
        macro_applied: null,
        refund_issued: false,
        first_reply_minutes: 30,
      },
      subject: `REPORT-ONLY subject ${i}`,
      body: `REPORT-ONLY body ${i}`,
    });
    // Every third ticket: 7 of 9 agree, so agreement is 0.777...
    const split = i % 3 === 0;
    for (let k = 0; k < 9; k++) {
      steps.push({ text: split && k >= 7 ? other : label });
    }
  }
  return {
    half: { split: 'report', source: 'synthetic', count: REPORT_COUNT, tickets },
    steps,
  };
}

describe('runGoldReportJob (section 4.10, DEC-31)', () => {
  // Scripts a whole report half, so it grew with the corpus: 1062 tickets at
  // nine samples each, where the earlier half gave 385. Past the default five
  // seconds on an ordinary machine, and its neighbours already say 30_000 for
  // the same reason.
  it('records the samples it could not read, so a published number says so', async () => {
    const dir = tempDirUrl();
    try {
      const { half, steps } = makeScriptedReportHalf();
      // One truncated sample on the first case; every other answers as scripted.
      const script = [{ finishReason: 'length' }, ...steps.slice(1)];
      const { artifact } = await runGoldReportJob({
        provider: new FakeProvider(script),
        taxonomy: TEST_TAXONOMY,
        reportHalf: half,
        artifactDir: dir,
        promptVer: 'classify-p1',
        modelVer: 'test-stub',
      });
      // The value, not the field. Deleting the accumulation left the suite green.
      expect(artifact.unreadable_samples).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

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
      expect(provider.calls.filter((c) => c.kind === 'chat')).toHaveLength(REPORT_COUNT * 9);
      // DEC-31: no fit-half content ever reached the provider.
      const serialized = JSON.stringify(provider.calls);
      expect(serialized).not.toContain(fitTicketText);

      expect(artifact.artifact).toBe('gold-report');
      expect(artifact.method).toBe('human-review');
      // `method` names section 4.10's slot; `scored_by` names the scorer.
      //
      // 'stub', because a `FakeProvider` answered. This case asserted 'model'
      // and said a real provider had answered, which was the exact false
      // claim the field exists to prevent: the fake declared no kind, and an
      // absent kind reads as 'model'. The pin is not the answerer — the two
      // are independent options, which is why `scorerOf` reads the provider.
      //
      // No published number moves. `gold-report/v7.json` already reads
      // `scored_by: 'stub'`; only this suite was wrong about itself.
      expect(artifact.scored_by).toBe('stub');
      expect(artifact.split_used).toBe('report');
      expect(artifact.gold_source).toBe('synthetic');
      expect(artifact.report_tickets).toBe(REPORT_COUNT);
      expect(artifact.gate_agreement).toBe(0.6);

      // The mismatches are the cases whose index is a multiple of 17, so the
      // count follows from REPORT_COUNT rather than from a figure that has to
      // be re-derived by hand every time the corpus grows. It was written as
      // a literal, and the growth to 8200 is what found that.
      const mismatches = Math.ceil(REPORT_COUNT / 17);
      expect(artifact.action_match.successes).toBe(REPORT_COUNT - mismatches);
      expect(artifact.action_match.total).toBe(REPORT_COUNT);
      expect(artifact.action_match.interval.lower).toBeLessThanOrEqual(
        artifact.action_match.rate,
      );
      expect(artifact.action_match.interval.upper).toBeGreaterThanOrEqual(
        artifact.action_match.rate,
      );
      // High-tier cases are gated to a person, and they are exactly the
      // indices where i % 3 === 2. Derived, for the same reason the mismatch
      // count above is.
      const gated = Math.floor(REPORT_COUNT / 3);
      expect(artifact.containment.successes).toBe(REPORT_COUNT - gated);
      expect(artifact.containment.total).toBe(REPORT_COUNT);

      expect(artifact.strata.map((s) => s.risk_tier)).toEqual(['low', 'medium', 'high']);
      // One stratum per residue of i % 3, so the three counts differ by at
      // most one and sum to the half.
      const strata = artifact.strata.map((s) => s.tickets);
      expect(strata.reduce((a, b) => a + b, 0)).toBe(REPORT_COUNT);
      expect(Math.max(...strata) - Math.min(...strata)).toBeLessThanOrEqual(1);
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

  it('requires exactly the committed report-half size (DEC-31)', async () => {
    const short = makeScriptedReportHalf();
    short.half.tickets.length = REPORT_COUNT - 1;
    short.half.count = REPORT_COUNT - 1;
    await expect(
      runGoldReportJob({
        provider: new FakeProvider([]),
        taxonomy: TEST_TAXONOMY,
        reportHalf: short.half,
        artifactDir: tempDirUrl(),
        modelVer: 'test-stub',
      }),
    ).rejects.toThrow(new RegExp(`expected ${REPORT_COUNT}`));
  });

  // DEC-39: the gold report scores first turns only. Every runner case
  // injects an all-first-turn half, so the filter itself was never
  // exercised — and removing it moves a PUBLISHED number with the whole
  // suite green (report_tickets 287 -> 385, action match 0.7909 -> 0.7948).
  // A branch that states a number takes on the number.
  it('scores first turns only, and counts only what it scored (DEC-39)', async () => {
    const { half, steps } = makeScriptedReportHalf();
    // The second case becomes turn 2 of the first case's conversation, so
    // the half still holds every case but one fewer first turn. Removing the
    // filter moves a PUBLISHED number with the whole suite green:
    // report_tickets 287 -> 385, action match 0.7909 -> 0.7948. A branch
    // that states a number takes on the number.
    const conversation = 'CONV-SYN-R000';
    const tickets = half.tickets.map((ticket, i) => {
      if (i === 0) return { ...ticket, conversation_id: conversation, turn_number: 1 };
      if (i === 1) return { ...ticket, conversation_id: conversation, turn_number: 2 };
      return ticket;
    });
    const dir = tempDirUrl();
    try {
      const { artifact } = await runGoldReportJob({
        provider: new FakeProvider(steps),
        taxonomy: TEST_TAXONOMY,
        reportHalf: { ...half, tickets },
        artifactDir: dir,
        modelVer: 'test-stub',
      });
      expect(artifact.report_tickets).toBe(REPORT_COUNT - 1);
      expect(artifact.scope).toBe('first_turn');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes from a labelled half of real history, naming the provenance', async () => {
    const { half, steps } = makeScriptedReportHalf();
    const real: GoldFile = {
      ...half,
      source: 'real',
      tickets: half.tickets.map((ticket) => ({ ...ticket, source: 'real' })),
    };
    const dir = tempDirUrl();
    try {
      const { artifact } = await runGoldReportJob({
        provider: new FakeProvider(steps),
        taxonomy: TEST_TAXONOMY,
        reportHalf: real,
        fitIdentity: identityOf({
          split: 'fit', source: 'real', count: real.tickets.length,
          tickets: real.tickets.map((t, i) => ({
            ...t, ticket_id: `fit-${i}@example.test`, conversation_id: `fit-${i}@example.test`,
          })),
        }),
        artifactDir: dir,
        modelVer: 'test-stub',
      });
      expect(artifact.gold_source).toBe('real');
      expect(artifact.report_tickets).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a half whose declared count disagrees with its tickets', async () => {
    const { half } = makeScriptedReportHalf();
    await expect(
      runGoldReportJob({
        provider: new FakeProvider([]),
        taxonomy: TEST_TAXONOMY,
        reportHalf: { ...half, count: 9 },
        artifactDir: tempDirUrl(),
        modelVer: 'test-stub',
      }),
    ).rejects.toThrow(new RegExp(`declares 9 tickets but carries ${REPORT_COUNT}`));
  });

  it('refuses a real report half with no fit half to prove the split against (DEC-31)', async () => {
    const { half } = makeScriptedReportHalf();
    await expect(
      runGoldReportJob({
        provider: new FakeProvider([]),
        taxonomy: TEST_TAXONOMY,
        reportHalf: { ...half, source: 'real', tickets: half.tickets.map((t) => ({ ...t, source: 'real' })) },
        artifactDir: tempDirUrl(),
        modelVer: 'test-stub',
      }),
    ).rejects.toThrow(/fit half/);
  });

  // The proof was per-invocation and bound to nothing. An operator could
  // calibrate against report half B, then publish against a pruned fit half
  // that no longer overlaps B, and every check would pass while the gate in
  // force came from a fit that did overlap. The digests let a reader see that
  // the two runs were proved against different sets.
  // The writer had no case either: replacing it with the constant null
  // passed once the validator assert above was disabled.
  it('records the provenance of the gate it published against', async () => {
    const { half, steps } = makeScriptedReportHalf();
    const dir = tempDirUrl();
    try {
      const { artifact } = await runGoldReportJob({
        provider: new FakeProvider(steps),
        taxonomy: TEST_TAXONOMY,
        reportHalf: half,
        thresholds: makeThresholds({ agreement: 0.75, groundednessBlock: 0.7, groundednessReview: 0.8 }),
        provenance: { source: 'calibration', version: 4, scope: 'all_turns', goldSource: 'real' },
        artifactDir: dir,
        modelVer: 'test-stub',
      });
      // The gate came from a fit on real history while this report scored a
      // synthetic half. A reader must see both, not assume they match.
      expect(artifact.gate_calibration_gold_source).toBe('real');
      expect(artifact.gold_source).toBe('synthetic');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('records the exact pair it proved disjoint', async () => {
    const { half, steps } = makeScriptedReportHalf();
    const real: GoldFile = {
      ...half, source: 'real', tickets: half.tickets.map((t) => ({ ...t, source: 'real' })),
    };
    const fitIdentity = identityOf({
      split: 'fit', source: 'real', count: real.tickets.length,
      tickets: real.tickets.map((t, i) => ({
        ...t, ticket_id: `fit-${i}@example.test`, conversation_id: `fit-${i}@example.test`,
      })),
    });
    const dir = tempDirUrl();
    try {
      const { artifact } = await runGoldReportJob({
        provider: new FakeProvider(steps),
        taxonomy: TEST_TAXONOMY,
        reportHalf: real,
        fitIdentity,
        artifactDir: dir,
        modelVer: 'test-stub',
      });
      expect(artifact.fit_half_digest).toBe(halfDigest(fitIdentity));
      expect(artifact.report_half_digest).toBe(halfDigest(identityOf(real)));
      // Two different halves must not share a digest, or the record proves
      // nothing about which sets a run consumed.
      expect(artifact.fit_half_digest).not.toBe(artifact.report_half_digest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records no pair when it read the committed corpus, which the loader cross-checks', async () => {
    const { half, steps } = makeScriptedReportHalf();
    const dir = tempDirUrl();
    try {
      const { artifact } = await runGoldReportJob({
        provider: new FakeProvider(steps),
        taxonomy: TEST_TAXONOMY,
        reportHalf: half,
        artifactDir: dir,
        modelVer: 'test-stub',
      });
      expect(artifact.fit_half_digest).toBeNull();
      expect(artifact.report_half_digest).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // F3: this suite stayed green when the bypass was reinstated, because its
  // overlap cases all used a 'real' half — the branch the bypass never took.
  it('checks a supplied fit identity even when the half declares synthetic (DEC-31)', async () => {
    const { half } = makeScriptedReportHalf();
    await expect(
      runGoldReportJob({
        provider: new FakeProvider([]),
        taxonomy: TEST_TAXONOMY,
        reportHalf: half,
        fitIdentity: identityOf({ ...half, split: 'fit' }),
        artifactDir: tempDirUrl(),
        modelVer: 'test-stub',
      }),
    ).rejects.toThrow(/appears in both halves/);
  });

  it('refuses a real report half that overlaps its fit half (DEC-31)', async () => {
    const { half } = makeScriptedReportHalf();
    const real: GoldFile = {
      ...half, source: 'real', tickets: half.tickets.map((t) => ({ ...t, source: 'real' })),
    };
    await expect(
      runGoldReportJob({
        provider: new FakeProvider([]),
        taxonomy: TEST_TAXONOMY,
        reportHalf: real,
        fitIdentity: identityOf({ ...real, split: 'fit' }),
        artifactDir: tempDirUrl(),
        modelVer: 'test-stub',
      }),
    ).rejects.toThrow(/appears in both halves/);
  });

  it('rejects a provenance outside the closed set (DEC-18)', async () => {
    const { half } = makeScriptedReportHalf();
    half.source = 'production' as GoldFile['source'];
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

function makeArtifact(version: number): GoldReportArtifact {
    return {
      artifact: 'gold-report',
      version,
      generated_at: '2026-01-01T00:00:00.000Z',
      method: 'human-review',
      scored_by: 'stub',
      gold_source: 'synthetic',
      split_used: 'report',
      scope: 'first_turn',
      report_tickets: 385,
      prompt_ver: 'classify-p1',
      model_ver: 'test-stub',
      gate_source: 'seed',
      gate_calibration_version: null,
      gate_calibration_scope: null,
      gate_calibration_gold_source: null,
      report_half_digest: null,
      fit_half_digest: null,
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

describe('gold report artifact round-trip', () => {

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

  it('refuses an artifact that claims another population (DEC-39)', () => {
    // Same guard shape as split_used: a number covering a different
    // population is not comparable with the published one.
    expect(() =>
      validateGoldReportArtifact({ ...makeArtifact(1), scope: 'all_turns' }),
    ).toThrow(/scope/);
  });

  it('refuses an artifact that names no scorer (section 4.10)', () => {
    // `method` is a fixed slot name, so it can never say who graded. An
    // artifact without `scored_by` reads as a quality claim to anyone who
    // parses the file and never sees the README.
    const { scored_by: _dropped, ...withoutScorer } = makeArtifact(1);
    expect(() => validateGoldReportArtifact(withoutScorer)).toThrow(/scored_by/);
    expect(() =>
      validateGoldReportArtifact({ ...makeArtifact(1), scored_by: 'human' }),
    ).toThrow(/scored_by/);
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

describe('first-turn scope (DEC-39)', () => {
  function goldTicket(overrides: Partial<GoldTicket> = {}): GoldTicket {
    return {
      ticket_id: 'g-1',
      source: 'synthetic',
      intent: 'refund-request',
      queue: 'billing',
      disposition: {
        escalated: false,
        macro_applied: null,
        refund_issued: true,
        first_reply_minutes: 12,
      },
      subject: 'Refund',
      body: 'Please refund me.',
      ...overrides,
    };
  }

  it('treats a case with no turn as a first turn', () => {
    // Every committed fixture is one: the generator writes one subject and
    // one body per case and records no prior turn.
    expect(isFirstTurn(goldTicket())).toBe(true);
    expect(isFirstTurn(goldTicket({ turn_number: 1 }))).toBe(true);
  });

  it('excludes a later turn from the scored set', () => {
    // A later turn's disposition reflects the whole conversation, not the
    // routing decision being scored (DEC-32).
    expect(isFirstTurn(goldTicket({ turn_number: 2 }))).toBe(false);
  });
});

// A published number is only readable beside the gate it was scored through.
// Before this the artifact recorded the value and not its origin, so a fitted
// run and a seeded run published different numbers under identical metadata.
describe('the artifact names the provenance of its gate (DEC-13, DEC-31)', () => {
  function runWith(
    extra: Partial<Parameters<typeof runGoldReportJob>[0]>,
  ): ReturnType<typeof runGoldReportJob> {
    const { half, steps } = makeScriptedReportHalf();
    return runGoldReportJob({
      provider: new FakeProvider([...steps]),
      taxonomy: TEST_TAXONOMY,
      reportHalf: half,
      artifactDir: tempDirUrl(),
      promptVer: 'classify-p1',
      modelVer: 'test-stub',
      ...extra,
    });
  }

  it('records a seeded run as seeded, naming no version', async () => {
    const { artifact } = await runWith({});

    expect(artifact.gate_source).toBe('seed');
    expect(artifact.gate_calibration_version).toBeNull();
    expect(artifact.gate_agreement).toBe(SEED_THRESHOLDS.agreement);
  }, 30_000);

  it('records the calibration version that produced its gate', async () => {
    const { artifact } = await runWith({
      thresholds: makeThresholds({ ...SEED_THRESHOLDS, agreement: 0.72 }),
      provenance: { source: 'calibration', version: 7, scope: 'all_turns', goldSource: 'synthetic' },
    });

    expect(artifact.gate_source).toBe('calibration');
    expect(artifact.gate_calibration_version).toBe(7);
    // `scope` above names the population this report scored (first turns,
    // DEC-39). This names the population the THRESHOLD was fitted on.
    expect(artifact.gate_calibration_scope).toBe('all_turns');
    expect(artifact.scope).toBe('first_turn');
    // The published gate is the fitted one, not the seed.
    expect(artifact.gate_agreement).toBe(0.72);
  }, 30_000);

  it('refuses an artifact claiming a calibrated gate with no version', () => {
    expect(() =>
      validateGoldReportArtifact({
        ...makeArtifact(1),
        gate_source: 'calibration',
        gate_calibration_version: null,
      }),
    ).toThrow(/gate_calibration_version/);
  });

  it('refuses an artifact claiming a seeded gate that names a version', () => {
    // A version here credits a fit that did not produce this number.
    expect(() =>
      validateGoldReportArtifact({
        ...makeArtifact(1),
        gate_source: 'seed',
        gate_calibration_version: 3,
      }),
    ).toThrow(/gate_calibration_version/);
  });

  // Its two siblings each carry negative cases; this field's guard was
  // cloned from them and its cases were not. Writer and both validator
  // branches could be deleted with the whole suite green.
  it('refuses a provenance outside the closed set (DEC-18)', () => {
    expect(() => validateGoldReportArtifact({ ...makeArtifact(1), gold_source: 'production' }))
      .toThrow(/gold_source is production, expected one of synthetic, real/);
  });

  it('refuses a digest that is neither null nor a digest', () => {
    for (const field of ['fit_half_digest', 'report_half_digest'] as const) {
      expect(() => validateGoldReportArtifact({ ...makeArtifact(1), [field]: 'not-a-digest' }))
        .toThrow(new RegExp(field));
    }
  });

  it('refuses a calibrated gate whose provenance is outside the closed set', () => {
    expect(() =>
      validateGoldReportArtifact({
        ...makeArtifact(1),
        gate_source: 'calibration',
        gate_calibration_version: 3,
        gate_calibration_scope: 'all_turns',
        gate_calibration_gold_source: 'production',
      }),
    ).toThrow(/gate_calibration_gold_source/);
  });

  it('refuses a calibrated gate that names no provenance', () => {
    expect(() =>
      validateGoldReportArtifact({
        ...makeArtifact(1),
        gate_source: 'calibration',
        gate_calibration_version: 3,
        gate_calibration_scope: 'all_turns',
        gate_calibration_gold_source: null,
      }),
    ).toThrow(/gate_calibration_gold_source/);
  });

  it('refuses a seeded gate that names a provenance', () => {
    // A provenance here credits a fit that did not produce this number,
    // exactly as a version would.
    expect(() =>
      validateGoldReportArtifact({
        ...makeArtifact(1),
        gate_source: 'seed',
        gate_calibration_gold_source: 'real',
      }),
    ).toThrow(/gate_calibration_gold_source/);
  });

  it('refuses an unknown gate_source', () => {
    expect(() =>
      validateGoldReportArtifact({ ...makeArtifact(1), gate_source: 'guess' }),
    ).toThrow(/gate_source/);
  });
});

// The repository ships one published artifact and README quotes its numbers.
// Adding a required field to the validator silently invalidated it: nothing
// loads it in production, so no test noticed until a reader tried.
describe('the DEC-31 proof a real run must carry', () => {
  // Null digests mean the committed corpus. A real run has no such
  // guarantee, so an artifact declaring real provenance with no proved pair
  // would publish numbers whose split nobody checked.
  it('refuses a real artifact that names no proved pair', () => {
    expect(() => validateGoldReportArtifact({ ...makeArtifact(1), gold_source: 'real' }))
      .toThrow(/must name the pair it proved disjoint/);
  });

  it('accepts a real artifact that names one', () => {
    expect(() => validateGoldReportArtifact({
      ...makeArtifact(1),
      gold_source: 'real',
      fit_half_digest: 'a1b2c3d4e5f60718',
      report_half_digest: 'f0e1d2c3b4a59687',
    })).not.toThrow();
  });
});

describe('the committed gold report artifact', () => {
  it('validates against the validator this repository ships', () => {
    const url = new URL('../../gold-report/v7.json', import.meta.url);
    const artifact = validateGoldReportArtifact(
      JSON.parse(readFileSync(url, 'utf8')),
    );

    expect(artifact.split_used).toBe('report');
    expect(artifact.scope).toBe('first_turn');
    // README quotes these two. A change here republishes a number.
    expect(artifact.action_match.rate).toBeCloseTo(0.793, 3);
    expect(artifact.containment.rate).toBeCloseTo(0.805, 3);
    // And it names the pair it was scored through, on both gates (DEC-05).
    // The rates above are identical to the version before these fields
    // existed, because a routing decision makes no textual claim and its
    // groundedness is pinned at 1.0 — but the artifact could no longer say so.
    expect(artifact.gate_source).toBe('seed');
    expect(artifact.coverage_source).toBe('groundedness');
    expect(artifact.coverage_block).toBe(0.75);
    expect(artifact.coverage_review).toBe(1);
  });
});

// The published rates must be scored THROUGH the resolved gate, not merely
// reported beside it. The provenance cases above copy the inputs into the
// artifact, so they pass even when the scoring loop ignores `thresholds`
// entirely — the same trap the coordinator suite names and avoids.
describe('the report half is scored through the resolved gate (DEC-31)', () => {
  function runAt(agreement: number): ReturnType<typeof runGoldReportJob> {
    const { half, steps } = makeMixedAgreementReportHalf();
    return runGoldReportJob({
      provider: new FakeProvider([...steps]),
      taxonomy: TEST_TAXONOMY,
      reportHalf: half,
      artifactDir: tempDirUrl(),
      promptVer: 'classify-p1',
      modelVer: 'test-stub',
      thresholds: makeThresholds({ ...SEED_THRESHOLDS, agreement }),
      provenance: { source: 'calibration', version: 2, scope: 'all_turns', goldSource: 'synthetic' },
    });
  }

  it('publishes different rates under a threshold that reclassifies tickets', async () => {
    // Every third ticket agrees 7 of 9. Under 0.6 it clears gate 1; under 0.8
    // it escalates. No ticket in this half was escalated by a person, so a
    // stricter gate lowers both published rates.
    const loose = (await runAt(0.6)).artifact;
    const strict = (await runAt(0.8)).artifact;

    expect(loose.containment.rate).toBeGreaterThan(strict.containment.rate);
    expect(loose.action_match.rate).toBeGreaterThan(strict.action_match.rate);
    // Both artifacts name the gate they were scored through.
    expect(loose.gate_agreement).toBe(0.6);
    expect(strict.gate_agreement).toBe(0.8);
  }, 60_000);
});

// `thresholds` and `provenance` are two independent options, so a caller can
// hand over a fitted number and no provenance. The artifact would then
// publish a fitted gate labelled as the seed, past a validator whose whole
// purpose is to keep the two apart.
describe('a seeded provenance must carry the seed value (DEC-31)', () => {
  function runWithThresholds(
    overrides: Partial<Record<string, number>>,
    provenance?: { source: 'calibration'; version: number; scope: 'all_turns'; goldSource: 'synthetic' | 'real' },
    coverageProvenance?: { source: 'groundedness'; version: number; goldSource: 'synthetic' | 'real' },
  ): ReturnType<typeof runGoldReportJob> {
    const { half, steps } = makeScriptedReportHalf();
    return runGoldReportJob({
      provider: new FakeProvider([...steps]),
      taxonomy: TEST_TAXONOMY,
      reportHalf: half,
      artifactDir: tempDirUrl(),
      modelVer: 'test-stub',
      thresholds: makeThresholds({ ...SEED_THRESHOLDS, ...overrides }),
      ...(provenance === undefined ? {} : { provenance }),
      ...(coverageProvenance === undefined ? {} : { coverageProvenance }),
    });
  }

  it.each([
    ['groundednessBlock', 0.5],
    ['groundednessReview', 0.9],
  ])('refuses a moved %s on a seeded run', async (field, value) => {
    // DEC-05: the artifact records a value for the first gate only, so a
    // moved coverage threshold would otherwise reach the published rates with
    // nothing in the file naming it.
    await expect(runWithThresholds({ [field]: value })).rejects.toThrow(
      new RegExp(`non-seed ${field}`),
    );
  });

  it.each([
    ['groundednessBlock', 0.5],
    ['groundednessReview', 0.9],
  ])('refuses a moved %s on a CALIBRATED run too', async (field, value) => {
    // The guard used to sit inside the seed branch, so naming a run
    // 'calibration' let any coverage pair through — and the artifact records
    // no coverage value at all, so nothing disclosed it.
    await expect(
      runWithThresholds(
        { [field]: value },
        { source: 'calibration', version: 3, scope: 'all_turns', goldSource: 'synthetic' },
      ),
    ).rejects.toThrow(new RegExp(`non-seed ${field}`));
  });

  // The arm the commit that changed this guard was FOR, and the arm that had
  // no case: a moved pair is permitted once a coverage provenance names the
  // fit behind it. Reverting the guard to its old unconditional refusal left
  // the whole suite green, so the change that made `pnpm run gold-report` work
  // again on a machine holding a fit was unproven.
  it.each([
    ['groundednessBlock', 0.75],
    ['groundednessReview', 1],
  ])('accepts a moved %s when a fit is named, and records it', async (field, value) => {
    const { artifact } = await runWithThresholds(
      { [field]: value },
      undefined,
      { source: 'groundedness', version: 4, goldSource: 'synthetic' },
    );
    expect(artifact.coverage_source).toBe('groundedness');
    expect(artifact.coverage_fit_version).toBe(4);
    expect(artifact.coverage_fit_gold_source).toBe('synthetic');
    expect(artifact[field === 'groundednessBlock' ? 'coverage_block' : 'coverage_review'])
      .toBe(value);
    // DEC-05: naming the coverage fit says nothing about the other gate.
    expect(artifact.gate_source).toBe('seed');
    expect(artifact.gate_agreement).toBe(SEED_THRESHOLDS.agreement);
  });

  // And a seeded run still records the pair it ran under, so a reader never
  // has to infer it from the absence of a field.
  it('records the seed pair on a run that moved nothing', async () => {
    const { artifact } = await runWithThresholds({});
    expect(artifact.coverage_source).toBe('seed');
    expect(artifact.coverage_block).toBe(SEED_THRESHOLDS.groundednessBlock);
    expect(artifact.coverage_review).toBe(SEED_THRESHOLDS.groundednessReview);
    expect(artifact.coverage_fit_version).toBeNull();
    expect(artifact.coverage_fit_gold_source).toBeNull();
  });

  // The whole coverage validation block was deletable with the suite green.
  // Every agreement-side mirror of these rules has a refusal case; the
  // coverage side had none, in a validator whose stated purpose is stopping a
  // broken artifact from quietly changing a published number.
  describe('the coverage half of the validator (DEC-05)', () => {
    const fitted = {
      coverage_block: 0.75,
      coverage_review: 1,
      coverage_source: 'groundedness' as const,
      coverage_fit_version: 2,
      coverage_fit_gold_source: 'synthetic' as const,
    };

    it('accepts a well-formed fitted record', () => {
      expect(() => validateGoldReportArtifact({ ...makeArtifact(1), ...fitted })).not.toThrow();
    });

    it('accepts a well-formed seeded record', () => {
      expect(() => validateGoldReportArtifact({
        ...makeArtifact(1),
        coverage_block: 0.7,
        coverage_review: 0.8,
        coverage_source: 'seed',
        coverage_fit_version: null,
        coverage_fit_gold_source: null,
      })).not.toThrow();
    });

    it('refuses a source outside the closed set', () => {
      expect(() => validateGoldReportArtifact({ ...makeArtifact(1), ...fitted, coverage_source: 'guess' }))
        .toThrow(/coverage_source/);
    });

    it.each([
      ['coverage_block', 1.5],
      ['coverage_review', -0.1],
    ])('refuses %s outside [0, 1]', (field, value) => {
      expect(() => validateGoldReportArtifact({ ...makeArtifact(1), ...fitted, [field]: value }))
        .toThrow(new RegExp(`${field} is outside`));
    });

    // An artifact recording block above review describes a gate the policy
    // engine refuses to build, so it must not be readable as one.
    it('refuses a pair whose block exceeds its review', () => {
      expect(() => validateGoldReportArtifact({
        ...makeArtifact(1), ...fitted, coverage_block: 0.9, coverage_review: 0.8,
      })).toThrow(/exceeds/);
    });

    it('refuses a fitted record naming no version', () => {
      expect(() => validateGoldReportArtifact({
        ...makeArtifact(1), ...fitted, coverage_fit_version: null,
      })).toThrow(/coverage_fit_version is not a positive integer/);
    });

    it('refuses a fitted record naming no gold source', () => {
      expect(() => validateGoldReportArtifact({
        ...makeArtifact(1), ...fitted, coverage_fit_gold_source: null,
      })).toThrow(/coverage_fit_gold_source/);
    });

    it.each([
      ['coverage_fit_version', 3],
      ['coverage_fit_gold_source', 'synthetic'],
    ])('refuses a seeded record that sets %s', (field, value) => {
      expect(() => validateGoldReportArtifact({
        ...makeArtifact(1),
        coverage_block: 0.7,
        coverage_review: 0.8,
        coverage_source: 'seed',
        coverage_fit_version: null,
        coverage_fit_gold_source: null,
        [field]: value,
      })).toThrow(new RegExp(`${field} is set on a seeded run`));
    });

    // The hole the else-branch closes: a pair whose provenance nobody can
    // read is the undisclosed gate this record exists to prevent.
    it.each([
      'coverage_block', 'coverage_review', 'coverage_fit_version', 'coverage_fit_gold_source',
    ])('refuses %s set with no coverage_source', (field) => {
      expect(() => validateGoldReportArtifact({ ...makeArtifact(1), [field]: 0.75 }))
        .toThrow(/provenance is unreadable/);
    });

    // And an artifact from before these fields existed still reads.
    it('accepts an artifact carrying none of them', () => {
      expect(() => validateGoldReportArtifact(makeArtifact(1))).not.toThrow();
    });
  });

  it('refuses a scope outside the closed set', () => {
    expect(() =>
      validateGoldReportArtifact({
        ...makeArtifact(1),
        gate_source: 'calibration',
        gate_calibration_version: 2,
        gate_calibration_scope: 'every_other_turn',
      }),
    ).toThrow(/gate_calibration_scope/);
  });

  it('refuses a fitted agreement value with no calibration provenance', async () => {
    const { half, steps } = makeScriptedReportHalf();

    await expect(
      runGoldReportJob({
        provider: new FakeProvider([...steps]),
        taxonomy: TEST_TAXONOMY,
        reportHalf: half,
        artifactDir: tempDirUrl(),
        modelVer: 'test-stub',
        thresholds: makeThresholds({ ...SEED_THRESHOLDS, agreement: 0.72 }),
      }),
    ).rejects.toThrow(/no calibration provenance/);
  });

  it('refuses an artifact naming a scope on a seeded run', () => {
    expect(() =>
      validateGoldReportArtifact({
        ...makeArtifact(1),
        gate_calibration_scope: 'all_turns',
      }),
    ).toThrow(/gate_calibration_scope/);
  });

  it('refuses a calibrated artifact that names no scope', () => {
    expect(() =>
      validateGoldReportArtifact({
        ...makeArtifact(1),
        gate_source: 'calibration',
        gate_calibration_version: 2,
        gate_calibration_scope: null,
      gate_calibration_gold_source: null,
      }),
    ).toThrow(/gate_calibration_scope/);
  });
});

// A caveat the register now states, pinned so it cannot rot into a false
// claim. The wiring is exercised by the mixed-agreement suite above; this
// records that the COMMITTED corpus cannot exercise it, because the offline
// stub answers every sample of one ticket alike.
describe('the offline stub leaves no room for a threshold to bind', () => {
  it('reports agreement 1.0 for every scripted ticket, whatever the gate', async () => {
    const { half, steps } = makeScriptedReportHalf();
    const strict = await runGoldReportJob({
      provider: new FakeProvider([...steps]),
      taxonomy: TEST_TAXONOMY,
      reportHalf: half,
      artifactDir: tempDirUrl(),
      modelVer: 'test-stub',
      thresholds: makeThresholds({ ...SEED_THRESHOLDS, agreement: 0.99 }),
      provenance: { source: 'calibration', version: 1, scope: 'all_turns', goldSource: 'synthetic' },
    });
    const seeded = await runGoldReportJob({
      provider: new FakeProvider([...makeScriptedReportHalf().steps]),
      taxonomy: TEST_TAXONOMY,
      reportHalf: makeScriptedReportHalf().half,
      artifactDir: tempDirUrl(),
      modelVer: 'test-stub',
    });

    // Nine identical samples give agreement 1.0, which clears 0.99 and 0.6
    // alike. Only the recorded provenance separates the two artifacts.
    expect(strict.artifact.action_match).toEqual(seeded.artifact.action_match);
    expect(strict.artifact.containment).toEqual(seeded.artifact.containment);
    expect(strict.artifact.gate_agreement).toBe(0.99);
    expect(seeded.artifact.gate_agreement).toBe(SEED_THRESHOLDS.agreement);
  }, 60_000);
});

// The strictness this module gained when three loaders were put on one scan.
// Mutation testing found it unprotected here: reverting the loader to its old
// lenient scan left every case in this file green, so the reproduction that
// justified the change killed no test in the module it was measured in.
describe('the gold report directory obeys the shared scan', () => {
  function dirWith(...names: string[]): URL {
    const dir = tempDirUrl();
    for (const name of names) {
      writeFileSync(new URL(name, `${dir.href}/`), JSON.stringify(makeArtifact(5)));
    }
    return dir;
  }

  it('mints over a capitalised name instead of writing on top of it', async () => {
    // The old scan skipped 'V5.json' and answered 1, so the job wrote v1 over
    // a directory already holding version 5 and then published the new file
    // while the old one sat unread. README quotes these numbers.
    expect(await nextVersion(dirWith('V5.json'))).toBe(6);
  });

  it('refuses a leading zero rather than reading a different file', async () => {
    await expect(nextVersion(dirWith('v05.json'))).rejects.toThrow(
      /gold report directory holds 'v05\.json'/,
    );
  });

  it('refuses a version too large to read back', async () => {
    await expect(nextVersion(dirWith('v9007199254740993.json'))).rejects.toThrow(
      /too large to read/,
    );
  });

  it('refuses an explicit version that is not a positive integer', async () => {
    await expect(loadGoldReportArtifact(Number.NaN, dirWith('v5.json'))).rejects.toThrow(
      /must be a positive integer/,
    );
  });

  it('checks the directory before the scoring loop spends a model call', async () => {
    // 385 report tickets at CLASSIFIER_K samples each. A stray file used to
    // throw all of that away after the spend.
    const { half } = makeScriptedReportHalf();
    const provider = new FakeProvider([]);

    await expect(
      runGoldReportJob({
        provider,
        taxonomy: TEST_TAXONOMY,
        reportHalf: half,
        artifactDir: dirWith('v5.backup.json'),
        modelVer: 'test-stub',
      }),
    ).rejects.toThrow(/not a versioned artifact/);

    expect(provider.calls).toHaveLength(0);
  });
});
