import { describe, expect, it } from 'vitest';

import { dbUrl, tryConnect } from './config.js';

describe('database smoke', () => {
  it('reaches the compose database and finds pgvector', async () => {
    const pool = await tryConnect();
    if (!pool) {
      console.warn(`skipping: no Postgres reachable at ${dbUrl()} (run docker compose up -d)`);
      return;
    }
    try {
      const one = await pool.query<{ ok: number }>('SELECT 1 AS ok');
      expect(one.rows[0]?.ok).toBe(1);

      const ext = await pool.query(
        "SELECT name FROM pg_available_extensions WHERE name = 'vector'",
      );
      expect(ext.rowCount).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
