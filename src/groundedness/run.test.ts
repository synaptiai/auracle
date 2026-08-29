import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FakeProvider } from '../models/fake.js';
import { runGroundednessJob } from './run.js';
import { loadGoldHalf } from '../fixtures/load.js';
import type { GoldFile, GoldTicket } from '../fixtures/load.js';

const tempDir = (): URL => pathToFileURL(mkdtempSync(join(tmpdir(), 'auracle-gjob-')));

/** A draft whose claims all cite one real document. */
function draft(id: string, supported: number, unsupported: number, grade = 'absent'): GoldTicket {
  const claims = [
    ...Array.from({ length: supported }, (_, i) => ({
      text: `supported claim ${i}`,
      doc_id: 'DOC-SYN-002',
      supported: true,
      grade: null,
    })),
    ...Array.from({ length: unsupported }, (_, i) => ({
      text: `unsupported claim ${i}`,
      doc_id: 'DOC-SYN-002',
      supported: false,
      grade: grade as 'absent',
    })),
  ];
  return {
    ticket_id: id,
    source: 'synthetic',
    intent: 'refund-request',
    queue: 'billing',
    disposition: { escalated: false, macro_applied: null, refund_issued: false, first_reply_minutes: 5 },
    subject: 'Subject',
    body: 'Body',
    claims,
  };
}

function half(tickets: GoldTicket[]): GoldFile {
  return { split: 'fit', source: 'synthetic', count: tickets.length, tickets };
}

/**
 * A judge that catches every unsupported claim except `missesPerTicket` of
 * them, per ticket.
 *
 * A perfect judge collapses the two thresholds onto one value: nothing is
 * ambiguous, so nothing reaches a person, and the fit refuses. That refusal is
 * right and the fixture would be wrong — the gate exists for the judge that
 * sometimes misses. A miss must not take a draft to coverage 1.0 either, or it
 * lands among the grounded drafts and no threshold holds the precision floor.
 */
function scriptFor(
  tickets: readonly GoldTicket[],
  missesPerTicket: ReadonlyMap<string, number>,
): { text: string }[] {
  return tickets.flatMap((t) => {
    let budget = missesPerTicket.get(t.ticket_id) ?? 0;
    return (t.claims ?? []).map((c) => {
      if (c.supported) return { text: 'VERDICT: SUPPORTED' };
      if (budget > 0) {
        budget -= 1;
        return { text: 'VERDICT: SUPPORTED' };
      }
      return { text: 'VERDICT: UNSUPPORTED' };
    });
  });
}

