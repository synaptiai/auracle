// The console's one write (issue #27, DEC-11, DEC-40).
//
// DEC-11 rejected "a Slack queue; a new web queue" by name, and section 4.2
// says adopters do not install a new interface. DEC-40 permits this console
// to approve while keeping the parking rule: the draft still lives in the
// helpdesk, and this is a second approval path, never a second parking path.
//
// So the console must not have an approval of its own. It calls `approveRun`,
// which is the function the command line calls, and it commits whatever that
// commits. Anything else would produce a different transaction and a
// different edit distance from the same operator action.
import { describe, expect, it, vi } from 'vitest';

// Real run ids, because a run id is a UUID the ledger minted and a toy string
// would not exercise the check that stands between a form post and the write.
const RUN_A = '4f1c2b8e-9d3a-4e77-b0d1-6a5c8e2f1b34';

// DEC-45: the identity the console resolved and checked against the roster.
const REVIEWER = 'synthetic-reviewer@example.test';
const RUN_B = '7a2d5c19-3e64-4b8f-9c02-1d7e4a6b3c85';
const RUN_C = '9e4b1f07-2c58-4d3a-8f61-0b2c7d5e9a13';

// DEC-46: the digest of the reply the page drew. Any 64 hex characters will
// do here — this suite proves the delegation, and the comparison against the
// ledger is the approval's own, prove in its database suite.
const SHOWN = 'a'.repeat(64);

import type { DraftReadBack } from 'auracle/ledger-read';

import {
  approvalFor, approveFromConsole, closeFor, rewriteFor, saveFor, saveFromConsole, snoozeFor, undoFor,
} from './approve.js';
import { ReadBackFailed } from './read-back.js';

