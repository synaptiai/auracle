// A connection whose rollback failed goes back to the pool as broken.
//
// A save and a rewrite run under the run's row lock. When a statement fails
// and the ROLLBACK after it fails too, the connection is in a transaction
// state nobody read. Released as healthy, the pool hands it to the next
// caller, whose first statement runs inside that state. The undo already
// releases such a connection as broken; these cases hold the save and the
// rewrite to the same rule. A scripted client stands in for the database:
// the failure is the database's, and no ledger can be made to produce it on
// demand. Synthetic data only (DEC-18).
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import { rewriteReply } from './rewrite.js';
import { saveReply } from './save-reply.js';

const RUN = '4f1c2b8e-9d3a-4e77-b0d1-6a5c8e2f1b34';

/**
 * A pool whose one client fails the first statement after BEGIN, then fails
 * the ROLLBACK unless told otherwise, and records how it was released.
 */
function failingPool(rollbackFails = true): { pool: Pool; released: unknown[] } {
  const released: unknown[] = [];
  const client = {
    query: async (sql: string) => {
      if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
      if (sql === 'ROLLBACK') {
        if (rollbackFails) throw new Error('the connection dropped during the rollback');
        return { rows: [], rowCount: 0 };
      }
      throw new Error('the statement failed');
    },
    release: (error?: unknown) => {
      released.push(error);
    },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, released };
}

describe('a connection whose rollback failed', () => {
  it('is released as broken by a save', async () => {
    const { pool, released } = failingPool();

    await expect(saveReply(pool, RUN, 'A reply.')).rejects.toThrow(/the statement failed/);

    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });


  it('is released as broken by a rewrite', async () => {
    const { pool, released } = failingPool();

    await expect(
      rewriteReply(pool, RUN, 'A reply a person wrote.', { ledgerReply: true }),
    ).rejects.toThrow(/the statement failed/);

    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
  });
});

describe('a connection whose rollback succeeded', () => {
  it('is released healthy, by a save and by a rewrite', async () => {
    // A rolled-back connection is clean, and the pool keeps it. Releasing
    // every failure as broken would empty the pool on ordinary refusals.
    const { pool, released } = failingPool(false);

    await expect(saveReply(pool, RUN, 'A reply.')).rejects.toThrow(/the statement failed/);
    await expect(
      rewriteReply(pool, RUN, 'A reply a person wrote.', { ledgerReply: true }),
    ).rejects.toThrow(/the statement failed/);

    expect(released).toEqual([undefined, undefined]);
  });
});
