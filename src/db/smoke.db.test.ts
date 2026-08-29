import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { dbUrl } from './config.js';

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
