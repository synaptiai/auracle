// The one answer to "does the attempt a published document asked for start"
// (DEC-50, DEC-49). The consumer's scan acts on it and the case page draws it,
// so the two cannot disagree. Each expected value is the maintainer's ruling:
// the attempt starts only once the document is embedded; a failed embedding
// never starts it; a case approved, closed, snoozed or answered first drops
// it; and a new attempt needs no helpdesk copy a person could send.
import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import { RERUN_REASONS, rerunVerdict } from './rerun.js';
import type { RerunFacts } from './rerun.js';

const OPEN: RerunFacts = {
  hasTurn: true,
  runState: 'escalated',
  approved: false,
  runAttempt: 1,
  turnAttempt: 1,
  turnAnswered: false,
  snoozedSinceRequest: false,
  laterTurn: false,
  replyChanged: false,
  stale: false,
  copyCouldSend: false,
  documentStatus: 'embedded',
  siblingPending: false,
};

describe('the verdict on a re-run request', () => {
  it('starts once the document is embedded, on an escalated or a parked case', () => {
    expect(rerunVerdict(OPEN)).toEqual({ kind: 'start' });
    expect(rerunVerdict({ ...OPEN, runState: 'awaiting_approval' })).toEqual({ kind: 'start' });
  });

  it('waits while the document is pending, and fails when its embedding failed', () => {
    expect(rerunVerdict({ ...OPEN, documentStatus: 'pending' })).toEqual({ kind: 'waiting', on: 'document' });
    expect(rerunVerdict({ ...OPEN, documentStatus: 'failed' })).toEqual({ kind: 'failed' });
    // Another document from the same case still waits: the attempt waits for it.
    expect(rerunVerdict({ ...OPEN, siblingPending: true })).toEqual({ kind: 'waiting', on: 'document' });
  });

  it('drops a case that changed first, and names how', () => {
    const cases: Array<[Partial<RerunFacts>, string]> = [
      [{ runState: 'resolved', approved: true, turnAnswered: true }, 'approved'],
      // An automatic write resolved it, and nobody approved it.
      [{ runState: 'resolved', turnAnswered: true }, 'ended'],
      [{ runState: 'closed' }, 'closed'],
      [{ runState: 'snoozed' }, 'snoozed'],
      // Snoozed and back again before the embedding: still snoozed first.
      [{ runState: 'awaiting_approval', snoozedSinceRequest: true }, 'snoozed'],
      [{ turnAnswered: true }, 'answered'],
      [{ runState: 'superseded', turnAttempt: 2 }, 'another_attempt'],
      [{ turnAttempt: 2 }, 'another_attempt'],
      [{ runState: 'superseded' }, 'ended'],
      [{ runState: 'abandoned' }, 'ended'],
      [{ hasTurn: false, turnAttempt: null }, 'no_turn'],
      [{ runState: 'awaiting_approval', copyCouldSend: true }, 'copy_could_send'],
      [{ laterTurn: true }, 'newer_turn'],
      [{ runState: 'awaiting_approval', replyChanged: true }, 'reply_changed'],
    ];
    for (const [facts, reason] of cases) {
      expect(rerunVerdict({ ...OPEN, ...facts }), reason).toEqual({ kind: 'dropped', reason });
    }
  });

  it('drops a changed case even while its document is still pending or has failed', () => {
    // The case says it will not start as soon as the case changed, not once
    // the embedding ends.
    expect(rerunVerdict({ ...OPEN, runState: 'closed', documentStatus: 'pending' }))
      .toEqual({ kind: 'dropped', reason: 'closed' });
    expect(rerunVerdict({ ...OPEN, runState: 'closed', documentStatus: 'failed' }))
      .toEqual({ kind: 'dropped', reason: 'closed' });
  });
});

describe('a request on a run the system is still walking', () => {
  it('waits for the run to reach a person, and is not dropped', () => {
    for (const runState of ['received', 'classified', 'retrieved', 'composed', 'gated', 'executing']) {
      expect(rerunVerdict({ ...OPEN, runState }), runState).toEqual({ kind: 'waiting', on: 'case' });
      expect(rerunVerdict({ ...OPEN, runState, documentStatus: 'pending' }), runState)
        .toEqual({ kind: 'waiting', on: 'case' });
    }
  });
});

describe('a request on a run past its deadline, or with a failed document', () => {
  it('ends with a run that died on its walk, and fails whatever the run is doing', () => {
    expect(rerunVerdict({ ...OPEN, runState: 'composed', stale: true }))
      .toEqual({ kind: 'dropped', reason: 'ended' });
    expect(rerunVerdict({ ...OPEN, runState: 'composed', documentStatus: 'failed' })).toEqual({ kind: 'failed' });
  });
});

describe('the reasons a request records', () => {
  it('are the reasons the ledger accepts, and no others', () => {
    const migration = readFileSync(new URL('../../db/035_document_authoring.sql', import.meta.url), 'utf8');
    const check = /CONSTRAINT document_rerun_reason_check\s+CHECK \(reason IN \(([^)]*)\)\)/u.exec(migration);
    expect(check).not.toBeNull();
    const listed = [...check![1]!.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]);
    expect([...listed].sort()).toEqual([...RERUN_REASONS].sort());
  });
});
