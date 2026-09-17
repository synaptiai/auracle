// What a journal step says on the run detail page (issue #27).
//
// These ran through `main.ts` until now, which runs `main()` on import, so
// nothing asserted them. The park branch is why that mattered.
import { describe, expect, it } from 'vitest';

import {
  agreementDetail, evidenceOf, latencyCaveats, percentileShare, stepSays, toDetail, toRow,
} from './views.js';
import { ageSays, whenSays } from './surfaces.js';
import type { JournalStep, RunJournal } from 'auracle/ledger-read';

const RUN = '11111111-2222-4333-8444-555555555555';

function journal(step: Partial<JournalStep>): { step: JournalStep; journal: RunJournal } {
  const full = {
    stepId: 'park', recognized: true, status: 'done',
    resultRecorded: true, resultMalformed: false, awaitingOutcome: false,
    promptVer: 'p1', modelVer: 'm1', runCostMicrosAtStep: 0,
    compose: null, park: null, idemKey: null, escalationReason: null, faultShape: null,
    ...step,
  } as unknown as JournalStep;
  return {
    step: full,
    journal: {
      runId: RUN, steps: [full], agreement: null, coverage: null,
      documents: null, documentsMalformed: false,
    } as unknown as RunJournal,
  };
}

function park(fields: Record<string, unknown>): { step: JournalStep; journal: RunJournal } {
  return journal({
    stepId: 'park',
    park: {
      actionClass: 'send_reply', delivery: 'at_most_once', parkKey: null,
      draftRecorded: false, payloadRecorded: false, failureRecorded: false,
      turnNumber: null, ...fields,
    },
  } as Partial<JournalStep>);
}

// Agreement is a share of nine samples, so a count is derived from it. A
// hand-written 1.4 is carried as recorded, and a count derived from it would
// state "13 of 9 samples", which the ledger does not hold.
describe('what an agreement says about its samples', () => {
  it('states the samples that agreed for a share of nine', () => {
    expect(agreementDetail(8 / 9)).toBe('8 of 9 samples');
    expect(agreementDetail(0)).toBe('0 of 9 samples');
    expect(agreementDetail(1)).toBe('9 of 9 samples');
  });

  it('states a value outside [0, 1] as recorded, and derives no count', () => {
    expect(agreementDetail(1.4)).toBe('recorded 1.4, not a share of samples');
    expect(agreementDetail(-0.5)).toBe('recorded -0.5, not a share of samples');
    expect(agreementDetail(1e21)).toBe('recorded 1e+21, not a share of samples');
  });

  // Nine samples make ten possible shares. 0.5 is none of them, so it has no
  // count the classifier could have recorded.
  it('derives no count from a value no count of nine gives', () => {
    expect(agreementDetail(0.5)).toBe('recorded 0.5, not a share of samples');
    expect(agreementDetail(-1e-308)).toBe('recorded -1e-308, not a share of samples');
    expect(agreementDetail(7 / 9)).toBe('7 of 9 samples');
    // Near a share is not a share, and the full value shows why.
    expect(agreementDetail(0.1111111111)).toBe('recorded 0.1111111111, not a share of samples');
    expect(agreementDetail(0.7777)).toBe('recorded 0.7777, not a share of samples');
    for (let k = 0; k <= 9; k += 1) expect(agreementDetail(k / 9)).toBe(`${k} of 9 samples`);
  });

  it('says the same on the classify step', () => {
    const { step, journal: j } = journal({ stepId: 'classify' } as Partial<JournalStep>);
    const read = { ...j, agreement: { intentId: 'x', agreement: 1.4, unreadableSamples: null, threshold: null } } as RunJournal;
    expect(stepSays(step, read)).toBe('intent x · agreement recorded 1.4, not a share of samples');
    const share = { ...j, agreement: { intentId: 'x', agreement: 8 / 9, unreadableSamples: null, threshold: null } } as RunJournal;
    expect(stepSays(step, share)).toBe('intent x · 8 of 9 samples agreed');
  });
});

