// Tests for the calibration job (section 4.11, DEC-13, DEC-31).
//
// Three concerns:
// 1. fit-half-only discipline: the job classifies fit tickets and never
//    touches report-half content;
// 2. threshold selection: on synthetic agreement distributions the fitter
//    picks the lowest threshold whose precision reaches the floor;
// 3. artifact round-trip: written versions load back and tampered artifacts
//    fail validation.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { fitAgreementThreshold, wilsonInterval } from './calibrate.js';
import type { AgreementSample } from './calibrate.js';
import {
  loadCalibrationArtifact,
  nextVersion,
  validateCalibrationArtifact,
  writeCalibrationArtifact,
} from './artifact.js';
import type { CalibrationArtifact } from './artifact.js';
import { runCalibrationJob } from './run.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import type { ClassifierTaxonomy } from '../classifier/classifier.js';
import { FIT_COUNT } from '../domain/gold-types.js';
import { halfDigest, identityOf } from '../fixtures/digest.js';
import type { GoldFile, GoldTicket } from '../domain/gold-types.js';

function repeat(count: number, make: (i: number) => AgreementSample): AgreementSample[] {
  return Array.from({ length: count }, (_, i) => make(i));
}

// Some job cases drive twenty real cases, to inspect attrition accounting and
// the real-history path. The shipped floor of 0.985 is read against a 95
// percent interval and needs 253 samples above the threshold, so a floor those
// fixtures can reach stands in: twenty perfect samples reach 0.8389 and
// nineteen reach 0.8318. The floor itself is covered below, at the sizes it
// needs.
const SMALL_FLOOR = { targetPrecision: 0.8 } as const;

/**
 * For the case that proves a real half of any size is accepted.
 *
 * It carries two cases, and a perfect pair reaches 0.3424. The size rule is
 * what that case tests; the floor only has to be reachable so the run gets
 * past the fit and on to the digests it asserts.
 */
const TINY_FLOOR = { targetPrecision: 0.3 } as const;

describe('the agreement floor is a floor, not a point estimate', () => {
  // The twin of the defect the coverage fit carried. Both searches compute a
  // Wilson interval, record it in their artifact, and read a point estimate
  // when they choose. A point estimate holds no sample size, so five samples
  // that happen to agree read 1.000 and clear any floor.
  //
  // This search maximises coverage, so it prefers a wide band and the fault
  // is rarer here than at the coverage block end. It is not absent: when the
  // only band that clears the floor is a narrow one at the top, that band
  // wins however few samples it holds.
  it('refuses a threshold that only a handful of samples support', () => {
    const samples = [
      // Five unanimous and correct. Perfect precision on five samples.
      ...Array.from({ length: 5 }, () => ({ agreement: 1, correct: true })),
      // A wide band the floor rejects outright, so the narrow one is the only
      // candidate left.
      ...Array.from({ length: 50 }, (_, i) => ({ agreement: 0.5, correct: i < 25 })),
    ];
    expect(() => fitAgreementThreshold(samples, { targetPrecision: 0.985 }))
      .toThrow(/no agreement threshold/);
  });

  it('takes a band whose lower bound holds the floor', () => {
    const samples = [
      ...Array.from({ length: 300 }, () => ({ agreement: 1, correct: true })),
      ...Array.from({ length: 50 }, (_, i) => ({ agreement: 0.5, correct: i < 25 })),
    ];
    const fit = fitAgreementThreshold(samples, { targetPrecision: 0.985 });
    expect(fit.threshold).toBe(1);
    expect(fit.interval.lower).toBeGreaterThanOrEqual(0.985);
    expect(fit.passed).toBe(300);
  });

  // A floor the sample cannot reach is a refusal, and the message says how
  // many samples the floor needs rather than leaving a caller to guess.
  it('names the support the floor needs when it refuses', () => {
    const samples = Array.from({ length: 20 }, () => ({ agreement: 1, correct: true }));
    expect(() => fitAgreementThreshold(samples, { targetPrecision: 0.985 }))
      .toThrow(/253/);
  });
});

