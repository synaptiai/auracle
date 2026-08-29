// Integration suite for the V2 migration runner (src/ledger/migrate.ts).
// Each case runs against an isolated Postgres schema, so the runner's
// schema_version table and the migration DDL never leak between cases.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

async function tempMigrations(files: Array<[string, string]>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'auracle-migrate-'));
  await mkdir(dir, { recursive: true });
  for (const [name, sql] of files) {
    await writeFile(path.join(dir, name), sql);
  }
  return dir;
}
