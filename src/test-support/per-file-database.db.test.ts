// Each test file gets a database of its own (issue #68).
//
// That is what lets the db project run its files in parallel. The suites
// truncate tables between cases, so two files sharing a database corrupt each
// other's results. Running the files at once without the clone would produce
// an order-dependent flake rather than an honest failure.
//
// The flake is the thing worth guarding against, because it passes. A run
// that happens to interleave harmlessly is indistinguishable from isolation
// until the day it is not, so this asserts the mechanism rather than trusting
// a green run to prove it.
import { Pool } from 'pg';
import { afterAll, describe, expect, inject, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { readIsolation } from './isolation-registry.js';
import { CLONE_PREFIX, TEMPLATE_PREFIX, databaseOf } from './template-db.js';
import { truncateLedger } from './schema.js';

const pool = new Pool({ connectionString: dbUrl(), max: 1 });

afterAll(async () => {
  await pool.end();
});

describe('the database this file was given', () => {
  it('is a clone, and not the server default or the template', () => {
    const name = databaseOf(dbUrl());
    expect(name.startsWith(CLONE_PREFIX)).toBe(true);
    expect(name.startsWith(TEMPLATE_PREFIX)).toBe(false);
    // The admin database the global setup provides. A suite that reached it
    // would share one database with every other file, which is the state this
    // issue removed.
    expect(name).not.toBe('auracle');
  });

  it('arrives already migrated, so no hook has to apply the schema', async () => {
    // Every clone copies a template that `migrate()` walked, so the schema is
    // present before the first case and `applyLedgerSchema` is gone from every
    // beforeEach.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(5);

    // Through the real migrator, so the version ledger is populated. Applying
    // the files directly would leave this empty.
    const versions = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_version',
    );
    expect(Number(versions.rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it('is recorded, so the run can check the whole set', () => {
    // This case used to truncate and then assert the row count was zero,
    // which is true by construction however many files share the database.
    // Adversarial review pointed every file at one clone and this file stayed
    // green while a DEC-28 case broke next door.
    //
    // A file cannot see whether another file shares its database. So each
    // file records the one it was given, and the run's teardown asserts the
    // set: one database per file, all distinct. That assertion lives in
    // src/test-support/isolation-registry.ts and runs after every file.
    const report = readIsolation(inject('dbRunId'));
    const mine = databaseOf(dbUrl());
    expect(mine.startsWith(CLONE_PREFIX)).toBe(true);
    // At least this file's own handout is recorded by the time it runs.
    expect(report.handouts).toBeGreaterThan(0);
    // Whatever has been recorded so far, no database may serve two files.
    // The whole set is asserted in the run's teardown, which is the only
    // point that sees every file.
    expect(report.shared).toEqual([]);
  });
});

describe('truncateLedger', () => {
  it('clears every table the schema holds, not a list someone wrote down', async () => {
    // The list came from `information_schema` at call time, so a table added
    // by a migration is cleared from the moment it exists. Forty-nine
    // hand-written TRUNCATE statements in ten different table lists preceded
    // this, fourteen of which omitted `intake`.
    // `intake` is the table fourteen of those lists forgot, so it is the one
    // worth asserting. Migration 009 added a NOT NULL message_id after the
    // table was first written, which is exactly how a hand-written list goes
    // stale.
    await pool.query(
      `INSERT INTO intake (ticket_id, partition, ticket_text, message_id)
       VALUES ('probe-1', 0, 'a synthetic ticket', 'probe-message-1')`,
    );
    const before = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM intake');
    expect(before.rows[0]?.count).toBe('1');

    await truncateLedger(pool);

    const after = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM intake');
    expect(after.rows[0]?.count).toBe('0');
  });

  it('leaves schema_version alone', async () => {
    // Clearing it would tell the next migrate() that nothing had been applied.
    await truncateLedger(pool);
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM schema_version',
    );
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });
});