describe('fitAgreementThreshold (DEC-13)', () => {
  it('picks the lowest threshold whose precision reaches the floor', () => {
    // The tiers keep their proportions and grow to what the floor needs. The
    // floor is read against the interval's lower bound, so twenty samples at
    // 19 of 20 reach 0.764 and could never hold 0.9 however the point
    // estimate read.
    const samples = [
      // 200 easy tickets: unanimous and correct.
      ...repeat(200, () => ({ agreement: 1, correct: true })),
      // 200 medium tickets: 8/9 agree, 180 of 200 correct.
      ...repeat(200, (i) => ({ agreement: 8 / 9, correct: i < 180 })),
      // 200 hard tickets: 7/9 agree, 100 of 200 correct.
      ...repeat(200, (i) => ({ agreement: 7 / 9, correct: i < 100 })),
    ];

    const fit = fitAgreementThreshold(samples, { targetPrecision: 0.9 });

    // 7/9 passes all 600 at precision 480/600; 8/9 passes 400 at 380/400 =
    // 0.95, whose lower bound is 0.925; 1 passes 200 at precision 1. Max
    // coverage above the floor is at 8/9.
    expect(fit.threshold).toBeCloseTo(8 / 9);
    expect(fit.precision).toBeCloseTo(380 / 400);
    expect(fit.coverage).toBeCloseTo(400 / 600);
    expect(fit.passed).toBe(400);
  });

  it('emits exactly one global threshold with a sane interval', () => {
    // Sized for its floor. The floor is read against the interval's lower
    // bound, and ten samples reach 0.5656 at their very best, so the earlier
    // pair of fives cleared 0.8 on a point estimate alone.
    const samples = [
      ...repeat(300, () => ({ agreement: 1, correct: true })),
      ...repeat(300, (i) => ({ agreement: 6 / 9, correct: i % 5 !== 0 })),
    ];

    const fit = fitAgreementThreshold(samples, { targetPrecision: 0.8 });

    expect(fit.threshold).toBeCloseTo(6 / 9);
    expect(fit.interval.lower).toBeGreaterThanOrEqual(0);
    expect(fit.interval.upper).toBeLessThanOrEqual(1);
    expect(fit.interval.lower).toBeLessThanOrEqual(fit.precision);
    expect(fit.interval.upper).toBeGreaterThanOrEqual(fit.precision);
    expect(fit.interval.confidence).toBe(0.95);
  });

  it('throws when no threshold reaches the precision floor', () => {
    const samples = repeat(6, (i) => ({ agreement: 1 - i / 9, correct: false }));
    expect(() => fitAgreementThreshold(samples, { targetPrecision: 0.9 })).toThrow(
      /lower bound holds 0\.9/,
    );
  });

  it('rejects empty input and malformed samples', () => {
    expect(() =>
      fitAgreementThreshold([], { targetPrecision: 0.9 }),
    ).toThrow(/at least one/);
    expect(() =>
      fitAgreementThreshold([{ agreement: 1.5, correct: true }], {
        targetPrecision: 0.9,
      }),
    ).toThrow(/\[0, 1\]/);
    expect(() =>
      fitAgreementThreshold([{ agreement: 1, correct: 'yes' as unknown as boolean }], {
        targetPrecision: 0.9,
      }),
    ).toThrow(/boolean/);
    expect(() =>
      fitAgreementThreshold(repeat(3, () => ({ agreement: 1, correct: true })), {
        targetPrecision: 0,
      }),
    ).toThrow(/targetPrecision/);
  });
});