describe('runGroundednessJob (section 4.7, DEC-31)', () => {
  it('fits both thresholds and records what it measured', async () => {
    const tickets = [
      ...Array.from({ length: 12 }, (_, i) => draft(`G-${i}`, 3, 0)),
      // Caught outright: coverage 1/3.
      ...Array.from({ length: 6 }, (_, i) => draft(`U-${i}`, 1, 2)),
      // One of two missed: coverage 5/6, inside the review band and below 1.0.
      ...Array.from({ length: 6 }, (_, i) => draft(`V-${i}`, 4, 2)),
    ];
    const misses = new Map(tickets.filter((t) => t.ticket_id.startsWith('V-')).map((t) => [t.ticket_id, 1]));
    const dir = tempDir();
    try {
      const { artifact } = await runGroundednessJob({
        provider: new FakeProvider(scriptFor(tickets, misses)),
        fitHalf: half(tickets),
        modelVer: 'test-stub',
        artifactDir: dir,
      });

      // Strictly below, so a band exists for a person. An equal pair means
      // no draft was ambiguous and the job refuses instead.
      expect(artifact.block).toBeLessThan(artifact.review);
      expect(artifact.fit_drafts).toBe(24);
      expect(artifact.by_grade[0]?.grade).toBe('absent');
      expect(artifact.by_grade[0]?.drafts).toBe(12);
      // The band is real: the 5/6 drafts sit inside it.
      expect(artifact.block).toBeLessThanOrEqual(5 / 6);
      // block_drafts is the denominator behind block_npv. Wiring it to any
      // other count publishes a number that measured something else, and the
      // compiler cannot tell: every candidate is a number. The six U drafts
      // sit at 1/3, below the block value.
      expect(artifact.block_drafts).toBe(6);
      // Every published figure, not the denominator alone. Each is a number in
      // [0, 1] that the validator cannot tell apart, so wiring any of them to
      // another quantity publishes a rate that measured something else — the
      // failure this artifact exists to prevent. Candidates are {1/3, 5/6, 1}:
      // review takes 1.0 (12 of 12 pure), block takes 5/6 with the six U
      // drafts below it.
      expect(artifact.block_npv).toBe(1);
      expect(artifact.review).toBe(1);
      expect(artifact.review_precision).toBe(1);
      expect(artifact.review_coverage).toBe(12 / 24);
      // Each interval must bracket its own rate. Swapping the two publishes a
      // bound computed over a different denominator, and both are objects of
      // the same shape, so nothing else would notice.
      expect(artifact.block_interval.lower).toBeLessThanOrEqual(artifact.block_npv);
      expect(artifact.block_interval.upper).toBeGreaterThanOrEqual(artifact.block_npv);
      expect(artifact.review_interval.lower).toBeLessThanOrEqual(artifact.review_precision);
      // Six drafts against twelve: the block interval is the wider one.
      const width = (i: { lower: number; upper: number }): number => i.upper - i.lower;
      expect(width(artifact.block_interval)).toBeGreaterThan(width(artifact.review_interval));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes each figure as itself, not as another that happens to match', async () => {
    // In the fixture above block_npv, review and review_precision are all 1,
    // so wiring `review` to a precision RATE survived every assertion — and
    // review is the threshold the policy engine compares against.
    //
    // Here the four numbers are pairwise distinct by construction:
    //   G x10  3 claims, all correct               -> 1.0  grounded
    //   H x6   6 claims, one wrongly refused       -> 5/6  grounded
    //   Y x1   6 claims, one unsupported caught    -> 5/6  UNgrounded
    //   U x12  2 claims, the unsupported caught    -> 1/2  ungrounded
    //   V x4   4 claims, all three caught          -> 1/4  ungrounded
    //   X x1   4 claims, three wrongly refused     -> 1/4  GROUNDED
    // Y drags review_precision off 1.0; X drags block_npv off 1.0. The floors
    // are set below both so a fit still exists.
    const tickets = [
      ...Array.from({ length: 10 }, (_, i) => draft(`G-${i}`, 3, 0)),
      ...Array.from({ length: 6 }, (_, i) => draft(`H-${i}`, 6, 0)),
      draft('Y-0', 5, 1),
      ...Array.from({ length: 12 }, (_, i) => draft(`U-${i}`, 1, 1)),
      ...Array.from({ length: 4 }, (_, i) => draft(`V-${i}`, 1, 3)),
      draft('X-0', 4, 0),
    ];
    // The H drafts carry no unsupported claim, so the judge must wrongly
    // refuse one of theirs. scriptFor only misses in the other direction.
    const script = tickets.flatMap((t) => {
      const claims = t.claims ?? [];
      let refused = t.ticket_id.startsWith('H-') ? 1 : t.ticket_id.startsWith('X-') ? 3 : 0;
      return claims.map((c) => {
        if (!c.supported) return { text: 'VERDICT: UNSUPPORTED' };
        if (refused > 0) {
          refused -= 1;
          return { text: 'VERDICT: UNSUPPORTED' };
        }
        return { text: 'VERDICT: SUPPORTED' };
      });
    });

    const dir = tempDir();
    try {
      const { artifact } = await runGroundednessJob({
        provider: new FakeProvider(script),
        fitHalf: half(tickets),
        modelVer: 'test-stub',
        artifactDir: dir,
        targetPrecision: 0.9,
        targetNpv: 0.8,
      });

      expect(artifact.review).toBeCloseTo(5 / 6, 10);
      expect(artifact.review_precision).toBeCloseTo(16 / 17, 10);
      expect(artifact.block).toBe(0.5);
      expect(artifact.block_npv).toBeCloseTo(4 / 5, 10);
      // Pairwise distinct, so wiring any one to another is caught.
      expect(artifact.review).not.toBe(artifact.review_precision);
      expect(artifact.block).not.toBe(artifact.block_npv);
      expect(artifact.review).not.toBe(artifact.block);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('refuses the report half (DEC-31)', async () => {
    await expect(
      runGroundednessJob({
        provider: new FakeProvider([]),
        fitHalf: { ...half([draft('A', 1, 0)]), split: 'report' as 'fit' },
        modelVer: 'test-stub',
        artifactDir: tempDir(),
      }),
    ).rejects.toThrow(/fit half only/);
  });

  it('refuses a non-synthetic half (DEC-18)', async () => {
    await expect(
      runGroundednessJob({
        provider: new FakeProvider([]),
        fitHalf: { ...half([draft('A', 1, 0)]), source: 'production' },
        modelVer: 'test-stub',
        artifactDir: tempDir(),
      }),
    ).rejects.toThrow(/synthetic/);
  });

  it('needs a pinned model version (DEC-26)', async () => {
    await expect(
      runGroundednessJob({
        provider: new FakeProvider([]),
        fitHalf: half([draft('A', 1, 0)]),
        modelVer: '',
        artifactDir: tempDir(),
      }),
    ).rejects.toThrow(/pinned modelVer/);
  });

  it('emits nothing when the judge cannot separate the classes', async () => {
    // Every claim is called supported, so coverage is 1.0 whatever the truth.
    // A threshold here would be satisfied by any candidate.
    const tickets = [
      ...Array.from({ length: 6 }, (_, i) => draft(`G-${i}`, 2, 0)),
      ...Array.from({ length: 6 }, (_, i) => draft(`U-${i}`, 2, 1)),
    ];
    const blind = tickets.flatMap((t) => (t.claims ?? []).map(() => ({ text: 'VERDICT: SUPPORTED' })));

    await expect(
      runGroundednessJob({
        provider: new FakeProvider(blind),
        fitHalf: half(tickets),
        modelVer: 'test-stub',
        artifactDir: tempDir(),
      }),
    ).rejects.toThrow(/does not separate/);
  });

  it('checks the artifact directory before it spends a model call', async () => {
    const provider = new FakeProvider([]);
    const dir = tempDir();
    // A stray artifact-shaped name makes the directory unusable.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(new URL('v05.json', `${dir.href}/`), '{}');

    await expect(
      runGroundednessJob({
        provider,
        fitHalf: half([draft('A', 1, 1)]),
        modelVer: 'test-stub',
        artifactDir: dir,
      }),
    ).rejects.toThrow(/not a versioned artifact/);
    expect(provider.calls).toHaveLength(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it('scores every labelled draft of the committed fit half', () => {
    // The corpus must actually carry claims, or the job would score nothing.
    const labelled = loadGoldHalf('fit').tickets.filter((t) => (t.claims ?? []).length > 0);

    expect(labelled).toHaveLength(385);
  });
});
