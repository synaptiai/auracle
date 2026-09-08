// What a journal step says on the run detail page (issue #27).
//
// These ran through `main.ts` until now, which runs `main()` on import, so
// nothing asserted them. The park branch is why that mattered.
import { describe, expect, it } from 'vitest';

import { latencyCaveats, stepSays, toDetail, toRow } from './views.js';
import type { JournalStep, RunJournal } from 'auracle/dist/journal/query.js';

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
    reason: null, costMicros: 1234, stepsUsed: 6,
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

  it('leaves a reason from the closed vocabulary whole', () => {
    expect(toRow({ ...item, reason: 'policy_escalated' }).reason).toBe('policy_escalated');
  });

  it('carries the parked draft id onto a detail, and a null when none parked', () => {
    expect(toDetail({ ...item, draftExternalId: 'hd-99' }).draftExternalId).toBe('hd-99');
    expect(toDetail({ ...item, draftExternalId: null }).draftExternalId).toBeNull();
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