describe('approving from the console', () => {
  it('delegates to approveRun and adds nothing of its own', async () => {
    const approveRun = vi.fn().mockResolvedValue({ outcome: 'approved' });
    const pool = { query: vi.fn() };

    const result = await approveFromConsole(
      { pool: pool as never, approveRun, ledgerReply: false },
      { runId: RUN_A, approvedBy: REVIEWER, shown: SHOWN },
    );

    expect(approveRun).toHaveBeenCalledTimes(1);
    // No options. A body passed here would be recorded as the approved reply
    // and never sent: the outbox payload for a draft-backed park is
    // `{ draftExternalId }`, and the relay sends that draft verbatim.
    expect(approveRun).toHaveBeenCalledWith(pool, RUN_A, {
      approvedBy: REVIEWER,
      approvedBySource: 'roster',
      shown: SHOWN,
    });
    expect(result.outcome).toBe('approved');
    // The console issues no statement of its own for the write. If it did,
    // the transaction would not be the one the command line commits.
    expect(pool.query).not.toHaveBeenCalled();
  });

  // Section 4.10. With a real adapter named, the approval reads the helpdesk
  // draft back and measures what a person edited there. The console passes the
  // adapter and nothing typed: the body comes from the helpdesk, which is the
  // copy the relay sends.
  it('reads the draft back through the adapter it was given', async () => {
    const approveRun = vi.fn().mockResolvedValue({ outcome: 'approved' });
    const readDraft: DraftReadBack = { readDraft: async () => ({ body: 'Hello.' }) };
    await approveFromConsole({ pool: {} as never, approveRun, ledgerReply: false, readDraft }, { runId: RUN_A, approvedBy: REVIEWER, shown: SHOWN });
    const options = approveRun.mock.calls[0]![2] as Record<string, unknown>;
    expect(options['readDraft']).toBe(readDraft);
    expect(Object.hasOwn(options, 'finalBody')).toBe(false);
  });

  it('passes the approver beside the read-back, and neither replaces the other', async () => {
    const approveRun = vi.fn().mockResolvedValue({ outcome: 'approved' });
    const readDraft: DraftReadBack = { readDraft: async () => null };
    await approveFromConsole(
      { pool: {} as never, approveRun, ledgerReply: false, readDraft },
      { runId: RUN_A, approvedBy: 'synthetic-reviewer', shown: SHOWN },
    );
    expect(approveRun).toHaveBeenCalledWith({}, RUN_A, {
      approvedBy: 'synthetic-reviewer',
      approvedBySource: 'roster',
      shown: SHOWN,
      readDraft,
    });
  });

  // A read that failed is not a missing draft. `approveRun` reads before its
  // transaction opens, so nothing committed, and the page must say the read
  // failed rather than that someone deleted the draft.
  it('reports a failed read-back as its own outcome, with the fault', async () => {
    const approveRun = vi.fn().mockRejectedValue(new ReadBackFailed('FreeScout answered 502'));
    const result = await approveFromConsole(
      { pool: {} as never, approveRun, ledgerReply: false, readDraft: { readDraft: async () => null } },
      { runId: RUN_A, approvedBy: REVIEWER, shown: SHOWN },
    );
    expect(result).toEqual({ outcome: 'read_back_failed', fault: 'read-back failed: FreeScout answered 502' });
  });

  // The page says the read failed and nothing more. The fault goes to the
  // log beside the run it stopped, and only for that outcome.
  it('hands a failed read-back to the log, with its run, and nothing else', async () => {
    const onReadBackFailed = vi.fn();
    const failing = vi.fn().mockRejectedValue(new ReadBackFailed('FreeScout answered 502'));
    await approveFromConsole(
      { pool: {} as never, approveRun: failing, ledgerReply: false, readDraft: { readDraft: async () => null }, onReadBackFailed },
      { runId: RUN_A, approvedBy: REVIEWER, shown: SHOWN },
    );
    expect(onReadBackFailed.mock.calls).toEqual([[RUN_A, 'read-back failed: FreeScout answered 502', null]]);
    const passing = vi.fn().mockResolvedValue({ outcome: 'draft_missing', draftExternalId: 'D' });
    await approveFromConsole({ pool: {} as never, approveRun: passing, ledgerReply: false, onReadBackFailed }, { runId: RUN_B, approvedBy: REVIEWER, shown: SHOWN });
    expect(onReadBackFailed).toHaveBeenCalledTimes(1);
  });

  // Every other fault stays a fault. Folding a ledger error into a read-back
  // sentence would send the operator to the helpdesk for a database problem.
  it('lets any other fault through, and logs no read-back failure for it', async () => {
    const approveRun = vi.fn().mockRejectedValue(new Error('connection terminated'));
    const onReadBackFailed = vi.fn();
    await expect(approveFromConsole(
      { pool: {} as never, approveRun, ledgerReply: false, readDraft: { readDraft: async () => null }, onReadBackFailed },
      { runId: RUN_A, approvedBy: REVIEWER, shown: SHOWN },
    )).rejects.toThrow('connection terminated');
    expect(onReadBackFailed).not.toHaveBeenCalled();
  });

  it('never passes approved text, so no distance is recorded from here', async () => {
    const approveRun = vi.fn().mockResolvedValue({ outcome: 'approved' });
    await approveFromConsole({ pool: {} as never, approveRun, ledgerReply: false }, { runId: RUN_C, approvedBy: REVIEWER, shown: SHOWN });
    const options = approveRun.mock.calls[0]![2] as Record<string, unknown>;
    expect(options).toEqual({ approvedBy: REVIEWER, approvedBySource: 'roster', shown: SHOWN });
    // Stated over the key rather than the value: `finalBody: undefined` would
    // satisfy a value check and still be a body the caller meant to pass.
    expect(Object.hasOwn(options, 'finalBody')).toBe(false);
  });

  // A run id arrives from a form post, so it is not trusted.
  //
  // The last four values are the ones that matter, and an earlier pattern
  // (`/^[0-9a-fA-F-]{6,64}$/`) accepted every one of them. `run_id` is a
  // `uuid` column, so an id that is merely hex-and-hyphen-shaped still makes
  // Postgres raise rather than match nothing: the refusal has to be UUID
  // shape, not character class. The first four fail either pattern and are
  // kept because they are what a form actually posts.
  it('refuses a run id that is not a run id', async () => {
    const approveRun = vi.fn();
    for (const bad of [
      '', '   ', 'r-1; DELETE FROM run', 'x'.repeat(200),
      '------', 'abcdef', 'deadbeefcafe', '4f1c2b8e-9d3a-4e77-b0d1-6a5c8e2f1b3',
    ]) {
      await expect(
        approveFromConsole({ pool: {} as never, approveRun, ledgerReply: false }, { runId: bad, approvedBy: REVIEWER, shown: SHOWN }),
      ).rejects.toThrow(/run id/);
    }
    expect(approveRun).not.toHaveBeenCalled();
  });
});

