import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { dbUrl, probeLedger } from './config.js';

// This suite used to call tryConnect and return early when it got null, so
// an unreachable database made it pass having asserted nothing. The global
// setup now guarantees a reachable one, so the connection is part of what
// this smoke test proves.
const pool = new Pool({ connectionString: dbUrl(), max: 1 });

afterAll(async () => {
  await pool.end();
});

describe('database smoke', () => {
  it('reaches the compose database and finds pgvector', async () => {
    const one = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(one.rows[0]?.ok).toBe(1);

    const ext = await pool.query(
      "SELECT name FROM pg_available_extensions WHERE name = 'vector'",
    );
    expect(ext.rowCount).toBe(1);
  });
});

// A pool connects lazily, so a process with a wrong URL starts cleanly and
// fails one request at a time while reporting itself healthy. The probe is
// what turns that into a refusal at startup, and the operator console calls
// it because it may name no SQL of its own.
describe('the ledger probe', () => {
  it('returns for a database it can reach', async () => {
    await expect(probeLedger(pool, 'the smoke test')).resolves.toBeUndefined();
  });

  it('names the process and the variable when it cannot connect', async () => {
    // A port nothing listens on, so the failure is the connection itself
    // rather than a credential or a missing database.
    const wrong = new Pool({
      connectionString: 'postgres://nobody:nobody@127.0.0.1:1/none',
      max: 1,
      connectionTimeoutMillis: 2000,
    });
    // The pool would otherwise rethrow the same failure as an 'error' event.
    wrong.on('error', () => {});
    try {
      await expect(probeLedger(wrong, 'the operator console')).rejects.toThrow(
        /the operator console cannot reach the ledger named by DATABASE_URL/,
      );
    } finally {
      await wrong.end();
    }
  });
});
