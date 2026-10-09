// One pool teardown for every job that owns a pool.
//
// Three jobs carried a copy of this block. Only `bands` set the exit code on
// a failed close; `latency` and `seed-history` logged the failure and exited
// 0, which told a supervisor the run had succeeded. These cases pin the
// corrected behavior.
//
// A database suite, not a pure one: `src/db/config.ts` is on the purity
// guard's list of modules that open a connection, so no `*.test.ts` may
// import it. The happy path uses a real pool for that reason — it is the
// path an operator actually takes.
import { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeLedger, dbUrl, probeLedger } from './config.js';

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

/** A pool whose `end` rejects, which is the case the copies disagreed on. */
function poolThatWillNotClose(fault: unknown): Pool {
  return { end: () => Promise.reject(fault) } as unknown as Pool;
}

describe('closeLedger', () => {
  it('closes a real pool and leaves the exit code alone', async () => {
    process.exitCode = undefined;
    const pool = new Pool({ connectionString: dbUrl(), max: 1 });
    await pool.query('SELECT 1');
    await closeLedger(pool, 'a-test-job');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a failed close and sets the exit code', async () => {
    // The bug that was live in two of the three copies. Exiting 0 here is
    // the difference between a supervisor restarting the job and a
    // supervisor recording a success.
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;
    await closeLedger(poolThatWillNotClose(new Error('pool is already ended')), 'latency');
    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      'latency: the connection pool did not close cleanly: pool is already ended',
    );
  });

  it('names the job, so a supervisor log says which one', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await closeLedger(poolThatWillNotClose(new Error('broke')), 'seed-history');
    expect(stderr).toHaveBeenCalledWith(
      'seed-history: the connection pool did not close cleanly: broke',
    );
  });

  it('reads a refused connection through the AggregateError it arrives as', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await closeLedger(
      poolThatWillNotClose(
        new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:5433')], ''),
      ),
      'bands',
    );
    expect(stderr).toHaveBeenCalledWith(
      'bands: the connection pool did not close cleanly: connect ECONNREFUSED 127.0.0.1:5433',
    );
  });

  it('never rethrows, so a finally block cannot lose the fault that sent it there', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      closeLedger(poolThatWillNotClose(new Error('broke')), 'a-test-job'),
    ).resolves.toBeUndefined();
  });
});

describe('probeLedger', () => {
  it('names the process and the fault', async () => {
    const pool = {
      query: () => Promise.reject(new Error('database "nope" does not exist')),
    } as unknown as Pool;
    await expect(probeLedger(pool, 'the consumer')).rejects.toThrow(
      'the consumer cannot reach the ledger named by DATABASE_URL: database "nope" does not exist',
    );
  });

  it('reaches ECONNREFUSED inside the AggregateError a refusal arrives as', async () => {
    // The case that justifies the sweep. This function exists to report an
    // unreachable ledger, and a refused TCP connection is the likeliest way
    // for one to be unreachable — yet it arrived as an AggregateError whose
    // own message is empty, so the inline reading it used to carry appended
    // nothing at all. The operator was told the ledger was unreachable and
    // not one word about why.
    const refused = new AggregateError(
      [
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), {
          code: 'ECONNREFUSED',
        }),
      ],
      '',
    );
    // The reading the deleted copy took, shown producing nothing.
    expect(refused instanceof Error ? refused.message : String(refused)).toBe('');

    const pool = { query: () => Promise.reject(refused) } as unknown as Pool;
    await expect(probeLedger(pool, 'the relay')).rejects.toThrow(/ECONNREFUSED 127\.0\.0\.1:5433/);
  });

  it('resolves against a ledger it can reach', async () => {
    const pool = new Pool({ connectionString: dbUrl(), max: 1 });
    try {
      await expect(probeLedger(pool, 'a-test-job')).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});