describe('wilsonInterval', () => {
  it('stays inside [0, 1] and brackets small-sample proportions', () => {
    for (const [successes, n] of [
      [0, 5],
      [1, 5],
      [19, 20],
      [20, 20],
      [FIT_COUNT, FIT_COUNT * 2],
    ] as const) {
      const interval = wilsonInterval(successes, n);
      expect(interval.lower).toBeGreaterThanOrEqual(0);
      expect(interval.upper).toBeLessThanOrEqual(1);
      expect(interval.lower).toBeLessThan(interval.upper);
    }
    // Perfect small samples still keep a lower bound below 1.
    expect(wilsonInterval(20, 20).lower).toBeLessThan(1);
    // Empty samples stay impossible.
    expect(() => wilsonInterval(0, 0)).toThrow(/at least one/);
  });
});

// --- Runner tests -----------------------------------------------------------

const TAXONOMY: ClassifierTaxonomy = {
  intents: [
    { id: 'refund-request', label: 'Refund request' },
    { id: 'payment-failure', label: 'Payment failure' },
    { id: 'general-question', label: 'General question' },
    { id: 'shipping-status', label: 'Shipping status' },
  ],
};

const PIN = { promptVer: 'classify-p1', modelVer: 'test-model' };

let ticketSeq = 0;

function makeTicket(intent: string): GoldTicket {
  ticketSeq++;
  return {
    ticket_id: `SYN-CAL-${String(ticketSeq).padStart(4, '0')}`,
    source: 'synthetic',
    intent,
    queue: 'tier-1',
    disposition: {
      escalated: false,
      macro_applied: null,
      refund_issued: false,
      first_reply_minutes: 30,
    },
    subject: `${intent} case ${ticketSeq}`,
    body: `synthetic body for ${intent} case ${ticketSeq}`,
  };
}

/** A case as an adopter's own labelled half carries it: their ids, their provenance. */
function realTicket(intent: string, id: string): GoldTicket {
  return {
    ...makeTicket(intent),
    ticket_id: id,
    source: 'real',
    conversation_id: id,
    turn_number: 1,
  };
}

/** Nine unanimous, correct samples per ticket: the classifier stub's shape. */
function scriptUnanimous(tickets: readonly GoldTicket[]): { text: string }[] {
  return tickets.flatMap((ticket) =>
    Array.from({ length: 9 }, () => ({ text: ticket.intent })),
  );
}

/**
 * Script a full fit half, at the committed FIT_COUNT:
 * - about 52 per cent unanimous and correct (agreement 1);
 * - about 26 per cent at 8/9 agreement, nine in ten of them correct;
 * - the rest at 5/9 agreement, all wrong-modal.
 * The script returns the provider steps plus the matching gold half.
 *
 * The proportions are those of the original 385-case half, and they are
 * computed from FIT_COUNT rather than written out. They were written out
 * once and scaled by hand once; the growth to 4100 is what showed that a
 * hand-scaled figure is a pin that breaks on the next growth.
 *
 * The property these cases rest on survives the scaling: the 8/9 tier still
 * holds a precision under the floor, so the fit is still forced onto the
 * unanimous tier.
 */
const UNANIMOUS = Math.round((FIT_COUNT * 552) / 1062);
const TIER_8 = Math.round((FIT_COUNT * 276) / 1062);
const TIER_5 = FIT_COUNT - UNANIMOUS - TIER_8;

function scriptedFitHalf(): { steps: FakeStep[]; half: GoldFile } {
  const OTHER = 'shipping-status';
  const groups = [
    { count: UNANIMOUS, intent: 'refund-request', agree: 9, correctCount: UNANIMOUS },
    {
      count: TIER_8,
      intent: 'payment-failure',
      agree: 8,
      correctCount: Math.round((TIER_8 * 248) / 276),
    },
    { count: TIER_5, intent: 'general-question', agree: 5, correctCount: 0 },
  ] as const;

  const steps: FakeStep[] = [];
  const tickets: GoldTicket[] = [];
  for (const group of groups) {
    for (let i = 0; i < group.count; i++) {
      const ticket = makeTicket(group.intent);
      tickets.push(ticket);
      // Wrong answers first, so the modal label is unambiguous. For a
      // correct ticket the modal is the gold intent; otherwise it is OTHER.
      if (i < group.correctCount) {
        steps.push(
          ...Array.from({ length: 9 - group.agree }, () => ({ text: OTHER })),
          ...Array.from({ length: group.agree }, () => ({ text: group.intent })),
        );
      } else {
        steps.push(
          ...Array.from({ length: group.agree }, () => ({ text: OTHER })),
          ...Array.from({ length: 9 - group.agree }, () => ({ text: group.intent })),
        );
      }
    }
  }
  return {
    steps,
    half: {
      split: 'fit',
      source: 'synthetic',
      count: tickets.length,
      tickets,
    },
  };
}

