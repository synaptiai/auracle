import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { FakeProvider } from '../models/fake.js';
import type { ModelProvider } from '../models/provider.js';
import { runGroundednessJob } from './job.js';
import { scoreDraft } from './scoring.js';
import { FIT_COUNT } from '../domain/gold-types.js';
import { loadGoldHalf } from '../fixtures/load.js';
import { identityOf } from '../fixtures/digest.js';
import type { GoldFile, GoldTicket } from '../domain/gold-types.js';

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

/**
 * Floors these plumbing cases can actually reach.
 *
 * The shipped floors are read against a 95 percent interval, so 0.985 needs
 * 253 drafts above the threshold and 0.9 needs 35 below. These fixtures are a
 * dozen drafts with hand-chosen coverage values, built to make one figure
 * distinguishable from another, and scaling them by twenty-six to reach the
 * shipped floors would destroy the property each was written to test. The
 * floors are lowered to what a dozen drafts support instead: a perfect six
 * reaches 0.6098 and a perfect twelve reaches 0.7576.
 *
 * `fit.test.ts` covers the floors themselves at the sizes they need.
 */
const SMALL_FLOORS = { targetPrecision: 0.6, targetNpv: 0.6 } as const;

/**
 * A provider that fails the transport a fixed number of times, then delegates.
 *
 * Not an UnreadableAnswerError: that is an answer the provider will reproduce,
 * and the job already drops such a draft and counts it. This is the other kind
 * of fault, a connection that did not complete.
 */
