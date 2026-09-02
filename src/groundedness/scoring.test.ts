// The shared scoring pass both coverage jobs run on.
//
// The cases here are the ones that only reach `scoreHalf`: what a run does
// when the checkpoint itself fails, and what it reports having spent. The two
// jobs' own suites cover what they do with the samples afterwards.

import { describe, expect, it } from 'vitest';

import { FakeProvider } from '../models/fake.js';
import type { GoldTicket } from '../fixtures/load.js';
import type { CoverageSample } from './fit.js';
import type { ResumeCost, ResumeStore } from './resume.js';
import { describeFaultShapes, describeSpend, scoreHalf, scoringDigest } from './scoring.js';

const PINS = { promptVer: 'ground-p1', modelVer: 'test-stub' };
const BODIES = new Map([['DOC-SYN-002', 'The document body every claim cites.']]);

function draft(id: string): GoldTicket {
  return {
    ticket_id: id,
    source: 'synthetic',
    intent: 'refund-request',
    queue: 'billing',
    disposition: { escalated: false, macro_applied: null, refund_issued: false, first_reply_minutes: 5 },
    subject: 'Subject',
    body: 'Body',
    claims: [{ text: 'a claim', doc_id: 'DOC-SYN-002', supported: true, grade: null }],
  };
}

/** A store whose writes fail the first `failures` times they are attempted. */
function failingStore(failures: number): ResumeStore & { records: number } {
  const done = new Map<string, CoverageSample | null>();
  const cost = new Map<string, ResumeCost>();
  let left = failures;
  return {
    done,
    cost,
    records: 0,
    idKey: (id: string) => id,
    async record(id, sample, spent) {
      this.records += 1;
      if (left > 0) {
        left -= 1;
        throw new Error('ENOSPC: no space left on device');
      }
      done.set(id, sample);
      cost.set(id, spent);
    },
  };
}

describe('scoreHalf and the checkpoint it writes', () => {
  // The sharp one. The sample used to join the run before the checkpoint was
  // written, with the write inside the same try. A failed write is not an
  // UnreadableAnswerError, so it fell through to the transport arm: the draft
  // was scored again and the sample already pushed stayed. One draft then
  // contributed three samples to an interval whose whole purpose is to carry
  // its own sample size honestly — and the run did not fail, so the inflated
  // count reached the artifact with nothing to say so.
  it('fails the run when it cannot checkpoint, rather than scoring twice', async () => {
    const store = failingStore(1);
    await expect(scoreHalf(
      [draft('G-1')],
      BODIES,
      new FakeProvider([{ text: 'VERDICT: SUPPORTED' }, { text: 'VERDICT: SUPPORTED' }]),
      PINS,
      'synthetic',
      0,
      store,
    )).rejects.toThrow(/resume file could not be written/);
    // One attempt, not five. A write fault is not a transport fault: the
    // answer is already paid for and asking again cannot make the disk work.
    expect(store.records).toBe(1);
  });

  it('scores each draft once when the checkpoint holds', async () => {
    const store = failingStore(0);
    const { samples, costMicros, costUnknown } = await scoreHalf(
      [draft('G-1'), draft('G-2')],
      BODIES,
      new FakeProvider([{ text: 'VERDICT: SUPPORTED' }, { text: 'VERDICT: SUPPORTED' }]),
      PINS,
      'synthetic',
      0,
      store,
    );
    expect(samples).toHaveLength(2);
    expect(store.records).toBe(2);
    // Two drafts of one claim each, so two judge calls. The fake bills a cent
    // per call, and the run reports the pair rather than dropping it: this is
    // the figure the fit job spent its whole life unable to state (DEC-25).
    expect(costMicros).toBe(2 * 10_000);
    expect(costUnknown).toBe(false);
    // And each draft's share reaches the checkpoint, so a resume can add it.
    expect(store.cost.get('G-1')).toEqual({ costMicros: 10_000, costUnknown: false });
  });

  // A resumed draft was paid for by the run that died. The artifact names one
  // fit, and that fit was paid for across every run that produced it (DEC-25).
  it('adds the spend an earlier run recorded for a draft it resumes', async () => {
    const store = failingStore(0);
    store.done.set('G-1', { coverage: 1, grounded: true, grade: null });
    store.cost.set('G-1', { costMicros: 250, costUnknown: false });

    const { samples, costMicros, costUnknown } = await scoreHalf(
      [draft('G-1')],
      BODIES,
      new FakeProvider([]),
      PINS,
      'synthetic',
      0,
      store,
    );
    expect(samples).toHaveLength(1);
    expect(costMicros).toBe(250);
    expect(costUnknown).toBe(false);
  });

  // A row written before the spend field existed says nothing about what that
  // draft cost. Counting it as free is the understatement DEC-25 forbids.
  it('marks the total a floor when a resumed draft carries no recorded spend', async () => {
    const store = failingStore(0);
    store.done.set('G-1', { coverage: 1, grounded: true, grade: null });

    const { costMicros, costUnknown } = await scoreHalf(
      [draft('G-1')], BODIES, new FakeProvider([]), PINS, 'synthetic', 0, store,
    );
    expect(costMicros).toBe(0);
    expect(costUnknown).toBe(true);
  });
});

