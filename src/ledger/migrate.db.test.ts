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

  // And the one constraint a database that ran db/019 before the vocabulary
  // was written keeps missing, because `CREATE TABLE IF NOT EXISTS` is a
  // no-op there. db/020 installs it by name.
  it('installs the release-kind constraint on an existing table (db/020, DEC-46)', async () => {
    await migrate(client);

    // The constraint is there whether or not db/019 created it.
    const constraint = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'case_hold'::regclass AND conname = 'case_hold_release_kind_check'`,
    );
    expect(constraint.rows).toHaveLength(1);

    const runId = await seedRun();
    await client.query(
      `INSERT INTO case_hold (run_id, reviewer, lapses_at)
       VALUES ($1, 'anna@example.test', now() + interval '20 minutes')`,
      [runId],
    );
    await expect(
      client.query(
        "UPDATE case_hold SET released_at = now(), release_kind = 'because' WHERE run_id = $1",
        [runId],
      ),
    ).rejects.toThrow(/case_hold_release_kind_check/);

    // Re-applying the file is a no-op rather than a duplicate-constraint
    // error: it is forward-only and safe to run again.
    //
    // From 20 upward, not 20 alone. The runner refuses a file older than the
    // highest recorded version, so re-applying one means removing its record
    // and every record above it. Deleting only version 20 passed while 020
    // was the newest file and refused the moment 021 existed — a case about
    // one migration that breaks when an unrelated one ships.
    await client.query('DELETE FROM schema_version WHERE version >= 20');
    await expect(migrate(client)).resolves.toBeDefined();
    await client.query(
      "UPDATE case_hold SET released_at = now(), release_kind = 'take_other' WHERE run_id = $1",
      [runId],
    );
  });

  // DEC-47: the product of the channel a message arrived on, recorded at
  // arrival and copied onto the run. Nullable on both tables, because a
  // channel the map does not name is a real answer and not a gap.
  it('installs the product dimension on the run and the intake row (db/021, DEC-47)', async () => {
    await migrate(client);
    const runId = await seedRun();

    // Nullable on both tables, because DEC-47's rejected alternatives are a
    // product nobody declared and a product inferred from the message: a
    // message on an unmapped channel records no product, and that is null.
    const columns = await client.query<{ table_name: string; is_nullable: string; data_type: string }>(
      // Scoped to this schema: information_schema is not search_path
      // scoped, and the template database this clone came from holds its own
      // run and intake.
      `SELECT table_name, is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = 'migrate_test'
          AND table_name IN ('run', 'intake') AND column_name = 'product'
        ORDER BY table_name`,
    );
    expect(columns.rows).toEqual([
      { table_name: 'intake', is_nullable: 'YES', data_type: 'text' },
      { table_name: 'run', is_nullable: 'YES', data_type: 'text' },
    ]);

    // A run written before this migration keeps no product, and that null is
    // the answer: the change backfills nothing.
    const run = await client.query<{ product: string | null }>(
      'SELECT product FROM run WHERE run_id = $1',
      [runId],
    );
    expect(run.rows[0]?.product).toBeNull();

    // Both write and read it as text.
    await client.query('UPDATE run SET product = $2 WHERE run_id = $1', [runId, 'aurora']);
    const written = await client.query<{ product: string | null }>(
      'SELECT product FROM run WHERE run_id = $1',
      [runId],
    );
    expect(written.rows[0]?.product).toBe('aurora');

    await client.query(
      `INSERT INTO intake (ticket_id, message_id, partition, ticket_text, product)
       VALUES ('T-9', 'M-9', 0, 'a message', 'ledger')`,
    );
    const intake = await client.query<{ product: string | null }>(
      "SELECT product FROM intake WHERE ticket_id = 'T-9'",
    );
    expect(intake.rows[0]?.product).toBe('ledger');
  });

  it('installs the products a reviewer covers (db/023, DEC-47)', async () => {
    await migrate(client);

    // Empty is the default and means no declared focus, so a reviewer added
    // before this migration is not reordered behind anyone.
    const column = await client.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_schema = 'migrate_test' AND table_name = 'reviewer'
          AND column_name = 'products'`,
    );
    expect(column.rows).toEqual([{ is_nullable: 'NO', data_type: 'ARRAY' }]);

    await client.query("INSERT INTO reviewer (identity) VALUES ('anna@example.test')");
    const plain = await client.query<{ products: string[] }>(
      "SELECT products FROM reviewer WHERE identity = 'anna@example.test'",
    );
    expect(plain.rows[0]?.products).toEqual([]);

    await client.query(
      "UPDATE reviewer SET products = ARRAY['aurora'] WHERE identity = 'anna@example.test'",
    );
    const scoped = await client.query<{ products: string[] }>(
      "SELECT products FROM reviewer WHERE identity = 'anna@example.test'",
    );
    expect(scoped.rows[0]?.products).toEqual(['aurora']);
  });

  // DEC-44: the text a reviewer saved on the case screen, before any approval
  // sends it. Nullable with no default, because a turn written before this
  // migration has no saved reply and that null is the answer: the approval
  // then sends the parked body.
  it('installs the reply a reviewer saved (db/024, DEC-44)', async () => {
    await migrate(client);

    const columns = await client.query<{
      column_name: string;
      is_nullable: string;
      data_type: string;
      column_default: string | null;
    }>(
      `SELECT column_name, is_nullable, data_type, column_default
         FROM information_schema.columns
        WHERE table_schema = 'migrate_test' AND table_name = 'turn'
          AND column_name IN ('saved_reply_text', 'approved_reply_text')
        ORDER BY column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: 'approved_reply_text', is_nullable: 'YES', data_type: 'text', column_default: null },
      { column_name: 'saved_reply_text', is_nullable: 'YES', data_type: 'text', column_default: null },
    ]);

    const conversationId = '11111111-1111-1111-1111-111111111111';
    await client.query(
      "INSERT INTO conversation (conversation_id, primary_ticket_id) VALUES ($1, 'T-1')",
      [conversationId],
    );
    await client.query(
      'INSERT INTO turn (conversation_id, turn_number, ticket_id) VALUES ($1, 1, $2)',
      [conversationId, 'T-1'],
    );

    // A turn written before this migration keeps no saved reply.
    const before = await client.query<{ saved_reply_text: string | null }>(
      'SELECT saved_reply_text FROM turn WHERE conversation_id = $1 AND turn_number = 1',
      [conversationId],
    );
    expect(before.rows[0]?.saved_reply_text).toBeNull();

    // The two columns answer different questions and are written
    // independently: what a person saved, and what an approval sent.
    await client.query(
      'UPDATE turn SET saved_reply_text = $2, approved_reply_text = $3 WHERE conversation_id = $1 AND turn_number = 1',
      [conversationId, 'the saved text', 'the sent text'],
    );
    const after = await client.query<{ saved_reply_text: string | null; approved_reply_text: string | null }>(
      'SELECT saved_reply_text, approved_reply_text FROM turn WHERE conversation_id = $1 AND turn_number = 1',
      [conversationId],
    );
    expect(after.rows[0]).toEqual({
      saved_reply_text: 'the saved text',
      approved_reply_text: 'the sent text',
    });
  });

  // DEC-44: the reply an outbox record sends, when the ledger holds it rather
  // than the helpdesk. Separate from `payload`, because the payload is hashed
  // into the idempotency key and DEC-49 rejects a key that folds in the body.
  it('installs the reply an outbox record carries (db/025, DEC-44)', async () => {
    await migrate(client);

    const column = await client.query<{ is_nullable: string; data_type: string; column_default: string | null }>(
      `SELECT is_nullable, data_type, column_default FROM information_schema.columns
        WHERE table_schema = 'migrate_test' AND table_name = 'outbox'
          AND column_name = 'reply'`,
    );
    expect(column.rows).toEqual([{ is_nullable: 'YES', data_type: 'jsonb', column_default: null }]);

    const runId = await seedRun();
    await client.query(
      `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery, payload, reply)
       VALUES ($1, 'approve', 'customer_reply:T-1:abc', 1, 'customer_reply', 'at_most_once',
               '{"draftExternalId": "hd-draft-0001"}',
               '{"bodyText": "Your refund is on its way.", "disclosure": "Sent by Auracle.",
                 "provenance": {"generatedBy": "model", "modelId": "m", "promptVer": "p",
                                "generatedAt": "2026-09-19T00:00:00Z"}}')`,
      [runId],
    );
    const row = await client.query<{ reply: { bodyText: string; disclosure: string } | null }>(
      "SELECT reply FROM outbox WHERE run_id = $1 AND step_id = 'approve'",
      [runId],
    );
    expect(row.rows[0]?.reply?.bodyText).toBe('Your refund is on its way.');
    expect(row.rows[0]?.reply?.disclosure).toBe('Sent by Auracle.');
  });

  it('installs the products a document serves (db/022, DEC-47)', async () => {
    await migrate(client);

    // Empty is the default and means every product, so a document indexed
    // before this migration serves everyone rather than nobody.
    const column = await client.query<{ is_nullable: string; data_type: string; column_default: string }>(
      `SELECT is_nullable, data_type, column_default FROM information_schema.columns
        WHERE table_schema = 'migrate_test' AND table_name = 'document'
          AND column_name = 'products'`,
    );
    expect(column.rows).toHaveLength(1);
    expect(column.rows[0]?.is_nullable).toBe('NO');
    expect(column.rows[0]?.data_type).toBe('ARRAY');
    expect(column.rows[0]?.column_default).toContain("'{}'");

    // The GIN index the retrieval filter reads.
    const index = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'migrate_test' AND tablename = 'document'
          AND indexname = 'document_products_idx'`,
    );
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.indexdef).toContain('gin');

    await client.query(
      `INSERT INTO document (doc_id, kind, title, body, owner, review_by, embedding)
       VALUES ('D-1', 'document', 't', 'b', 'o', CURRENT_DATE, array_fill(0, ARRAY[1536])::vector)`,
    );
    const stored = await client.query<{ products: string[] }>(
      "SELECT products FROM document WHERE doc_id = 'D-1'",
    );
    expect(stored.rows[0]?.products).toEqual([]);
    await client.query(
      "UPDATE document SET products = ARRAY['aurora'] WHERE doc_id = 'D-1'",
    );
    const scoped = await client.query<{ products: string[] }>(
      "SELECT products FROM document WHERE doc_id = 'D-1'",
    );
    expect(scoped.rows[0]?.products).toEqual(['aurora']);
  });

  // DEC-46: two tables, and the constraints that make them readable. The
  // live table holds one row per case, so "who holds this" is one lookup;
  // the history is append-only and keeps what happened after the row moved
  // on.
  it('installs the case hold and its history (db/019, DEC-46)', async () => {
    await migrate(client);
    const runId = await seedRun();

    await client.query(
      `INSERT INTO case_hold (run_id, reviewer, lapses_at)
       VALUES ($1, 'anna@example.test', now() + interval '20 minutes')`,
      [runId],
    );
    // One row per case: a second hold on the same run is the same row.
    await expect(
      client.query(
        `INSERT INTO case_hold (run_id, reviewer, lapses_at)
         VALUES ($1, 'bo@example.test', now() + interval '20 minutes')`,
        [runId],
      ),
    ).rejects.toThrow(/case_hold_pkey/);

    // The kinds are a closed set, on both tables. A release kind outside it
    // is a row no reader can classify.
    await expect(
      client.query(
        "UPDATE case_hold SET released_at = now(), release_kind = 'because' WHERE run_id = $1",
        [runId],
      ),
    ).rejects.toThrow(/release_kind_check/);
    await client.query(
      "UPDATE case_hold SET released_at = now(), release_kind = 'lapse' WHERE run_id = $1",
      [runId],
    );
    await expect(
      client.query(
        `INSERT INTO case_hold_event (run_id, reviewer, kind) VALUES ($1, 'anna@example.test', 'snooze')`,
        [runId],
      ),
    ).rejects.toThrow(/kind_check/);

    // The history is append-only, and it keeps its own order.
    await client.query(
      `INSERT INTO case_hold_event (run_id, reviewer, kind, from_reviewer)
       VALUES ($1, 'bo@example.test', 'handover', 'anna@example.test')`,
      [runId],
    );
    const events = await client.query(
      'SELECT kind, reviewer, from_reviewer FROM case_hold_event WHERE run_id = $1 ORDER BY event_id',
      [runId],
    );
    expect(events.rows).toEqual([
      { kind: 'handover', reviewer: 'bo@example.test', from_reviewer: 'anna@example.test' },
    ]);
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
