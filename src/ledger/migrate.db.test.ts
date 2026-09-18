// Integration suite for the V2 migration runner (src/ledger/migrate.ts).
// Each case runs against an isolated Postgres schema, so the runner's
// schema_version table and the migration DDL never leak between cases.
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { discoverMigrations, migrate } from './migrate.js';

let pool: Pool;
// A real PoolClient, so the single-connection type path migrate() requires
// is exercised exactly as adopters will drive it.
let client: PoolClient;

beforeAll(async () => {
  pool = new Pool({ connectionString: dbUrl(), max: 2 });
  client = await pool.connect();
});

afterAll(async () => {
  client.release();
  await pool.end();
});

beforeEach(async () => {
  // Fresh isolated schema per case; the session keeps the search_path.
  await client.query('DROP SCHEMA IF EXISTS migrate_test CASCADE');
  await client.query('CREATE SCHEMA migrate_test');
  await client.query('SET search_path TO migrate_test, public');
});

afterEach(async () => {
  await client.query('RESET search_path');
});

/** One run row, so an outbox insert has something to point at. */
async function seedRun(): Promise<string> {
  const { rows } = await client.query<{ run_id: string }>(
    `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver,
                      model_ver, deadline_at)
     VALUES (gen_random_uuid(), 'T-1', 0, 1, 'received', 'p', 'm', now())
     RETURNING run_id`,
  );
  return rows[0]!.run_id;
}