describe('scoringDigest', () => {
  const one = draft('G-1');

  it('moves when a claim sentence changes under a fixed ticket id', () => {
    const edited = { ...one, claims: [{ ...one.claims![0]!, text: 'a different claim' }] };
    expect(scoringDigest([edited], BODIES)).not.toBe(scoringDigest([one], BODIES));
  });

  // One field per case. Flipping `supported` and `grade` together left neither
  // pinned: deleting either from the digest's row kept the whole suite green,
  // and a resumed run would then reuse samples scored against a label that has
  // since changed — which is the failure the digest exists to prevent.
  it('moves when a support label flips', () => {
    const flipped = { ...one, claims: [{ ...one.claims![0]!, supported: false }] };
    expect(scoringDigest([flipped], BODIES)).not.toBe(scoringDigest([one], BODIES));
  });

  it('moves when only the grade of an unsupported claim changes', () => {
    const base = { ...one, claims: [{ ...one.claims![0]!, supported: false, grade: 'absent' as const }] };
    const harder = { ...one, claims: [{ ...one.claims![0]!, supported: false, grade: 'off_topic' as const }] };
    expect(scoringDigest([harder], BODIES)).not.toBe(scoringDigest([base], BODIES));
  });

  it('moves when the cited document is rewritten', () => {
    const rewritten = new Map([['DOC-SYN-002', 'A different document body entirely.']]);
    expect(scoringDigest([one], rewritten)).not.toBe(scoringDigest([one], BODIES));
  });

  it('holds when only the order of the drafts changes', () => {
    const two = draft('G-2');
    expect(scoringDigest([one, two], BODIES)).toBe(scoringDigest([two, one], BODIES));
  });

  // On a real half the claim is the customer's own sentence and the document
  // is the adopter's (DEC-18). The digest carries neither in the clear.
  it('writes neither the claim text nor the document body', () => {
    const secret = { ...one, claims: [{ ...one.claims![0]!, text: 'order 4471 was refunded' }] };
    const digest = scoringDigest([secret], new Map([['DOC-SYN-002', 'refunds within 30 days']]));
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(digest).not.toContain('4471');
    expect(digest).not.toContain('refund');
  });
});

describe('the two lines a scoring run reports', () => {
  // A run reports one dominant cause, and reading a tally sorted by count
  // alone left that cause depending on the order the corpus happened to fault
  // in. The runbook names a different remedy for each.
  it('breaks a tie in the fault tally on the shape name, not on arrival order', () => {
    const arrived = new Map([['truncated', 4], ['empty', 4], ['no-label', 1]]);
    const reordered = new Map([['empty', 4], ['truncated', 4], ['no-label', 1]]);
    expect(describeFaultShapes(arrived)).toBe('empty 4, truncated 4, no-label 1');
    expect(describeFaultShapes(reordered)).toBe(describeFaultShapes(arrived));
  });

  it('says when a spend figure is a floor rather than a total', () => {
    expect(describeSpend(12_500, false)).toBe('12500 micro-dollars (0.0125 USD)');
    expect(describeSpend(12_500, true)).toMatch(/^at least 12500 micro-dollars \(0\.0125 USD\)/);
    expect(describeSpend(undefined, undefined)).toBe('not recorded');
  });
});