describe('what a park step says', () => {
  it('names a draft the helpdesk holds', () => {
    const { step, journal: j } = park({ draftRecorded: true });
    expect(stepSays(step, j)).toContain('draft held in the helpdesk');
  });

  it('names a recorded action payload', () => {
    const { step, journal: j } = park({ payloadRecorded: true });
    expect(stepSays(step, j)).toContain('action payload recorded');
  });

  // The crash marker. It records a park key and no body, which means a draft
  // may exist in the helpdesk that nobody can name — the thing a person has
  // to reconcile. It used to read `nothing recorded`.
  it('names a park key with no draft behind it, rather than reporting nothing', () => {
    const { step, journal: j } = park({ parkKey: 'send_reply:SYN-1:abc', status: 'parking' });
    const said = stepSays(step, j);
    expect(said).toContain('park key recorded, no draft named');
    expect(said).not.toContain('nothing recorded');
  });

  // The refusal. The adapter's error is withheld, because it can quote a
  // customer address. Its presence is not withheld.
  it('names an adapter refusal, rather than reporting nothing', () => {
    const { step, journal: j } = park({ failureRecorded: true, status: 'failed' });
    const said = stepSays(step, j);
    expect(said).toContain('the adapter refused before it appended');
    expect(said).not.toContain('nothing recorded');
  });

  it('still reports nothing when the row truly recorded nothing', () => {
    const { step, journal: j } = park({});
    expect(stepSays(step, j)).toContain('nothing recorded');
  });

  it('says nothing at all about a park step the reader could not read', () => {
    const { step, journal: j } = journal({ stepId: 'park', park: null });
    expect(stepSays(step, j)).toBeNull();
  });
});