describe('migrate', () => {
  it('applies every pending db/*.sql once, then skips them as no-ops', async () => {
    const first = await migrate(client);
    const filenames = first.applied.map((f) => f.filename);
    expect(filenames.length).toBeGreaterThan(0);
    expect(filenames.some((name) => name.startsWith('001_'))).toBe(true);

    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_version ORDER BY version',
    );
    expect(rows.map((row) => row.filename)).toEqual(filenames);

    const second = await migrate(client);
    expect(second.applied).toEqual([]);
    expect(second.skipped.map((f) => f.filename)).toEqual(filenames);
  });

  it('installs the ledger constraints the code relies on (db/006)', async () => {
    await migrate(client);

    // DEC-28: claimPartition looks a ticket up in run by (ticket_id,
    // partition). The v1 schema indexed only (partition, state).
    const idx = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'migrate_test' AND tablename = 'run'`,
    );
    expect(idx.rows.map((r) => r.indexname)).toContain('run_ticket_idx');

    // DEC-26: every step records its pins. A step that recorded none left
    // the ledger unable to say which prompt produced it.
    await expect(
      client.query(
        `INSERT INTO step_journal (run_id, step_id, status, prompt_ver, model_ver, cost_micros)
         VALUES (gen_random_uuid(), 's', 'started', NULL, 'm', 0)`,
      ),
    ).rejects.toThrow();

    // `result` stays nullable: a step is journaled before it acts, so it has
    // no outcome yet (section 4.2).
    await expect(
      client.query(
        `INSERT INTO step_journal (run_id, step_id, status, prompt_ver, model_ver, cost_micros)
         VALUES (gen_random_uuid(), 's2', 'started', 'p', 'm', 0)`,
      ),
    ).resolves.toBeDefined();

    // A status outside the closed set is invisible to both the relay scan
    // and the escalations query, so the record would strand unseen.
    const runId = await seedRun();
    await expect(
      client.query(
        `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class,
                             delivery, payload, status)
         VALUES ($1, 'x', 'k-bad', 1, 'a', 'at_most_once', '{}'::jsonb, 'typoed')`,
        [runId],
      ),
    ).rejects.toThrow(/outbox_status_check/);

    // Every status the code actually writes is accepted.
    for (const status of ['pending', 'sent', 'fenced', 'delivery_unknown', 'malformed']) {
      await expect(
        client.query(
          `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class,
                               delivery, payload, status)
           VALUES ($1, $2, $3, 1, 'a', 'at_most_once', '{}'::jsonb, $4)`,
          [runId, `s-${status}`, `k-${status}`, status],
        ),
      ).resolves.toBeDefined();
    }
  });

  it('installs the reviewer roster and the approver provenance (db/018, DEC-45)', async () => {
    await migrate(client);

    // DEC-45: the roster decides who may review in the console. An identity
    // is one row, active until a maintainer deactivates it.
    await client.query("INSERT INTO reviewer (identity) VALUES ('anna@example.test')");
    const added = await client.query(
      'SELECT active, added_at, deactivated_at FROM reviewer WHERE identity = $1',
      ['anna@example.test'],
    );
    expect(added.rows[0]).toMatchObject({ active: true, deactivated_at: null });
    expect(added.rows[0]!.added_at).toBeInstanceOf(Date);
    // One identity, one row: adding the same one twice is a conflict.
    await expect(
      client.query("INSERT INTO reviewer (identity) VALUES ('anna@example.test')"),
    ).rejects.toThrow(/reviewer_pkey/);

    // The provenance pair: the name and its source are set together or not
    // at all, and the source is one of the three DEC-45 names.
    const named = await seedRun();
    await client.query(
      "UPDATE run SET approved_by = 'anna@example.test', approved_by_source = 'roster' WHERE run_id = $1",
      [named],
    );
    await expect(
      client.query(
        "UPDATE run SET approved_by = 'anna@example.test', approved_by_source = 'elsewhere' WHERE run_id = $1",
        [named],
      ),
    ).rejects.toThrow(/approved_by_source_check/);
    await expect(
      client.query(
        "UPDATE run SET approved_by = NULL, approved_by_source = 'roster' WHERE run_id = $1",
        [named],
      ),
    ).rejects.toThrow(/approved_by_source_check/);
    await expect(
      client.query(
        "UPDATE run SET approved_by = 'x@example.test', approved_by_source = NULL WHERE run_id = $1",
        [named],
      ),
    ).rejects.toThrow(/approved_by_source_check/);

    // A name and a source that disagree are refused in both directions.
    // `none` says nobody was named, so a name beside it is a row no reader
    // can classify; and `unattributed` is how nobody reads in the name
    // column, so `roster` beside it claims a check that named no one.
    await expect(
      client.query(
        "UPDATE run SET approved_by = 'anna@example.test', approved_by_source = 'none' WHERE run_id = $1",
        [named],
      ),
    ).rejects.toThrow(/approved_by_source_check/);
    await expect(
      client.query(
        "UPDATE run SET approved_by = 'unattributed', approved_by_source = 'roster' WHERE run_id = $1",
        [named],
      ),
    ).rejects.toThrow(/approved_by_source_check/);
    // And the pair that agrees is accepted, in both readings.
    await client.query(
      "UPDATE run SET approved_by = 'unattributed', approved_by_source = 'none' WHERE run_id = $1",
      [named],
    );
    const named2 = await seedRun();
    await client.query(
      "UPDATE run SET approved_by = 'anna@example.test', approved_by_source = 'header' WHERE run_id = $1",
      [named2],
    );
  });

  // The one statement in db/018 that touches rows it did not create. It runs
  // on an adopter's ledger, which holds approvals written before the column
  // existed, and nothing else in this repository feeds it that input: every
  // other case migrates first and writes afterwards.
  it('backfills the source of an approval recorded before db/018', async () => {
    // Every migration but 018, as an adopter's ledger would be.
    const before = await copyMigrationsExcept(18);
    try {
      await migrate(client, before);
      const named = await seedRun();
      const nobody = await seedRun();
      await client.query("UPDATE run SET approved_by = 'anna@example.test' WHERE run_id = $1", [named]);
      await client.query("UPDATE run SET approved_by = 'unattributed' WHERE run_id = $1", [nobody]);
      // A run no approval reached carries neither, and stays that way.
      const untouched = await seedRun();

      await migrate(client);
      const { rows } = await client.query<{ run_id: string; approved_by: string | null; approved_by_source: string | null }>(
        'SELECT run_id, approved_by, approved_by_source FROM run',
      );
      const byRun = new Map(rows.map((row) => [row.run_id, row]));
      // A name a caller supplied was a claim, and by the same header the
      // console read it through: DEC-42's rule, which is the only one that
      // could have produced it.
      expect(byRun.get(named)).toMatchObject({
        approved_by: 'anna@example.test',
        approved_by_source: 'header',
      });
      // `unattributed` is the name column's way of recording nobody.
      expect(byRun.get(nobody)).toMatchObject({
        approved_by: 'unattributed',
        approved_by_source: 'none',
      });
      expect(byRun.get(untouched)).toMatchObject({ approved_by: null, approved_by_source: null });
    } finally {
      await rm(before, { recursive: true, force: true });
    }
  });

  it('installs the conversation ledger entities (db/008, DEC-35)', async () => {
    await migrate(client);

    // A conversation groups turns; a turn records which thread carried it.
    const conversationId = (
      await client.query<{ conversation_id: string }>(
        `INSERT INTO conversation (conversation_id, primary_ticket_id)
         VALUES (gen_random_uuid(), 'T-1') RETURNING conversation_id`,
      )
    ).rows[0]!.conversation_id;

    // turn_counter starts at 1: the next turn to assign.
    const opened = await client.query<{ turn_counter: number; state: string }>(
      'SELECT turn_counter, state FROM conversation WHERE conversation_id = $1',
      [conversationId],
    );
    expect(opened.rows[0]).toMatchObject({ turn_counter: 1, state: 'open' });

    // A state outside the closed set cannot be recorded.
    await expect(
      client.query(
        `INSERT INTO conversation (conversation_id, primary_ticket_id, state)
         VALUES (gen_random_uuid(), 'T-2', 'wandering')`,
      ),
    ).rejects.toThrow(/conversation_state_check/);

    await client.query(
      `INSERT INTO turn (conversation_id, turn_number, ticket_id, inbound_message_id)
       VALUES ($1, 1, 'T-1', 'm-1@example.test')`,
      [conversationId],
    );
    // One turn number per conversation, so numbering cannot collide.
    await expect(
      client.query(
        `INSERT INTO turn (conversation_id, turn_number, ticket_id)
         VALUES ($1, 1, 'T-1')`,
        [conversationId],
      ),
    ).rejects.toThrow();

    // A conversation may span threads, which is what the ticket index serves.
    await client.query(
      `INSERT INTO turn (conversation_id, turn_number, ticket_id, inbound_message_id)
       VALUES ($1, 2, 'T-99', 'm-2@example.test')`,
      [conversationId],
    );
    const spanning = await client.query(
      'SELECT ticket_id FROM turn WHERE conversation_id = $1 ORDER BY turn_number',
      [conversationId],
    );
    expect(spanning.rows.map((r) => r.ticket_id)).toEqual(['T-1', 'T-99']);

    // Runs join a conversation, and a V1-era run keeps null.
    const runId = await seedRun();
    const runRow = await client.query(
      'SELECT conversation_id FROM run WHERE run_id = $1',
      [runId],
    );
    expect(runRow.rows[0]?.conversation_id).toBeNull();

    const indexes = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'migrate_test' AND tablename IN ('turn', 'run')`,
    );
    const names = indexes.rows.map((r) => r.indexname);
    expect(names).toContain('turn_ticket_idx');
    expect(names).toContain('turn_message_idx');
    expect(names).toContain('run_conversation_idx');
  });

  it('refuses to apply a file older than the highest recorded version', async () => {
    const dir = await tempMigrations([
      ['010_late.sql', 'CREATE TABLE late (id integer)'],
    ]);
    const first = await migrate(client, dir);
    expect(first.applied.map((f) => f.version)).toEqual([10]);

    await writeFile(path.join(dir, '005_early.sql'), 'CREATE TABLE early (id integer)');
    await expect(migrate(client, dir)).rejects.toThrow(/out of order/);

    const { rows } = await client.query<{ version: number }>(
      'SELECT version FROM schema_version ORDER BY version',
    );
    expect(rows.map((row) => row.version)).toEqual([10]);
    await rm(dir, { recursive: true, force: true });
  });

  it('rolls back a failed migration and records nothing for it', async () => {
    const dir = await tempMigrations([
      ['001_good.sql', 'CREATE TABLE good (id integer)'],
      ['002_bad.sql', 'CREATE TABLE bad (id integer); THIS IS NOT SQL'],
    ]);

    await expect(migrate(client, dir)).rejects.toThrow(/002_bad\.sql failed/);

    // 001 committed with its record; 002 left neither table nor record.
    const { rows } = await client.query<{ version: number }>(
      'SELECT version FROM schema_version',
    );
    expect(rows.map((row) => row.version)).toEqual([1]);
    const good = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'good'",
    );
    expect(good.rowCount).toBe(1);
    const bad = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'bad'",
    );
    expect(bad.rowCount).toBe(0);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('discoverMigrations', () => {
  it('rejects files without a numeric prefix and duplicate versions', async () => {
    const badName = await tempMigrations([['nope.sql', 'SELECT 1']]);
    await expect(discoverMigrations(badName)).rejects.toThrow(/NNN_name\.sql/);
    await rm(badName, { recursive: true, force: true });

    const dupe = await tempMigrations([
      ['001_a.sql', 'SELECT 1'],
      ['001_b.sql', 'SELECT 1'],
    ]);
    await expect(discoverMigrations(dupe)).rejects.toThrow(/one version number/);
  });
});