function tempDirUrl(): URL {
  return pathToFileURL(mkdtempSync(join(tmpdir(), 'auracle-calib-')));
}

describe('runCalibrationJob (section 4.11, DEC-31)', () => {
  it('classifies only fit-half tickets and fits the expected threshold', async () => {
    const dir = tempDirUrl();
    try {
      const { steps, half } = scriptedFitHalf();
      const reportTicket = makeTicket('refund-request');
      reportTicket.subject = 'REPORT-ONLY subject marker';
      reportTicket.body = 'REPORT-ONLY body marker';
      const provider = new FakeProvider([...steps]);

      const { artifact } = await runCalibrationJob({
        provider,
        taxonomy: TAXONOMY,
        fitHalf: half,
        artifactDir: dir,
        ...PIN,
      });

      // Nine samples per fit ticket, and nothing else.
      expect(provider.calls.filter((c) => c.kind === 'chat')).toHaveLength(
        half.tickets.length * 9,
      );
      // DEC-31: no report-half content ever reached the provider.
      const serialized = JSON.stringify(provider.calls);
      expect(serialized).not.toContain('REPORT-ONLY');
      // Every classified text is a fit ticket text.
      const fitTexts = new Set(
        half.tickets.map((t) => `${t.subject}\n\n${t.body}`),
      );
      for (const call of provider.calls) {
        if (call.kind !== 'chat') continue;
        expect(call.messages?.[1]?.role).toBe('user');
        expect(fitTexts.has(call.messages?.[1]?.content ?? '')).toBe(true);
      }

      // Threshold selection on this distribution: the 8/9 tier passes the
      // unanimous and the 8/9 groups together, and its precision sits near
      // 0.966, under the 0.985 floor, so the floor forces the unanimous tier.
      expect(artifact.threshold).toBe(1);
      expect(artifact.precision_at_threshold).toBe(1);
      expect(artifact.coverage_at_threshold).toBeCloseTo(UNANIMOUS / FIT_COUNT);
      expect(artifact.fit_tickets).toBe(FIT_COUNT);
      expect(artifact.split_used).toBe('fit');
      // Every scripted case is a first turn, so the recorded scope says so.
      expect(artifact.scope).toBe('first_turn');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('refuses to run against anything but the fit half (DEC-31)', async () => {
    const dir = tempDirUrl();
    try {
      const reportHalf = {
        split: 'report',
        source: 'synthetic',
        count: 0,
        tickets: [],
      } as unknown as GoldFile;
      await expect(
        runCalibrationJob({
          provider: new FakeProvider([]),
          taxonomy: TAXONOMY,
          fitHalf: reportHalf,
          artifactDir: dir,
          ...PIN,
        }),
      ).rejects.toThrow(/fit half only/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires exactly the committed fit-half size (DEC-31)', async () => {
    const dir = tempDirUrl();
    try {
      // Internally consistent half (count matches tickets) so the
      // DEC-31 FIT_COUNT check is what fires, not the shape guard.
      const shortHalf = {
        split: 'fit',
        source: 'synthetic',
        count: FIT_COUNT - 1,
        tickets: Array.from({ length: FIT_COUNT - 1 }, () => makeTicket('refund-request')),
      } as unknown as GoldFile;
      await expect(
        runCalibrationJob({
          provider: new FakeProvider([]),
          taxonomy: TAXONOMY,
          fitHalf: shortHalf,
          artifactDir: dir,
          ...PIN,
        }),
      ).rejects.toThrow(new RegExp(`expected ${FIT_COUNT}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The size rule describes the corpus this repository generates. An
  // adopter's labelled half is whatever size their history gave them, and
  // refusing it for not being the committed size would say nothing about it.
  // Its two sibling jobs each have this case; this one did not, so the guard
  // at the boundary the injection path bypasses was unproven here.
  it('refuses a provenance outside the closed set (DEC-18)', async () => {
    const dir = tempDirUrl();
    try {
      await expect(
        runCalibrationJob({
          provider: new FakeProvider([]),
          taxonomy: TAXONOMY,
          fitHalf: {
            split: 'fit', source: 'production' as GoldFile['source'], count: 1,
            tickets: [realTicket('refund-request', 'a@example.test')],
          },
          artifactDir: dir,
          ...PIN,
        }),
      ).rejects.toThrow(/expected one of synthetic, real/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records the attrition it fitted through, and refuses above the ceiling', async () => {
    const dir = tempDirUrl();
    try {
      // Twenty cases, one of them carrying a single unreadable sample: 5 per
      // cent, at the ceiling and not above it.
      const tickets = Array.from({ length: 20 }, (_, i) =>
        realTicket('refund-request', `c${i}@example.test`),
      );
      const script = scriptUnanimous(tickets) as { text?: string; finishReason?: string }[];
      script[0] = { finishReason: 'length' };
      const { artifact } = await runCalibrationJob({
        provider: new FakeProvider(script),
        taxonomy: TAXONOMY,
        fitHalf: { split: 'fit', source: 'real', count: 20, tickets },
        reportIdentity: identityOf({
          split: 'report', source: 'real', count: 20,
          tickets: Array.from({ length: 20 }, (_, i) =>
            realTicket('refund-request', `d${i}@example.test`)),
        }),
        artifactDir: dir,
        ...PIN,
        ...SMALL_FLOOR,
      });
      // The values, not merely the fields: without these the whole feature
      // can be deleted and the suite does not notice.
      expect(artifact.unreadable_samples).toBe(1);
      expect(artifact.tickets_with_unreadable).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to fit when too many cases carry an unreadable sample', async () => {
    const dir = tempDirUrl();
    try {
      const tickets = Array.from({ length: 12 }, (_, i) =>
        realTicket('refund-request', `e${i}@example.test`),
      );
      const script = scriptUnanimous(tickets) as { text?: string; finishReason?: string }[];
      // One case of twelve is 8.3 per cent: above this ceiling and below a
      // looser one. Two of ten passes a ceiling three times too wide, so that
      // rate alone left the constant's value unpinned.
      script[0] = { finishReason: 'length' };
      await expect(
        runCalibrationJob({
          provider: new FakeProvider(script),
          taxonomy: TAXONOMY,
          fitHalf: { split: 'fit', source: 'real', count: 12, tickets },
          reportIdentity: identityOf({
            split: 'report', source: 'real', count: 12,
            tickets: Array.from({ length: 12 }, (_, i) =>
              realTicket('refund-request', `f${i}@example.test`)),
          }),
          artifactDir: dir,
          ...PIN,
        }),
      ).rejects.toThrow(/ceiling/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a labelled half from real history, of any size', async () => {
    const dir = tempDirUrl();
    try {
      const tickets = [
        realTicket('refund-request', 'a@example.test'),
        realTicket('refund-request', 'b@example.test'),
      ];
      const result = await runCalibrationJob({
        provider: new FakeProvider(scriptUnanimous(tickets)),
        taxonomy: TAXONOMY,
        fitHalf: { split: 'fit', source: 'real', count: 2, tickets },
        // Equal size, as DEC-31 asks and assertHalvesDisjoint now enforces.
        reportIdentity: identityOf({
          split: 'report', source: 'real', count: 2,
          tickets: [
            realTicket('refund-request', 'y@example.test'),
            realTicket('refund-request', 'z@example.test'),
          ],
        }),
        artifactDir: dir,
        ...PIN,
        ...TINY_FLOOR,
      });
      expect(result.artifact.gold_source).toBe('real');
      expect(result.artifact.fit_tickets).toBe(2);
      // The digests were computed and never asserted, so swapping the two
      // expressions passed. They must name the two sets, and differ.
      expect(result.artifact.fit_half_digest).toBe(halfDigest(identityOf({
        split: 'fit', source: 'real', count: 2, tickets,
      })));
      expect(result.artifact.report_half_digest).not.toBe(result.artifact.fit_half_digest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A fitting job cannot see the report half, so nothing inside it can prove
  // the split. It refuses to fit rather than publish a threshold whose
  // disjointness nobody checked.
  it('refuses a real half with no report half to prove the split against (DEC-31)', async () => {
    const dir = tempDirUrl();
    try {
      const tickets = [realTicket('refund-request', 'a@example.test')];
      await expect(
        runCalibrationJob({
          provider: new FakeProvider([]),
          taxonomy: TAXONOMY,
          fitHalf: { split: 'fit', source: 'real', count: 1, tickets },
          artifactDir: dir,
          ...PIN,
        }),
      ).rejects.toThrow(/report half/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a real half that overlaps its report half (DEC-31)', async () => {
    const dir = tempDirUrl();
    try {
      const shared = realTicket('refund-request', 'a@example.test');
      await expect(
        runCalibrationJob({
          provider: new FakeProvider([]),
          taxonomy: TAXONOMY,
          fitHalf: { split: 'fit', source: 'real', count: 1, tickets: [shared] },
          reportIdentity: identityOf({
            split: 'report', source: 'real', count: 1, tickets: [{ ...shared }],
          }),
          artifactDir: dir,
          ...PIN,
        }),
      ).rejects.toThrow(/appears in both halves/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A bypass this case closes: a file read by path that
  // declares itself synthetic. loadGoldHalf(split, path) cross-checks
  // nothing, so the "committed corpus" justification for skipping the proof
  // does not hold here. The caller had already supplied the report half's
  // identifiers and the guard threw them away.
  it('checks a supplied report identity even when the half declares synthetic (DEC-31)', async () => {
    const dir = tempDirUrl();
    try {
      const tickets = Array.from({ length: FIT_COUNT }, () => makeTicket('refund-request'));
      await expect(
        runCalibrationJob({
          provider: new FakeProvider([]),
          taxonomy: TAXONOMY,
          fitHalf: { split: 'fit', source: 'synthetic', count: FIT_COUNT, tickets },
          // The same cases, declared as the other half.
          reportIdentity: identityOf({
            split: 'report', source: 'synthetic', count: FIT_COUNT, tickets,
          }),
          artifactDir: dir,
          ...PIN,
        }),
      ).rejects.toThrow(/appears in both halves/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a half whose declared count disagrees with its tickets', async () => {
    const dir = tempDirUrl();
    try {
      const { half } = scriptedFitHalf();
      const lyingHalf = { ...half, count: FIT_COUNT, tickets: half.tickets.slice(0, 10) };
      await expect(
        runCalibrationJob({
          provider: new FakeProvider([]),
          taxonomy: TAXONOMY,
          fitHalf: lyingHalf as unknown as GoldFile,
          artifactDir: dir,
          ...PIN,
        }),
      ).rejects.toThrow(new RegExp(`declares ${FIT_COUNT} tickets but carries 10`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('needs a pinned modelVer (DEC-26)', async () => {
    // Validation happens before any classification, so an empty script is fine.
    const { half } = scriptedFitHalf();
    const dir = tempDirUrl();
    try {
      await expect(
        runCalibrationJob({
          provider: new FakeProvider([]),
          taxonomy: TAXONOMY,
          fitHalf: half,
          artifactDir: dir,
          promptVer: PIN.promptVer,
        }),
      ).rejects.toThrow(/modelVer/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runCalibrationJob over a conversation (DEC-37, DEC-39)', () => {
  const REPLY = 'We closed the duplicate charge and confirmed the renewal date.';

  /**
   * Turns the first two cases of the scripted half into one two-turn
   * conversation, leaving the remaining 383 as first turns. The provider
   * script is untouched: the job still classifies FIT_COUNT cases in the same
   * order, so every scripted vote still lands on the case it was written for.
   */
  function withOneConversation(): { steps: FakeStep[]; half: GoldFile } {
    const { steps, half } = scriptedFitHalf();
    const [first, second] = half.tickets;
    if (!first || !second) throw new Error('scripted half is too small to hold a conversation');
    first.conversation_id = 'CONV-CAL-0001';
    first.turn_number = 1;
    first.agent_reply = REPLY;
    second.conversation_id = 'CONV-CAL-0001';
    second.turn_number = 2;
    return { steps, half };
  }

  it('sends the earlier turn and its reply into the later turn prompt', async () => {
    const dir = tempDirUrl();
    try {
      const { steps, half } = withOneConversation();
      const provider = new FakeProvider(steps);
      const [first, second] = half.tickets;

      await runCalibrationJob({
        provider,
        taxonomy: TAXONOMY,
        fitHalf: half,
        artifactDir: dir,
        ...PIN,
      });

      const prompts = provider.calls
        .filter((call) => call.kind === 'chat')
        .map((call) => call.messages?.[1]?.content ?? '');
      // Nine samples per case, in case order: the first nine are turn 1.
      const turnOnePrompt = prompts[0] ?? '';
      const turnTwoPrompt = prompts[9] ?? '';

      expect(turnOnePrompt).not.toContain('Earlier turns:');
      expect(turnOnePrompt).toBe(`${first?.subject}\n\n${first?.body}`);

      expect(turnTwoPrompt).toContain('Earlier turns:');
      // The history line is the whole earlier message, subject included: that
      // is what turn.body_text holds, so this is the runtime's own shape.
      expect(turnTwoPrompt).toContain(`[turn 1] customer: ${first?.subject}\n\n${first?.body}`);
      expect(turnTwoPrompt).toContain(`[turn 1] agent: ${REPLY}`);
      expect(turnTwoPrompt).toContain(`Latest message:\n${second?.subject}\n\n${second?.body}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('fits on every turn and records the population as all_turns', async () => {
    const dir = tempDirUrl();
    try {
      const { steps, half } = withOneConversation();

      const { artifact } = await runCalibrationJob({
        provider: new FakeProvider(steps),
        taxonomy: TAXONOMY,
        fitHalf: half,
        artifactDir: dir,
        ...PIN,
      });

      // DEC-39 binds the jobs that score a disposition. This one scores a
      // label, which a later turn carries, so nothing is dropped.
      expect(artifact.fit_tickets).toBe(FIT_COUNT);
      expect(artifact.scope).toBe('all_turns');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('calibration artifact round-trip', () => {
  // The digest shape had no negative case in either job: a value that is
  // neither null nor a digest loaded clean, so the field could carry
  // anything while claiming to name the pair a run proved.
  it('refuses an attrition count that is not a count', () => {
    // A published threshold must state the evidence it was missing: unreadable
    // samples lowered agreement without being a judgement.
    expect(() => validateCalibrationArtifact({ ...BASE, unreadable_samples: -1 })).toThrow(
      /unreadable_samples/,
    );
    expect(() => validateCalibrationArtifact({ ...BASE, unreadable_samples: 1.5 })).toThrow(
      /unreadable_samples/,
    );
  });

  it('starts against an artifact written before the attrition count existed', () => {
    // The one field rule that accepts absence. This artifact is read at
    // startup by every daemon, and refusing an older one would stop the
    // system over a number the job now records — the blocking chain this
    // repository removed, rebuilt in a different key.
    const raw = { ...BASE } as Record<string, unknown>;
    delete raw['unreadable_samples'];
    expect(() => validateCalibrationArtifact(raw)).not.toThrow();
  });

  it('refuses a digest that is neither null nor a digest', () => {
    for (const field of ['fit_half_digest', 'report_half_digest'] as const) {
      expect(() => validateCalibrationArtifact({ ...BASE, [field]: 'not-a-digest' }))
        .toThrow(new RegExp(field));
      expect(() => validateCalibrationArtifact({ ...BASE, [field]: 'ABCDEF0123456789' }))
        .toThrow(new RegExp(field));
    }
  });

  const BASE: CalibrationArtifact = {    artifact: 'agreement-threshold',
    version: 1,
    fitted_at: '2026-02-01T00:00:00.000Z',
    gold_source: 'synthetic',
    split_used: 'fit',
    scope: 'first_turn',
    fit_tickets: FIT_COUNT,
    unreadable_samples: 0,
    fit_half_digest: null,
    report_half_digest: null,
    prompt_ver: 'classify-p1',
    model_ver: 'test-model',
    target_precision: 0.985,
    threshold: 8 / 9,
    precision_at_threshold: 0.95,
    coverage_at_threshold: 2 / 3,
    interval: { confidence: 0.95, lower: 0.86, upper: 0.99 },
  };

  function tempDirUrl(): URL {
    return pathToFileURL(mkdtempSync(join(tmpdir(), 'auracle-calib-')));
  }

  it('writes then loads the same artifact, choosing the highest version', async () => {
    const dir = tempDirUrl();
    try {
      await writeCalibrationArtifact(BASE, dir);
      await writeCalibrationArtifact(
        { ...BASE, version: await nextVersion(dir), threshold: 1 },
        dir,
      );

      const latest = await loadCalibrationArtifact(undefined, dir);
      expect(latest?.version).toBe(2);
      expect(latest?.threshold).toBe(1);

      const pinned = await loadCalibrationArtifact(1, dir);
      expect(pinned).toEqual(BASE);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null when nothing was calibrated yet', async () => {
    const dir = tempDirUrl();
    try {
      expect(await loadCalibrationArtifact(undefined, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Regression: a fresh checkout has no calibration/ directory. Writing must
  // create it and loading must report "nothing yet" instead of ENOENT.
  it('works against a directory that does not exist yet', async () => {
    const parent = tempDirUrl();
    try {
      // Trailing slash required: without it, URL resolution replaces the
      // last path segment instead of appending under it.
      const missing = new URL(`calibration/deep/`, `${parent.href}/`);

      expect(await loadCalibrationArtifact(undefined, missing)).toBeNull();
      expect(await nextVersion(missing)).toBe(1);

      await writeCalibrationArtifact(BASE, missing);
      const loaded = await loadCalibrationArtifact(undefined, missing);
      expect(loaded).toEqual(BASE);
      expect(loaded?.version).toBe(1);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects tampered artifacts', () => {
    expect(() =>
      validateCalibrationArtifact({ ...BASE, split_used: 'report' }),
    ).toThrow(/fit half/);
    expect(() =>
      validateCalibrationArtifact({ ...BASE, threshold: 1.5 }),
    ).toThrow(/threshold/);
    expect(() =>
      validateCalibrationArtifact({ ...BASE, artifact: 'something-else' }),
    ).toThrow(/agreement-threshold/);
    expect(() =>
      validateCalibrationArtifact({
        ...BASE,
        interval: { confidence: 0.95, lower: 0.99, upper: 0.86 },
      }),
    ).toThrow(/bracket/);
    expect(() => validateCalibrationArtifact({ ...BASE, gold_source: 'live' })).toThrow(
      /synthetic/,
    );
    expect(() => validateCalibrationArtifact({ ...BASE, scope: 'every-turn' })).toThrow(
      /artifact.scope/,
    );
    // A well-formed artifact passes untouched.
    expect(validateCalibrationArtifact(BASE)).toEqual(BASE);
  });
});
