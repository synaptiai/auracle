// Integration suite for the V2 migration runner (src/ledger/migrate.ts).
// Each case runs against an isolated Postgres schema, so the runner's
// schema_version table and the migration DDL never leak between cases.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { discoverMigrations, migrate } from './migrate.js';

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: dbUrl() });
  await client.connect();
});

afterAll(async () => {
  await client.end();
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