/**
 * Every real migration below one version, copied into a temp directory.
 *
 * The migrations run in version order, so a ledger that stops before
 * `excluded` is what an adopter's ledger holds on the day that migration
 * ships. Strictly below, and not merely different: a later migration in the
 * fixture would be applied first, and the runner then refuses the excluded
 * one as out of order — a failure about the fixture rather than about the
 * migration under test.
 */
async function copyMigrationsExcept(excluded: number): Promise<string> {
  const source = path.dirname(fileURLToPath(import.meta.url));
  const files = await discoverMigrations(path.join(source, '..', '..', 'db'));
  const kept = files.filter((file) => file.version < excluded);
  expect(files.filter((file) => file.version === excluded).length, 'the migration to leave out exists')
    .toBe(1);
  return await tempMigrations(
    await Promise.all(kept.map(async (file) =>
      [file.filename, await readFile(path.join(source, '..', '..', 'db', file.filename), 'utf8')] as [string, string],
    )),
  );
}

async function tempMigrations(files: Array<[string, string]>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'auracle-migrate-'));
  try {
    await mkdir(dir, { recursive: true });
    for (const [name, sql] of files) {
      await writeFile(path.join(dir, name), sql);
    }
  } catch (error) {
    // The caller's `finally` starts after this returns, so a failure in
    // here would leave the directory behind: a full temporary filesystem is
    // the way to reach it, and the leak outlives the run.
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}