class FlakyTransport implements ModelProvider {
  failures: number;
  constructor(private readonly inner: ModelProvider, failures: number) {
    this.failures = failures;
  }
  async complete(call: Parameters<ModelProvider['complete']>[0]) {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new TypeError('fetch failed');
    }
    return this.inner.complete(call);
  }
  async embed(call: Parameters<ModelProvider['embed']>[0]) {
    return this.inner.embed(call);
  }
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
        ...SMALL_FLOORS,
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
        // Floors this fixture can reach. The four figures must stay pairwise
        // distinct, which needs the awkward bands to survive, and the floors
        // are read against a 95 percent interval: 16 of 17 gives a lower bound
        // of 0.7302 and 4 of 5 gives 0.3755. Raising either floor above those
        // does not make the fixture stricter, it deletes the band the case
        // exists to inspect.
        targetPrecision: 0.7,
        targetNpv: 0.35,
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

  // The size rule applies to a synthetic half only, so on the real path this
  // is the only check on a declared count. A run over the whole fit half makes
  // thousands of calls, and the job holds no checkpoint, so a connection that
  // drops once would cost every scored draft.
  //
  // A judging call reads; it delivers nothing and changes nothing outside this
  // process. So repeating one duplicates no effect, and DEC-30 does not reach
  // it: that rule governs a delivery whose state is unknown.
  it('retries a transport fault instead of discarding the run', async () => {
    const tickets = [
      ...Array.from({ length: 12 }, (_, i) => draft(`G-${i}`, 3, 0)),
      ...Array.from({ length: 6 }, (_, i) => draft(`U-${i}`, 1, 2)),
      ...Array.from({ length: 6 }, (_, i) => draft(`V-${i}`, 4, 2)),
    ];
    const misses = new Map(
      tickets.filter((t) => t.ticket_id.startsWith('V-')).map((t) => [t.ticket_id, 1]),
    );
    const dir = tempDir();
    try {
      const { artifact } = await runGroundednessJob({
        provider: new FlakyTransport(new FakeProvider(scriptFor(tickets, misses)), 1),
        fitHalf: half(tickets),
        modelVer: 'test-stub',
        artifactDir: dir,
        ...SMALL_FLOORS,
        retryDelayMs: 0,
      });
      // The run completed, and the retried draft is scored rather than dropped.
      expect(artifact.fit_drafts).toBe(24);
      expect(artifact.faulted_drafts).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // A transport that never recovers still fails the run. A retry that never
  // gives up is a hang, and an operator waiting on a four-hour job cannot see
  // the difference between the two.
  it('gives up on a transport that never recovers', async () => {
    const tickets = Array.from({ length: 4 }, (_, i) => draft(`G-${i}`, 3, 0));
    const dir = tempDir();
    try {
      await expect(runGroundednessJob({
        provider: new FlakyTransport(new FakeProvider([]), 99),
        fitHalf: half(tickets),
        modelVer: 'test-stub',
        artifactDir: dir,
        ...SMALL_FLOORS,
        retryDelayMs: 0,
      })).rejects.toThrow(/fetch failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // Three runs over a full half died and each discarded every draft scored
  // before it. The retry rides out a short outage; nothing rode out a long
  // one, and nothing survived a killed shell at all.
  it('continues an interrupted run instead of paying for it twice', async () => {
    const tickets = [
      ...Array.from({ length: 12 }, (_, i) => draft(`G-${i}`, 3, 0)),
      ...Array.from({ length: 6 }, (_, i) => draft(`U-${i}`, 1, 2)),
      ...Array.from({ length: 6 }, (_, i) => draft(`V-${i}`, 4, 2)),
    ];
    const misses = new Map(
      tickets.filter((t) => t.ticket_id.startsWith('V-')).map((t) => [t.ticket_id, 1]),
    );
    const dir = tempDir();
    const resumeFile = join(mkdtempSync(join(tmpdir(), 'auracle-resume-job-')), 'r.jsonl');
    try {
      // The first attempt dies partway: the script runs out and the provider
      // throws, which is not an UnreadableAnswerError and so ends the run.
      // Cut on a draft boundary, at six G drafts of three claims each, so the
      // second attempt's script starts where a draft starts.
      const full = scriptFor(tickets, misses);
      await expect(runGroundednessJob({
        provider: new FakeProvider(full.slice(0, 18)),
        fitHalf: half(tickets),
        modelVer: 'test-stub',
        artifactDir: dir,
        ...SMALL_FLOORS,
        retryDelayMs: 0,
        resumeFile,
      })).rejects.toThrow();

      // The second attempt is given only what the first did not consume, so
      // it can only finish by resuming. A run that started over would exhaust
      // this script and throw.
      const provider = new FakeProvider(full.slice(18));
      const { artifact } = await runGroundednessJob({
        provider,
        fitHalf: half(tickets),
        modelVer: 'test-stub',
        artifactDir: dir,
        ...SMALL_FLOORS,
        retryDelayMs: 0,
        resumeFile,
      });
      expect(artifact.fit_drafts).toBe(24);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(resumeFile, { force: true });
    }
  }, 30_000);

  // The artifact must carry what the run spent (DEC-25, AC6). Deleting the two
  // lines that write it left the whole groundedness suite green: the only
  // assertion on those fields read the committed reference file, which does
  // not change when the code that writes it is removed.
  it('records what the run spent, and whether that figure is a total', async () => {
    const tickets = [
      ...Array.from({ length: 12 }, (_, i) => draft(`G-${i}`, 3, 0)),
      ...Array.from({ length: 6 }, (_, i) => draft(`U-${i}`, 1, 2)),
      ...Array.from({ length: 6 }, (_, i) => draft(`V-${i}`, 4, 2)),
    ];
    const misses = new Map(
      tickets.filter((t) => t.ticket_id.startsWith('V-')).map((t) => [t.ticket_id, 1]),
    );
    const dir = tempDir();
    try {
      const { artifact } = await runGroundednessJob({
        provider: new FakeProvider(scriptFor(tickets, misses)),
        fitHalf: half(tickets),
        modelVer: 'test-stub',
        ...SMALL_FLOORS,
        artifactDir: dir,
      });
      // Every claim of every draft is one judge call, and the fake bills a
      // cent each. Derived from the corpus, not pinned to what the code
      // happens to return.
      const calls = tickets.reduce((n, t) => n + (t.claims ?? []).length, 0);
      expect(artifact.cost_micros).toBe(calls * 10_000);
      // No draft faulted and no transport retried, so the figure is exact.
      expect(artifact.cost_unknown).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('drops the drafts the judge could not score and keeps fitting', async () => {
    const tickets = [
      ...Array.from({ length: 12 }, (_, i) => draft(`G-${i}`, 3, 0)),
      ...Array.from({ length: 6 }, (_, i) => draft(`U-${i}`, 1, 2)),
      ...Array.from({ length: 6 }, (_, i) => draft(`V-${i}`, 4, 2)),
    ];
    const misses = new Map(
      tickets.filter((t) => t.ticket_id.startsWith('V-')).map((t) => [t.ticket_id, 1]),
    );
    // One more draft, whose first claim comes back with no verdict. The run
    // must not abort there and discard every draft scored before it.
    const faulting = draft('F-0', 3, 0);
    // The judge aborts on that draft's first claim, so it consumes one entry
    // and the entries for the drafts before it stay aligned.
    const script = [...scriptFor(tickets, misses), { text: '' }];
    const dir = tempDir();
    try {
      const { artifact } = await runGroundednessJob({
        provider: new FakeProvider(script),
        fitHalf: half([...tickets, faulting]),
        modelVer: 'test-stub',
        ...SMALL_FLOORS,
        artifactDir: dir,
      });
      // The 24 scorable drafts are fitted; the one that faulted is dropped.
      expect(artifact.fit_drafts).toBe(24);
      // And the artifact says so. Without this the field can report zero and
      // the published threshold hides its own attrition.
      expect(artifact.faulted_drafts).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses at a rate that a wider ceiling would have allowed', async () => {
    // Two faults in twenty-six is 7.7 per cent: above the ceiling this job
    // sets and below a looser one. Without this case the constant's value is
    // decorative — the only other guard case drives the rate to 100 per cent,
    // which any ceiling below one would refuse.
    const tickets = [
      ...Array.from({ length: 12 }, (_, i) => draft(`G-${i}`, 3, 0)),
      ...Array.from({ length: 6 }, (_, i) => draft(`U-${i}`, 1, 2)),
      ...Array.from({ length: 6 }, (_, i) => draft(`V-${i}`, 4, 2)),
    ];
    const misses = new Map(
      tickets.filter((t) => t.ticket_id.startsWith('V-')).map((t) => [t.ticket_id, 1]),
    );
    const faulting = [draft('F-0', 3, 0), draft('F-1', 3, 0)];
    const script = [...scriptFor(tickets, misses), { text: '' }, { text: '' }];
    const dir = tempDir();
    try {
      await expect(
        runGroundednessJob({
          provider: new FakeProvider(script),
          fitHalf: half([...tickets, ...faulting]),
          modelVer: 'test-stub',
        ...SMALL_FLOORS,
          artifactDir: dir,
        }),
      ).rejects.toThrow(/ceiling/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a half whose declared count disagrees with its tickets', async () => {
    await expect(
      runGroundednessJob({
        provider: new FakeProvider([]),
        fitHalf: { ...half([draft('A', 1, 0)]), count: 9 },
        modelVer: 'test-stub',
        artifactDir: tempDir(),
      }),
    ).rejects.toThrow(/declares 9 tickets but carries 1/);
  });

  it('refuses the report half (DEC-31)', async () => {
    await expect(
      runGroundednessJob({
        provider: new FakeProvider([]),
        fitHalf: { ...half([draft('A', 1, 0)]), split: 'report' as 'fit' },
        modelVer: 'test-stub',
        ...SMALL_FLOORS,
        artifactDir: tempDir(),
      }),
    ).rejects.toThrow(/fit half only/);
  });

  it('refuses a provenance outside the closed set (DEC-18)', async () => {
    await expect(
      runGroundednessJob({
        provider: new FakeProvider([]),
        fitHalf: { ...half([draft('A', 1, 0)]), source: 'production' as GoldFile['source'] },
        modelVer: 'test-stub',
        ...SMALL_FLOORS,
        artifactDir: tempDir(),
        reportIdentity: identityOf({
          split: 'report', source: 'real', count: 1,
          tickets: [{ ...draft('Z', 1, 0), source: 'real' as const }],
        }),
      }),
    ).rejects.toThrow(/expected one of synthetic, real/);
  });

  // A synthetic half draws its DEC-31 proof from the committed corpus. A real
  // one has no such guarantee, so the job refuses to fit rather than publish
  // a threshold whose disjointness nobody checked.
  it('refuses a real half with no report half to prove the split against (DEC-31)', async () => {
    await expect(
      runGroundednessJob({
        provider: new FakeProvider([]),
        fitHalf: { ...half([draft('A', 1, 0)]), source: 'real' },
        modelVer: 'test-stub',
        ...SMALL_FLOORS,
        artifactDir: tempDir(),
      }),
    ).rejects.toThrow(/report half/);
  });

  it('refuses a real half that overlaps its report half (DEC-31)', async () => {
    const shared = draft('A', 1, 0);
    await expect(
      runGroundednessJob({
        provider: new FakeProvider([]),
        fitHalf: { split: 'fit', source: 'real', count: 1, tickets: [shared] },
        modelVer: 'test-stub',
        ...SMALL_FLOORS,
        artifactDir: tempDir(),
        reportIdentity: identityOf({ split: 'report', source: 'real', count: 1, tickets: [{ ...shared }] }),
      }),
    ).rejects.toThrow(/appears in both halves/);
  });

  // Two hundred drafts a side, where the cases above use a dozen. The
  // grounded-share guard is an equivalence test, so a half must be large
  // enough to show its share is close to the other's; eighteen drafts cannot
  // show that of anything and are refused before the fit is reached. That is
  // the guard working: a half this small cannot support a threshold either.
  it('fits on a labelled half from real history and records the provenance', async () => {
    const tickets = [
      ...Array.from({ length: 200 }, (_, i) => draft(`G-${i}`, 6, 0)),
      ...Array.from({ length: 200 }, (_, i) => draft(`B-${i}`, 2, 4)),
      ...Array.from({ length: 200 }, (_, i) => draft(`V-${i}`, 4, 2)),
    ].map((ticket) => ({ ...ticket, source: 'real' as const }));
    const misses = new Map(tickets.filter((t) => t.ticket_id.startsWith('V-')).map((t) => [t.ticket_id, 1]));
    const dir = tempDir();
    try {
      const { artifact } = await runGroundednessJob({
        provider: new FakeProvider(scriptFor(tickets, misses)),
        fitHalf: { split: 'fit', source: 'real', count: tickets.length, tickets },
        modelVer: 'test-stub',
        ...SMALL_FLOORS,
        artifactDir: dir,
        // Equal size, as DEC-31 asks and assertHalvesDisjoint now enforces.
        // The sentences differ too: a report half that reuses the fit half's
        // claims cannot corroborate it, so the same check refuses that as well.
        reportIdentity: identityOf({
          split: 'report', source: 'real', count: tickets.length,
          tickets: tickets.map((t, i) => ({
            ...t,
            ticket_id: `R-${i}`,
            conversation_id: `R-${i}`,
            claims: (t.claims ?? []).map((c) => ({ ...c, text: `report ${i} ${c.text}` })),
          })),
        }),
      });
      expect(artifact.gold_source).toBe('real');
      expect(artifact.block).toBeLessThan(artifact.review);
      // F4: the coverage fit records the pair it proved, like the other two.
      expect(artifact.fit_half_digest).toMatch(/^[0-9a-f]{16}$/);
      expect(artifact.report_half_digest).toMatch(/^[0-9a-f]{16}$/);
      expect(artifact.fit_half_digest).not.toBe(artifact.report_half_digest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // F3: the DEC-31 bypass regression was pinned in the agreement fit only.
  // Reinstating the early return here left this suite green, so the same
  // defect could return in this job unnoticed.
  it('checks a supplied report identity even when the half declares synthetic (DEC-31)', async () => {
    const tickets = [draft('A', 1, 0)];
    await expect(
      runGroundednessJob({
        provider: new FakeProvider([]),
        fitHalf: { split: 'fit', source: 'synthetic', count: 1, tickets },
        reportIdentity: identityOf({ split: 'report', source: 'synthetic', count: 1, tickets }),
        modelVer: 'test-stub',
        ...SMALL_FLOORS,
        artifactDir: tempDir(),
      }),
    ).rejects.toThrow(/appears in both halves/);
  });

  // These redactions survived mutation in cycle 4: they were correct only by
  // accident. This is the first fault a real fit half hits, because
  // loadDocuments enforces the shipped DOC-SYN- prefixes.
  it('names a real case and its cited document by digest, never in the clear', async () => {
    const real: GoldTicket = {
      ...draft('A', 1, 0),
      ticket_id: 'msg@customer-domain.example',
      source: 'real',
      claims: [{ text: 'x', doc_id: 'THEIR-OWN-DOC-1', supported: true, grade: null }],
    };
    await expect(
      scoreDraft(real, new Map(), new FakeProvider([]), { promptVer: 'p', modelVer: 'm' }, 'real'),
    ).rejects.toThrow(/id digest [0-9a-f]{12}/);
    await expect(
      scoreDraft(real, new Map(), new FakeProvider([]), { promptVer: 'p', modelVer: 'm' }, 'real'),
    ).rejects.not.toThrow(/customer-domain\.example/);
    await expect(
      scoreDraft(real, new Map(), new FakeProvider([]), { promptVer: 'p', modelVer: 'm' }, 'real'),
    ).rejects.not.toThrow(/THEIR-OWN-DOC-1/);
  });

  // The direct-call case above proves scoreDraft redacts. It does not prove
  // the JOB hands it the half's real provenance — and that wiring is what
  // the register promises for the adopter path.
  it('passes the half provenance through the job, not just to a direct call', async () => {
    // Six hundred drafts a side, where this case once used one. The
    // grounded-share guard is an equivalence test, and a one-draft half cannot
    // demonstrate closeness, so it now refuses before the run reaches the
    // document fault this case is named for. Every draft is grounded on both
    // sides, which is the boundary the Agresti-Caffo correction covers.
    const realAt = (i: number): GoldTicket => ({
      ...draft(`A-${i}`, 1, 0),
      ticket_id: `msg-${i}@customer-domain.example`,
      conversation_id: `msg-${i}@customer-domain.example`,
      source: 'real',
      claims: [{ text: `fit sentence ${i}`, doc_id: 'THEIR-OWN-DOC-1', supported: true, grade: null }],
    });
    const fitTickets = Array.from({ length: 600 }, (_, i) => realAt(i));
    const call = runGroundednessJob({
      provider: new FakeProvider([]),
      fitHalf: { split: 'fit', source: 'real', count: fitTickets.length, tickets: fitTickets },
      reportIdentity: identityOf({
        split: 'report', source: 'real', count: fitTickets.length,
        tickets: fitTickets.map((t, i) => ({
          ...t,
          ticket_id: `other-${i}@example.test`,
          conversation_id: `other-${i}@example.test`,
          // Sentences of their own, so the halves pass the disjointness check
          // and the run reaches the document fault this case is named for.
          claims: [{
            text: `report sentence ${i}`, doc_id: 'THEIR-OWN-DOC-1', supported: true, grade: null,
          }],
        })),
      }),
      modelVer: 'test-stub',
      artifactDir: tempDir(),
    });
    await expect(call).rejects.toThrow(/id digest [0-9a-f]{12}/);
    await expect(call).rejects.not.toThrow(/customer-domain\.example/);
  });

  it('names a synthetic case plainly', async () => {
    const synth: GoldTicket = {
      ...draft('A', 1, 0),
      claims: [{ text: 'x', doc_id: 'DOC-SYN-999', supported: true, grade: null }],
    };
    await expect(
      scoreDraft(synth, new Map(), new FakeProvider([]), { promptVer: 'p', modelVer: 'm' }, 'synthetic'),
    ).rejects.toThrow(/DOC-SYN-999/);
  });

  // The refusal exists so a half with no labels names its own cause instead of
  // dying inside the fitter with "needs both classes". The warning tells an
  // operator how much of their half was not scored.
  it('refuses a half that carries no labelled claims, naming the cause (DEC-07)', async () => {
    const bare = { ...draft('A', 1, 0) };
    delete (bare as { claims?: unknown }).claims;
    await expect(
      runGroundednessJob({
        provider: new FakeProvider([]),
        fitHalf: half([bare]),
        modelVer: 'test-stub',
        ...SMALL_FLOORS,
        artifactDir: tempDir(),
      }),
    ).rejects.toThrow(/carries no labelled claims across 1 cases/);
  });

  it('reports how many cases carry no labelled claims', async () => {
    const labelled = Array.from({ length: 6 }, (_, i) => draft(`G-${i}`, 6, 0))
      .concat(Array.from({ length: 6 }, (_, i) => draft(`B-${i}`, 2, 4)))
      .concat(Array.from({ length: 6 }, (_, i) => draft(`V-${i}`, 4, 2)));
    const bare = { ...draft('Z', 1, 0) };
    delete (bare as { claims?: unknown }).claims;
    const misses = new Map(labelled.filter((t) => t.ticket_id.startsWith('V-')).map((t) => [t.ticket_id, 1]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dir = tempDir();
    try {
      await runGroundednessJob({
        provider: new FakeProvider(scriptFor(labelled, misses)),
        fitHalf: half([...labelled, bare]),
        modelVer: 'test-stub',
        ...SMALL_FLOORS,
        artifactDir: dir,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 of 19 fit-half cases'));
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
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
        ...SMALL_FLOORS,
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
        ...SMALL_FLOORS,
        artifactDir: dir,
      }),
    ).rejects.toThrow(/not a versioned artifact/);
    expect(provider.calls).toHaveLength(0);

    rmSync(dir, { recursive: true, force: true });
  });

  it('scores every labelled draft of the committed fit half', () => {
    // The corpus must actually carry claims, or the job would score nothing.
    const labelled = loadGoldHalf('fit').tickets.filter((t) => (t.claims ?? []).length > 0);

    expect(labelled).toHaveLength(FIT_COUNT);
  });
});