describe('what a run row carries onto a page', () => {
  const item = {
    runId: RUN, ticketId: 'SYN-4471', state: 'resolved', promptVer: 'p1',
    reason: null, gateReason: 'customer_visible', intentId: 'refund-request',
    coverage: 0.94, createdAt: new Date('2026-09-07T09:00:00.000Z'),
    costMicros: 1234, stepsUsed: 6,
    agreement: 0.89, agreementThreshold: 0.8, coverageReviewThreshold: 0.75,
    riskTier: 'high' as const, approved: false,
  };

  it('keeps a null reason a null, rather than an empty string', () => {
    expect(toRow({ ...item, reason: null }).reason).toBeNull();
  });

  // The relay interpolates whatever an adapter threw, and an SMTP rejection
  // quotes the recipient. The trim happens at this one boundary, so every
  // surface reading through it gets the trimmed value.
  it('trims an escalation reason that carries interpolated text', () => {
    const trimmed = toRow({ ...item, reason: 'delivery_unknown: 550 no such user ada@x.example' });
    expect(trimmed.reason).toBe('delivery_unknown (detail withheld)');
    expect(trimmed.reason).not.toContain('ada@x.example');
  });

  // Issue #94: the escalations module gained a `fault` field, whole and
  // untrimmed, because `pnpm run escalations` is a command and this page is
  // not. A row carries the fields this function names and no others, so a
  // field added to the reader cannot reach a surface by accident — which is
  // the property the trim above depends on.
  it('carries no field this boundary did not name', () => {
    const row = toRow({
      ...item,
      fault: 'gate ran before classify: the run has no classification',
    } as Parameters<typeof toRow>[0]);

    expect(Object.keys(row)).not.toContain('fault');
    expect(JSON.stringify(row)).not.toContain('ran before classify');
  });

  it('leaves a reason from the closed vocabulary whole', () => {
    expect(toRow({ ...item, reason: 'policy_escalated' }).reason).toBe('policy_escalated');
  });

  it('carries the parked draft id onto a detail, and a null when none parked', () => {
    const detail = {
      ...item, payloadRecorded: false, actionClass: 'customer_reply',
      delivery: 'at_least_once', payload: null,
    };
    expect(toDetail({ ...detail, draftExternalId: 'hd-99' }).draftExternalId).toBe('hd-99');
    expect(toDetail({ ...detail, draftExternalId: null }).draftExternalId).toBeNull();
  });

  // The gate rule is not free text. It is one of a closed set the policy
  // engine writes, so trimming it as an escalation reason is trimmed would
  // hand a person a truncated rule name.
  it('carries the gate rule whole, beside the escalation reason', () => {
    const row = toRow({ ...item, reason: null, gateReason: 'no_idempotency' });
    expect(row.gateReason).toBe('no_idempotency');
    expect(row.reason).toBeNull();
  });

  // Null, never zero, and never today. A run the queue could not date is a
  // run whose age nobody knows, and a surface printing "0m" for it would
  // report the freshest possible item.
  it('carries the run time, and a null when the ledger recorded none', () => {
    expect(toRow(item).createdAt).toEqual(new Date('2026-09-07T09:00:00.000Z'));
    expect(toRow({ ...item, createdAt: null }).createdAt).toBeNull();
  });

  it('carries the coverage the gate read, and a null when it never gated', () => {
    expect(toRow(item).gateCoverage).toBe(0.94);
    expect(toRow({ ...item, coverage: null }).gateCoverage).toBeNull();
  });

  // Issue #101. The queue groups on each gate against its own line, so the
  // detail carries all four values the reader returned, and null as null.
  it('carries each gate value and its own line onto a detail', () => {
    const base = {
      ...item, draftExternalId: null, payloadRecorded: false, actionClass: 'customer_reply',
      delivery: 'at_most_once', payload: null,
    };
    const detail = toDetail(base);
    expect(detail.agreement).toBe(0.89);
    expect(detail.agreementThreshold).toBe(0.8);
    expect(detail.gateCoverage).toBe(0.94);
    expect(detail.coverage).toBe(0.94);
    expect(detail.coverageReviewThreshold).toBe(0.75);
    expect(detail.riskTier).toBe('high');
    expect(toDetail({ ...base, riskTier: null }).riskTier).toBeNull();
    expect(detail.approved).toBe(false);
    expect(toDetail({ ...base, approved: true }).approved).toBe(true);
    const unread = toDetail({
      ...base, agreement: null, agreementThreshold: null, coverage: null, coverageReviewThreshold: null,
    });
    expect([unread.agreement, unread.agreementThreshold, unread.coverage, unread.coverageReviewThreshold])
      .toEqual([null, null, null, null]);
  });

  // DEC-34. A ledger-only park is approvable, and the detail has to say so.
  it('carries whether a park journalled an action payload (DEC-34)', () => {
    const base = {
      ...item, draftExternalId: null, actionClass: 'compensate',
      delivery: 'at_most_once', payload: null,
    };
    expect(toDetail({ ...base, payloadRecorded: true }).payloadRecorded).toBe(true);
    expect(toDetail({ ...base, payloadRecorded: false }).payloadRecorded).toBe(false);
  });

  // The name the approval warning says out loud. Approving a ledger-only
  // park performs an action rather than sending a reply, and an operator is
  // owed the name of the thing they are about to do — a null here degrades
  // that sentence to "performs the action".
  // DEC-40: the approver reads what they are approving, and a ledger-only
  // park has no drafted reply — the payload is the whole of the act.
  it('carries the payload the approval will perform', () => {
    const base = {
      ...item, draftExternalId: null, payloadRecorded: true,
      actionClass: 'compensate', delivery: 'at_most_once',
    };
    expect(toDetail({ ...base, payload: { amountMicros: 500 } }).payload)
      .toEqual({ amountMicros: 500 });
    expect(toDetail({ ...base, payload: null }).payload).toBeNull();
  });

  it('carries what the park will perform, and a null when the row named none', () => {
    const base = {
      ...item, draftExternalId: null, payloadRecorded: true,
      delivery: 'at_most_once', payload: { amountMicros: 500 },
    };
    expect(toDetail({ ...base, actionClass: 'apply_credit' }).actionClass).toBe('apply_credit');
    expect(toDetail({ ...base, actionClass: null }).actionClass).toBeNull();
  });
});