// The console's second write (DEC-44), and the glue the case page reaches it
// through. Both were untested: `/edit` is proved against a fake `saveReply`,
// and `src/approval/save-reply.db.test.ts` proves the core — so nothing
// failed if `shown` stopped being forwarded, which silently disables the
// DEC-46 guard on every console save.
// DEC-48: the close, and the glue the case page reaches it through. The route
// is proved against a fake `deps.close`, and `src/outcomes/close.db.test.ts`
// proves the core — so without this nothing fails if the digest stops being
// forwarded, which silently disables the DEC-46 guard on every console close,
// or if the adapter's declaration stops travelling, which decides which text
// the guard compares (DEC-44).
describe('closing from the console', () => {
  it('delegates to closeRun with the reason, the reviewer and the digest', async () => {
    const closeRun = vi.fn().mockResolvedValue({ outcome: 'closed' });
    const pool = { query: vi.fn() };

    const close = closeFor({ pool: pool as never, closeRun, ledgerReply: true });
    const outcome = await close(RUN_B, REVIEWER, 'Duplicate of T-4471.', SHOWN);

    expect(outcome).toBe('closed');
    expect(closeRun).toHaveBeenCalledWith(pool, RUN_B, {
      reason: 'Duplicate of T-4471.',
      closedBy: REVIEWER,
      closedBySource: 'roster',
      ledgerReply: true,
      shown: SHOWN,
    });
    // The digest is the whole of DEC-46 on this path, and the adapter's
    // declaration is what decides which text it is compared against.
    const options = closeRun.mock.calls[0]![2] as Record<string, unknown>;
    expect(Object.hasOwn(options, 'shown')).toBe(true);
    expect(Object.hasOwn(options, 'ledgerReply')).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('carries the draft path through, so the guard compares what the page drew', async () => {
    const closeRun = vi.fn().mockResolvedValue({ outcome: 'closed' });
    const close = closeFor({ pool: {} as never, closeRun, ledgerReply: false });

    await close(RUN_C, REVIEWER, 'Settled by telephone.', SHOWN);

    expect((closeRun.mock.calls[0]![2] as Record<string, unknown>)['ledgerReply']).toBe(false);
  });

  it('refuses a run id that is not a run id, and closes nothing', async () => {
    const closeRun = vi.fn();
    const close = closeFor({ pool: {} as never, closeRun, ledgerReply: false });

    await expect(close('not-a-run', REVIEWER, 'Duplicate.', SHOWN)).rejects.toThrow(/run id/);
    expect(closeRun).not.toHaveBeenCalled();
  });
});

// DEC-48: the rewrite and the snooze, each with the same glue. Without these
// a dropped `ledgerReply` makes every console rewrite refuse `not_ledger_reply`
// and every snooze refuse for the draft path, with the whole suite green: the
// route is proved against a fake and the core in its own suite, so nothing
// else fails when the declaration stops travelling.
describe('rewriting from the console', () => {
  it('delegates to rewriteReply with the text, the reviewer and the digest', async () => {
    const rewriteReply = vi.fn().mockResolvedValue({ outcome: 'rewritten' });
    const pool = { query: vi.fn() };

    const rewrite = rewriteFor({ pool: pool as never, rewriteReply, ledgerReply: true });
    const outcome = await rewrite(RUN_B, REVIEWER, 'Call the service desk.', SHOWN);

    expect(outcome).toBe('rewritten');
    expect(rewriteReply).toHaveBeenCalledWith(pool, RUN_B, 'Call the service desk.', {
      rewrittenBy: REVIEWER,
      rewrittenBySource: 'roster',
      ledgerReply: true,
      shown: SHOWN,
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('carries the draft path through, so the write refuses rather than records', async () => {
    const rewriteReply = vi.fn().mockResolvedValue({ outcome: 'not_ledger_reply' });
    const rewrite = rewriteFor({ pool: {} as never, rewriteReply, ledgerReply: false });

    expect(await rewrite(RUN_C, REVIEWER, 'Call the service desk.', SHOWN)).toBe('not_ledger_reply');
    expect((rewriteReply.mock.calls[0]![3] as Record<string, unknown>)['ledgerReply']).toBe(false);
  });

  it('refuses a run id that is not a run id, and writes nothing', async () => {
    const rewriteReply = vi.fn();
    const rewrite = rewriteFor({ pool: {} as never, rewriteReply, ledgerReply: true });

    await expect(rewrite('not-a-run', REVIEWER, 'Call the service desk.', SHOWN))
      .rejects.toThrow(/run id/);
    expect(rewriteReply).not.toHaveBeenCalled();
  });
});

describe('putting a case aside from the console', () => {
  it('delegates to snoozeRun with the period, the reviewer and the digest', async () => {
    const snoozeRun = vi.fn().mockResolvedValue({ outcome: 'snoozed' });
    const pool = { query: vi.fn() };

    const snooze = snoozeFor({ pool: pool as never, snoozeRun, ledgerReply: true });
    expect(await snooze(RUN_B, REVIEWER, 90 * 60_000, SHOWN)).toBe('snoozed');

    expect(snoozeRun).toHaveBeenCalledWith(pool, RUN_B, {
      periodMs: 90 * 60_000,
      snoozedBy: REVIEWER,
      snoozedBySource: 'roster',
      ledgerReply: true,
      shown: SHOWN,
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('refuses a run id that is not a run id, and puts nothing aside', async () => {
    const snoozeRun = vi.fn();
    const snooze = snoozeFor({ pool: {} as never, snoozeRun, ledgerReply: true });

    await expect(snooze('not-a-run', REVIEWER, 60_000, SHOWN)).rejects.toThrow(/run id/);
    expect(snoozeRun).not.toHaveBeenCalled();
  });
});

describe('saving from the console', () => {
  it('delegates to saveReply with the digest the page drew', async () => {
    const saveReply = vi.fn().mockResolvedValue({ outcome: 'saved' });
    const pool = { query: vi.fn() };

    const result = await saveFromConsole(
      { pool: pool as never, saveReply },
      { runId: RUN_A, text: 'A reply a person wrote.', shown: SHOWN, reviewer: REVIEWER },
    );

    expect(result.outcome).toBe('saved');
    // The reviewer the console resolved against the roster is the saver
    // (DEC-45), as it is the approver of an approval.
    expect(saveReply).toHaveBeenCalledWith(pool, RUN_A, 'A reply a person wrote.', {
      shown: SHOWN,
      savedBy: REVIEWER,
      savedBySource: 'roster',
    });
    // The digest is the whole of DEC-46 on this path: a save without one is a
    // save of text the reviewer may never have read.
    expect(Object.hasOwn(saveReply.mock.calls[0]![3] as object, 'shown')).toBe(true);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('refuses a run id that is not a run id, and saves nothing', async () => {
    const saveReply = vi.fn();
    await expect(
      saveFromConsole(
        { pool: {} as never, saveReply },
        { runId: 'not-a-run', text: 'x', shown: SHOWN, reviewer: REVIEWER },
      ),
    ).rejects.toThrow(/run id/);
    expect(saveReply).not.toHaveBeenCalled();
  });

  it('answers the outcome alone, through the function the entry point hands the server', async () => {
    const saveReply = vi.fn().mockResolvedValue({ outcome: 'shown_changed' });
    const save = saveFor({ pool: {} as never, saveReply });

    await expect(save(RUN_B, 'A reply.', SHOWN, REVIEWER)).resolves.toBe('shown_changed');
    expect(saveReply).toHaveBeenCalledWith({}, RUN_B, 'A reply.', {
      shown: SHOWN,
      savedBy: REVIEWER,
      savedBySource: 'roster',
    });
  });
});

describe('undoing from the console', () => {
  it('records the reviewer as one the roster resolved (DEC-45)', async () => {
    const undoApproval = vi.fn().mockResolvedValue({ outcome: 'undone' });
    const undo = undoFor({ pool: {} as never, undoApproval });

    await expect(undo(RUN_A, REVIEWER)).resolves.toEqual({ outcome: 'undone' });
    expect(undoApproval).toHaveBeenCalledWith({}, RUN_A, { reviewer: REVIEWER, reviewerSource: 'roster' });
  });
});

describe('approvalFor', () => {
  // What the console's entry point hands the server. A failed read-back is
  // logged with its run and draft, and the server gets the outcome alone.
  it('logs a failed read-back with its run and draft, and answers the outcome', async () => {
    const records: Record<string, unknown>[] = [];
    const readDraft = { readDraft: async () => null };
    const approveRun = vi.fn().mockRejectedValue(new ReadBackFailed('refused', { draftExternalId: '4:12' }));
    const approve = approvalFor({
      pool: {} as never, approveRun, ledgerReply: false, readBack: { name: 'freescout', readDraft, supportsLedgerReply: false }, sendHoldMs: 12_000, log: (record) => { records.push(record); },
    });
    await expect(approve(RUN_A, 'Synthetic Reviewer', SHOWN)).resolves.toBe('read_back_failed');
    expect(approveRun).toHaveBeenCalledWith({}, RUN_A, {
      approvedBy: 'Synthetic Reviewer',
      approvedBySource: 'roster',
      shown: SHOWN,
      // DEC-51: the hold this console carries travels with every approval it
      // makes, so a batch can be undone inside it.
      sendHoldMs: 12_000,
      readDraft,
    });
    expect(records).toEqual([
      { event: 'console_read_back_failed', runId: RUN_A, draftExternalId: '4:12', fault: 'read-back failed: refused' },
    ]);
  });

  // DEC-44: the reviewer's decision about a helpdesk copy a person edited.
  // It travels only when the page sent one, and it is a digest rather than a
  // flag, so a copy that moved since refuses instead of being sent past on a
  // stale decision.
  it('carries an acknowledgement only when the page sent one', async () => {
    const approveRun = vi.fn().mockResolvedValue({ outcome: 'approved', idemKey: 'k' });
    const approve = approvalFor({
      pool: {} as never, approveRun, ledgerReply: true, readBack: null, sendHoldMs: 12_000,
      log: () => undefined,
    });
    const ack = 'b'.repeat(64);

    await approve(RUN_A, REVIEWER, SHOWN, ack);
    expect(approveRun.mock.calls[0]![2]).toMatchObject({ copyAcknowledged: ack });

    await approve(RUN_B, REVIEWER, SHOWN);
    expect(Object.hasOwn(approveRun.mock.calls[1]![2] as object, 'copyAcknowledged')).toBe(false);
  });

  // A read-back fault a retry cannot clear is its own answer (DEC-30). The
  // operator is sent to the configuration, not to the connection.
  it('answers a permanent read-back fault with its own outcome', async () => {
    const approveRun = vi.fn().mockRejectedValue(new ReadBackFailed('the thread is not a note', {
      permanent: true,
    }));
    const approve = approvalFor({
      pool: {} as never, approveRun, ledgerReply: true, readBack: null, sendHoldMs: 12_000, log: () => undefined,
    });

    await expect(approve(RUN_A, REVIEWER, SHOWN)).resolves.toBe('read_back_not_a_note');
  });

  // DEC-51: the hold reaches the approval, or no send would be held and the
  // undo button would promise a window nothing kept. The suite's other cases
  // stub the approval's answer, so without this one the wiring could vanish.
  it('passes the hold the console read, and no hold when it read none', async () => {
    const approveRun = vi.fn().mockResolvedValue({ outcome: 'approved', idemKey: 'k' });
    const withHold = approvalFor({
      pool: {} as never, approveRun, ledgerReply: true, readBack: null, sendHoldMs: 12_000,
      log: () => undefined,
    });
    await withHold(RUN_A, REVIEWER, SHOWN);
    expect(approveRun.mock.calls[0]![2]).toMatchObject({ sendHoldMs: 12_000 });

    const withoutHold = approvalFor({
      pool: {} as never, approveRun, ledgerReply: true, readBack: null, sendHoldMs: 0,
      log: () => undefined,
    });
    await withoutHold(RUN_B, REVIEWER, SHOWN);
    // Zero is a decision, not an absence: it travels, so the core holds
    // nothing and the page draws no undo.
    expect(approveRun.mock.calls[1]![2]).toMatchObject({ sendHoldMs: 0 });
  });

  it('passes no read-back when the console reads none, and logs nothing on an approval', async () => {
    const records: Record<string, unknown>[] = [];
    const approveRun = vi.fn().mockResolvedValue({ outcome: 'approved', idemKey: 'k' });
    const approve = approvalFor({ pool: {} as never, approveRun, ledgerReply: false, readBack: null, sendHoldMs: 12_000, log: (record) => { records.push(record); } });
    await expect(approve(RUN_B, REVIEWER, SHOWN)).resolves.toBe('approved');
    expect(approveRun).toHaveBeenCalledWith({}, RUN_B, {
      approvedBy: REVIEWER,
      approvedBySource: 'roster',
      shown: SHOWN,
      sendHoldMs: 12_000,
    });
    expect(records).toEqual([]);
  });
});
