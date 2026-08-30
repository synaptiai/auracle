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
import { FIT_COUNT, halfDigest, identityOf } from '../fixtures/load.js';
import type { GoldFile, GoldTicket } from '../fixtures/load.js';

function repeat(count: number, make: (i: number) => AgreementSample): AgreementSample[] {
  return Array.from({ length: count }, (_, i) => make(i));
}

describe('fitAgreementThreshold (DEC-13)', () => {
  it('picks the lowest threshold whose precision reaches the floor', () => {
    const samples = [
      // 10 easy tickets: unanimous and correct.
      ...repeat(10, () => ({ agreement: 1, correct: true })),
      // 10 medium tickets: 8/9 agree, 9 of 10 correct.
      ...repeat(10, (i) => ({ agreement: 8 / 9, correct: i < 9 })),
      // 10 hard tickets: 7/9 agree, 5 of 10 correct.
      ...repeat(10, (i) => ({ agreement: 7 / 9, correct: i < 5 })),
    ];

    const fit = fitAgreementThreshold(samples, { targetPrecision: 0.9 });

    // 7/9 passes all 30 at precision 24/30; 8/9 passes 20 at 19/20 = 0.95;
    // 1 passes 10 at precision 1. Max coverage above the floor is at 8/9.
    expect(fit.threshold).toBeCloseTo(8 / 9);
    expect(fit.precision).toBeCloseTo(19 / 20);
    expect(fit.coverage).toBeCloseTo(20 / 30);
    expect(fit.passed).toBe(20);
  });

  it('emits exactly one global threshold with a sane interval', () => {
    const samples = [
      ...repeat(5, () => ({ agreement: 1, correct: true })),
      ...repeat(5, (i) => ({ agreement: 6 / 9, correct: i < 4 })),
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
      /precision 0\.9/,
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
      [385, 770],
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
 * Script a full 385-ticket fit half:
 * - 200 tickets unanimous and correct (agreement 1);
 * - 100 tickets at 8/9 agreement, 90 correct and 10 wrong-modal;
 * - 85 tickets at 5/9 agreement, all wrong-modal.
 * The script returns the provider steps plus the matching gold half.
 */
function scriptedFitHalf(): { steps: FakeStep[]; half: GoldFile } {
  const OTHER = 'shipping-status';
  const groups = [
    { count: 200, intent: 'refund-request', agree: 9, correctCount: 200 },
    { count: 100, intent: 'payment-failure', agree: 8, correctCount: 90 },
    { count: 85, intent: 'general-question', agree: 5, correctCount: 0 },
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

      // Threshold selection on this distribution: the 8/9 tier passes 300
      // tickets but holds only 290 correct, precision 0.967 < 0.985, so the
      // floor forces the unanimous tier.
      expect(artifact.threshold).toBe(1);
      expect(artifact.precision_at_threshold).toBe(1);
      expect(artifact.coverage_at_threshold).toBeCloseTo(200 / 385);
      expect(artifact.fit_tickets).toBe(385);
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

  it('requires exactly the committed 385 fit tickets (DEC-31)', async () => {
    const dir = tempDirUrl();
    try {
      // Internally consistent half (count matches tickets) so the
      // DEC-31 FIT_COUNT check is what fires, not the shape guard.
      const shortHalf = {
        split: 'fit',
        source: 'synthetic',
        count: 384,
        tickets: Array.from({ length: 384 }, () => makeTicket('refund-request')),
      } as unknown as GoldFile;
      await expect(
        runCalibrationJob({
          provider: new FakeProvider([]),
          taxonomy: TAXONOMY,
          fitHalf: shortHalf,
          artifactDir: dir,
          ...PIN,
        }),
      ).rejects.toThrow(/expected 385/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The size rule describes the corpus this repository generates. An
  // adopter's labelled half is whatever size their history gave them, and
  // refusing it for not being 385 would say nothing about its correctness.
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

  // The bypass an adversarial review found: a file read by path that
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
      const lyingHalf = { ...half, count: 385, tickets: half.tickets.slice(0, 10) };
      await expect(
        runCalibrationJob({
          provider: new FakeProvider([]),
          taxonomy: TAXONOMY,
          fitHalf: lyingHalf as unknown as GoldFile,
          artifactDir: dir,
          ...PIN,
        }),
      ).rejects.toThrow(/declares 385 tickets but carries 10/);
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
   * script is untouched: the job still classifies 385 cases in the same
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
      expect(artifact.fit_tickets).toBe(385);
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
    fit_tickets: 385,
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
