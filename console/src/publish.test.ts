// The publish the console hands its server (DEC-50).
//
// A delegation: `publishDocument` owns every rule, and its database suite
// proves them. This proves the console adds nothing of its own, passes the
// author the gate resolved, and carries the catalogue and the adapter's
// declaration as they were given.
import { describe, expect, it, vi } from 'vitest';

import { publishFor } from './publish.js';

const RUN = '4f1c2b8e-9d3a-4e77-b0d1-6a5c8e2f1b34';
const REVIEWER = 'synthetic-reviewer@example.test';
const SHOWN = 'a'.repeat(64);
const FIELDS = {
  title: 'Pausing a plan', body: 'A plan may be paused once a year.', owner: 'kb-team',
  reviewBy: '2999-01-01', products: ['aurora'],
};

describe('publishing from the console', () => {
  it('delegates to publishDocument with the author, the catalogue and the declaration', async () => {
    const answer = { outcome: 'published', docId: 'console-x', rerun: { status: 'waiting' } } as const;
    const publishDocument = vi.fn().mockResolvedValue(answer);
    const pool = { query: vi.fn() };
    const publish = publishFor({ pool: pool as never, publishDocument, catalogue: ['aurora', 'ledger'], ledgerReply: true });

    expect(await publish(` ${RUN} `, REVIEWER, FIELDS, SHOWN)).toBe(answer);
    expect(publishDocument).toHaveBeenCalledWith(pool, {
      runId: RUN, ...FIELDS, writtenBy: REVIEWER, catalogue: ['aurora', 'ledger'], shown: SHOWN, ledgerReply: true,
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('refuses a run id that is not a run id, and publishes nothing', async () => {
    const publishDocument = vi.fn();
    const publish = publishFor({ pool: {} as never, publishDocument, catalogue: [], ledgerReply: false });
    await expect(publish('not-a-run', REVIEWER, FIELDS, SHOWN)).rejects.toThrow(/run id/);
    expect(publishDocument).not.toHaveBeenCalled();
  });
});