describe('the runs a partition could not measure', () => {
  const wait = { count: 10, unmeasured: 0, unordered: 0, p50Ms: 1, p95Ms: 2, p99Ms: 3, maxMs: 4 };
  const service = {
    count: 10, unfinished: 0, unstamped: 0, unordered: 0, neverRan: 0,
    p50Ms: 1, p95Ms: 2, p99Ms: 3, maxMs: 4,
  };
  const base = { partition: 0, runs: 10, wait, service };

  it('names nothing when every run was measured', () => {
    expect(latencyCaveats(base)).toEqual([]);
  });

  it('names each state that holds a run, and none that holds none', () => {
    expect(latencyCaveats({ ...base, wait: { ...wait, unmeasured: 3 } }))
      .toEqual(['3 no arrival time']);
    expect(latencyCaveats({ ...base, service: { ...service, neverRan: 2 } }))
      .toEqual(['2 never ran']);
  });

  // The coverage guard. `excluded` in the latency job prints the ledger's own
  // state names, which is right for a command an engineer runs and wrong for
  // a console an operator reads — so the wording differs on purpose and the
  // console cannot simply call it. What must not differ is which states get
  // named at all: a seventh would otherwise be invisible here.
  it('covers every excluded state the query module exposes', () => {
    const states = { ...base, wait: { ...wait, unmeasured: 1, unordered: 1 },
      service: { ...service, unfinished: 1, unstamped: 1, unordered: 1, neverRan: 1 } };
    expect(latencyCaveats(states)).toHaveLength(6);
    // Read off the distributions rather than restated, so a new state fails
    // this rather than passing unnoticed.
    const countsOnly = new Set(['count', 'p50Ms', 'p95Ms', 'p99Ms', 'maxMs']);
    const excludedFields = [...Object.keys(states.wait), ...Object.keys(states.service)]
      .filter((key) => !countsOnly.has(key));
    expect(latencyCaveats(states)).toHaveLength(excludedFields.length);
  });
});

// DEC-43. The gate records a verdict by position among the *cited* sentences,
// and this is where that position becomes a mark on the page. A courtesy
// sentence advancing the count would move every later verdict onto the wrong
// claim, and the console would then vouch for a sentence the judge refused.
describe('numbering the claims of a reply that opens with a courtesy sentence', () => {
  function composed(): RunJournal {
    return {
      runId: RUN,
      steps: [{
        stepId: 'compose', recognized: true, status: 'done',
        resultRecorded: true, resultMalformed: false, awaitingOutcome: false,
        promptVer: 'p1', modelVer: 'm1', runCostMicrosAtStep: 0,
        park: null, idemKey: null, escalationReason: null, faultShape: null,
        compose: {
          abstained: false, claimCount: 2, staleDocumentIds: [], provider: 'stub',
          citedBodies: null,
          sentences: [
            { text: 'Thanks for writing in.', docId: null },
            { text: 'A charge is refundable inside fourteen days.', docId: 'SYN-DOC-01' },
            { text: 'We already sent your money back.', docId: 'SYN-DOC-01' },
            { text: 'Reply here if that is not it.', docId: null },
          ],
          claims: [
            { text: 'A charge is refundable inside fourteen days.', docId: 'SYN-DOC-01' },
            { text: 'We already sent your money back.', docId: 'SYN-DOC-01' },
          ],
        },
      }],
      agreement: null,
      // The judge accepted the first claim and refused the second. Two
      // different verdicts on purpose: with both the same, an off-by-one
      // would land on a verdict that happens to agree and prove nothing.
      coverage: {
        groundedness: 0.5, decision: 'gated', reason: 'customer_visible',
        blockThreshold: 0.7, reviewThreshold: 0.8,
        claimVerdicts: [
          { claimIndex: 0, supported: true },
          { claimIndex: 1, supported: false },
        ],
      },
      documents: null, documentsMalformed: false,
    } as unknown as RunJournal;
  }

  it('counts the position among the cited sentences, not in the reply', () => {
    const evidence = evidenceOf(composed());
    expect(evidence.sentences?.map((sentence) => sentence.claimIndex))
      .toEqual([null, 0, 1, null]);
  });

  it('puts each verdict on the claim the gate judged', () => {
    const evidence = evidenceOf(composed());
    // The refusal belongs to the second claim, which is the third sentence.
    // Counting courtesy sentences would move it onto nothing at all, and the
    // claim the judge refused would then draw as accepted.
    expect(evidence.sentences?.map((sentence) => sentence.supported))
      .toEqual([null, true, false, null]);
    expect(evidence.claims).toEqual([
      {
        index: 0, text: 'A charge is refundable inside fourteen days.',
        docId: 'SYN-DOC-01', supported: true,
      },
      {
        index: 1, text: 'We already sent your money back.',
        docId: 'SYN-DOC-01', supported: false,
      },
    ]);
  });
});

