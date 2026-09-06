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
const RUN_B = '7a2d5c19-3e64-4b8f-9c02-1d7e4a6b3c85';
const RUN_C = '9e4b1f07-2c58-4d3a-8f61-0b2c7d5e9a13';

import { approveFromConsole } from './approve.js';

describe('approving from the console', () => {
  it('delegates to approveRun and adds nothing of its own', async () => {
    const approveRun = vi.fn().mockResolvedValue({ outcome: 'approved' });
    const pool = { query: vi.fn() };

    const result = await approveFromConsole(
      { pool: pool as never, approveRun },
      { runId: RUN_A },
    );

    expect(approveRun).toHaveBeenCalledTimes(1);
    // No options. A body passed here would be recorded as the approved reply
    // and never sent: the outbox payload for a draft-backed park is
    // `{ draftExternalId }`, and the relay sends that draft verbatim.
    expect(approveRun).toHaveBeenCalledWith(pool, RUN_A, {});
    expect(result.outcome).toBe('approved');
    // The console issues no statement of its own for the write. If it did,
    // the transaction would not be the one the command line commits.
    expect(pool.query).not.toHaveBeenCalled();
  });

  // The CLI reports `draft_missing` when the parked draft is gone, and so
  // must this. A console that approved anyway would send a reply no person
  // had read.
  it('reports a missing draft, exactly as the command line does', async () => {
    const approveRun = vi.fn().mockResolvedValue({ outcome: 'draft_missing' });
    const result = await approveFromConsole(
      { pool: {} as never, approveRun },
      { runId: RUN_B },
    );
    expect(result.outcome).toBe('draft_missing');
  });

  it('never passes approved text, so no distance is recorded from here', async () => {
    const approveRun = vi.fn().mockResolvedValue({ outcome: 'approved' });
    await approveFromConsole({ pool: {} as never, approveRun }, { runId: RUN_C });
    const options = approveRun.mock.calls[0]![2] as Record<string, unknown>;
    expect(options).toEqual({});
    // Stated over the key rather than the value: `finalBody: undefined` would
    // satisfy a value check and still be a body the caller meant to pass.
    expect(Object.hasOwn(options, 'finalBody')).toBe(false);
  });

  // The reason there is no text box, held as a rule rather than as a habit.
  // `ApproveRequest` has one field; a second one would be a body reaching
  // `approveRun`, which records it and never sends it.
  it('takes a run id and nothing else', async () => {
    const approveRun = vi.fn().mockResolvedValue({ outcome: 'approved' });
    const request = { runId: RUN_C };
    await approveFromConsole({ pool: {} as never, approveRun }, request);
    expect(Object.keys(request)).toEqual(['runId']);
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
        approveFromConsole({ pool: {} as never, approveRun }, { runId: bad }),
      ).rejects.toThrow(/run id/);
    }
    expect(approveRun).not.toHaveBeenCalled();
  });
});