// How long something has waited, which is the quantity a person triages on.
// `now` is a parameter so this is a function of its inputs; a renderer
// reading the wall clock could not be asserted at all.
describe('the age a queue row states', () => {
  const now = new Date('2026-09-08T12:00:00.000Z');
  const ago = (ms: number): Date => new Date(now.getTime() - ms);

  const cases: readonly (readonly [string, Date, string])[] = [
    ['under a minute', ago(30_000), 'just now'],
    ['minutes', ago(9 * 60_000), '9m'],
    ['the last minute before an hour', ago(59 * 60_000), '59m'],
    ['exactly an hour', ago(3_600_000), '1h'],
    ['the last hour before a day', ago(23 * 3_600_000), '23h'],
    ['exactly a day', ago(86_400_000), '1d'],
    ['days', ago(9 * 86_400_000), '9d'],
  ];

  for (const [name, at, says] of cases) {
    it(`says ${says} for ${name}`, () => {
      expect(ageSays(at, now)).toBe(says);
    });
  }

  // Null is an unknown age, not a fresh one. `just now` on the run least is
  // known about is the most flattering answer available.
  it('says an unrecorded time is unrecorded, never now', () => {
    expect(ageSays(null, now)).toBe('age unrecorded');
  });

  // The driver reads an infinite timestamp as a number and an out-of-range
  // one as an invalid Date. Neither has an age, and neither may throw.
  it('says an unreadable time has an unreadable age', () => {
    expect(ageSays(new Date(Number.NaN), now)).toBe('age unreadable');
    expect(ageSays(Number.POSITIVE_INFINITY as unknown as Date, now)).toBe('age unreadable');
  });

  // Two machines' clocks, or a backdated history. Either way nothing has
  // waited a negative time, and a minus sign in a queue reads as a defect.
  it('refuses to report a negative age', () => {
    expect(ageSays(new Date(now.getTime() + 60_000), now)).toBe('not yet open');
  });
});

// Always UTC and always said so. The ledger stores UTC and the bands page
// judges a UTC day, so a console rendering local time would put two surfaces
// on different days for the same run.
describe('the timestamp a run list states', () => {
  it('states the instant in UTC, and marks it as UTC', () => {
    expect(whenSays(new Date('2026-09-07T09:05:00.000Z'))).toBe('2026-09-07 09:05Z');
  });

  it('says a time it does not have is not recorded', () => {
    expect(whenSays(null)).toBe('not recorded');
    // The driver answers infinity with a number and an out-of-range year
    // with an invalid Date. Neither can be printed, and neither may take the
    // page down with it.
    expect(whenSays(new Date(Number.NaN))).toBe('not a readable time');
    expect(whenSays(Number.POSITIVE_INFINITY as unknown as Date)).toBe('not a readable time');
  });
});

// Each input sits in a different case, so a version that folds two cases
// together gives a different answer for one of them.
describe('the share of a latency track a percentile fills', () => {
  it('draws no track for a percentile nobody measured', () => {
    expect(percentileShare(null, 1000)).toBeNull();
    expect(percentileShare(null, 0)).toBeNull();
  });

  it('draws an empty track, and no sliver, for a measured zero', () => {
    expect(percentileShare(0, 1000)).toBe(0);
  });

  it('draws a sliver for a value far below the widest', () => {
    // 1 of 1000 is 0.001, under the 0.02 floor.
    expect(percentileShare(1, 1000)).toBe(0.02);
  });

  it('draws its share of the widest otherwise', () => {
    expect(percentileShare(500, 1000)).toBe(0.5);
    expect(percentileShare(1000, 1000)).toBe(1);
  });

  // The caller's widest value is at least every measured one, so it never
  // passes this pair. The guard exists to keep a division by zero off the page.
  it('fills nothing when the maximum it is given is zero, rather than dividing by it', () => {
    expect(percentileShare(250, 0)).toBe(0);
  });
});
