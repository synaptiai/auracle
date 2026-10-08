// The readers' database role, and the check that holds every read to it.
//
// READ ONLY refuses a write to a table and nothing else. The source guards
// catch a mistake in ordinary code, and nothing stops code written to evade
// them. The role is the barrier against that code: each effect below passes
// READ ONLY under a superuser, and the readers' role refuses it at the database.
//
// The ways the role and its check can fail, each with the cases that hold it:
//
//   1. The role keeps a right that acts beyond a read: the four effects a
//      review of PR #152 found, and what PUBLIC holds.
//   2. It reads a table the readers do not read, or misses one they do.
//   3. An attribute, a setting or a membership added by hand outlives the
//      restate, whoever granted it.
//   4. The restate refuses a ledger it should accept, so every migrate
//      fails: an onward membership, CREATE that PUBLIC holds on the public
//      schema, a default right the role set for itself.
//   5. The restate reports a role as stripped when a right remains, keeps a
//      stripped attribute when it finds one, or gives the role a login while
//      a right remains.
//   6. The session check passes a session that is not the role, or the role
//      with an attribute, a membership or an object it owns.
//   7. The console or the migrator accepts a readers' URL on another ledger,
//      or misses a database the role can log in to.
//   8. The migrator applies a file before it refuses a bad readers' URL.
//   9. The verifier is not the one Postgres builds.
//  10. The restate gives an object the role owns to the migrator, a
//      superuser, so a function the role wrote runs with a superuser's rights.
//  11. The restate takes away a right the role needs: CONNECT on the ledger,
//      or on another ledger on the server.
//  12. The restate hangs, or names the wrong cause, when another session
//      holds its lock.
//  13. A failure after a statement ran leaves a state the error misstates.
//  14. The one-ledger check reads a session setting, and calls one ledger two.
//  15. The migrator misnames why it stops, or the state it leaves.
//  16. A ledger whose server lacks the role fails every migrate.
//  17. The migrator sets the role's login on one ledger before it finds the
//      readers' URL names another.
//  18. The migrator does not say it created the role, when a later step
//      fails or when all succeed.
//  19. A second migrator sets the role's login between the first one's
//      login and its check of that login.
//  20. A failed restate keeps the migration lock, so the session blocks
//      every later migrator.
//  21. A migrator that waits for the lock never restates once it is free.
//  22. A session of the role takes the migration lock and holds it, so
//      every migration fails while that session lives.
import pg, { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { boundedRead, SESSION_CHECK } from './bounded-read.js';
import { assertOneLedger, dbUrl, readerDbUrl } from './config.js';
import { probeReaders } from './probe-readers.js';
import {
  READER_ROLE, READER_TABLES, ReaderRightsLeft, readerReach, restateReaderRole, scramVerifier,
} from '../ledger/reader-role.js';
import { migrate, restateReaders } from '../ledger/migrate.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const readers = new Pool({ connectionString: readerDbUrl(), max: 2 });
const writer = new Pool({ connectionString: dbUrl(), max: 2 });
await readers.query('SELECT 1');

/** Roles a case created on the server, dropped when the file ends. */
const scratchRoles: string[] = [];
/** Databases a case created on the server, dropped when the file ends. */
const scratchDatabases: string[] = [];

afterAll(async () => {
  // Every step runs, whatever an earlier one did, so an interrupted case
  // leaves no login role behind. A role that regressed would have let the
  // probes through, and a slot left behind holds WAL on the server until the
  // disk fills. Both are the cluster's, so they outlive this file's database.
  const faults: unknown[] = [];
  const step = async (statement: string): Promise<void> => {
    await writer.query(statement).catch((error: unknown) => faults.push(error));
  };
  await step("SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = 'reader_role_probe'");
  await step("SELECT pg_replication_origin_drop(roname) FROM pg_replication_origin WHERE roname = 'reader_role_probe'");
  await step("SELECT lo_unlink(oid) FROM pg_largeobject_metadata WHERE lomowner = 'auracle_reader'::regrole");
  // At once, each on a connection of its own. Under a parallel run one
  // DROP DATABASE took 39 s, and a probe showed each drop raise the server's
  // requested-checkpoint count by one. Serial drops paid that per database
  // and overran the hook, which then leaked every database and skipped the
  // role steps below. Concurrent drops wait on one checkpoint together. No
  // statement timeout: a drop cancelled partway leaves an invalid database
  // that no one can connect to until a person drops it again.
  const dropper = new Pool({ connectionString: dbUrl(), max: Math.max(1, scratchDatabases.length) });
  await Promise.all(scratchDatabases.map((database) =>
    dropper.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`)
      .catch((error: unknown) => faults.push(error))));
  await dropper.end().catch((error: unknown) => faults.push(error));
  // A drop that issues no error can still leave a name, so the result is read.
  if (scratchDatabases.length > 0) {
    const names = scratchDatabases.map((database) => database.replace(/^"|"$/g, ''));
    await writer.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = ANY($1)', [names],
    ).then((result) => {
      if (result.rows.length > 0) {
        faults.push(new Error(`scratch databases left behind: ${result.rows.map((row) => row.datname).join(', ')}`));
      }
    }, (error: unknown) => faults.push(error));
  }
  // A restated scratch role holds grants in this database, so they go first.
  // One statement each for every role, not one round trip per role: the file
  // makes some 25 of them, and 50 serial catalog scans overran the hook's
  // budget on a loaded machine. A statement over many roles drops all of them
  // or none, so a failed batch falls back to one role at a time. Only a role
  // that cannot be dropped then stays behind, and its own fault says why.
  if (scratchRoles.length > 0) {
    // A name joins the list before CREATE ROLE runs, and DROP OWNED has no
    // IF EXISTS. A role that was never created would fail the whole batch.
    const existing = await writer.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolname = ANY($1)', [scratchRoles],
    ).then((result) => result.rows.map((row) => row.rolname), (error: unknown) => {
      faults.push(error);
      return scratchRoles;
    });
    if (existing.length > 0) {
      const batchError = await writer.query(`DROP OWNED BY ${existing.join(', ')}`)
        .then(() => writer.query(`DROP ROLE IF EXISTS ${existing.join(', ')}`))
        .then(() => null, (error: unknown) => error);
      if (batchError !== null) {
        const before = faults.length;
        for (const role of existing) {
          await writer.query(`DROP OWNED BY ${role}`)
            .then(() => writer.query(`DROP ROLE IF EXISTS ${role}`))
            .catch((error: unknown) => faults.push(error));
        }
        // The batch failed for the same reason a single role did, so its
        // error explains the faults that follow it.
        if (faults.length > before) faults.splice(before, 0, batchError);
      }
    }
    // A cleanup that issues no drop raises no error, so the result is read.
    // A role left behind can log in to the shared server.
    await writer.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolname = ANY($1)', [scratchRoles],
    ).then((result) => {
      if (result.rows.length > 0) {
        faults.push(new Error(`scratch roles left behind: ${result.rows.map((row) => row.rolname).join(', ')}`));
      }
    }, (error: unknown) => faults.push(error));
  }
  await readers.end().catch((error: unknown) => faults.push(error));
  await writer.end().catch((error: unknown) => faults.push(error));
  if (faults.length > 0) throw new AggregateError(faults, 'the role suite could not clean up');
  // Its own budget, three times the project's hook timeout. The drops are not
  // cancelled, and the role steps after them must still run: a role that owns
  // objects in a scratch database cannot be dropped until that database is.
}, 180_000);

function scratchName(kind: string): string {
  return `${kind}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** A URL like `base`, for another user or database. */
function urlFor(base: string, change: { user?: string; password?: string; database?: string }): string {
  const url = new URL(base);
  if (change.user !== undefined) url.username = change.user;
  if (change.password !== undefined) url.password = change.password;
  if (change.database !== undefined) url.pathname = `/${change.database}`;
  return url.toString();
}

/**
 * A login role of this file's own, and a pool that connects as it. The server
 * is shared, so the name is unique to this run.
 */
async function scratchLogin(grants: string): Promise<{ role: string; pool: Pool }> {
  const role = scratchName('reader_probe');
  scratchRoles.push(role);
  await writer.query(`CREATE ROLE ${role} LOGIN PASSWORD 'probe' ${grants}`);
  const pool = new Pool({ connectionString: urlFor(readerDbUrl(), { user: role, password: 'probe' }), max: 1 });
  return { role, pool };
}

/**
 * A database of this file's own. The name carries the clone prefix, which
 * the compose stack's pg_hba lets the readers' role log in to.
 */
async function scratchDatabase(): Promise<string> {
  const name = scratchName('auracle_clone_probe');
  scratchDatabases.push(name);
  await writer.query(`CREATE DATABASE ${name}`);
  return name;
}

async function restate(role: string): Promise<void> {
  const client = await writer.connect();
  try {
    await restateReaderRole(client, { role });
  } finally {
    client.release();
  }
}

interface InjectOptions {
  readonly credential?: string;
  /** A server's refusal by default; a lost connection with `socket`. */
  readonly fault?: 'server' | 'socket';
  /** The matched statement reports success and does nothing. */
  readonly skip?: boolean;
  readonly role?: string;
}

/**
 * Restates `role` on a connection where each statement `fails` matches fails,
 * or with `skip`, reports success and does nothing. Returns what it threw.
 */
async function restateFailing(
  role: string,
  fails: (text: string) => boolean,
  options: InjectOptions = {},
): Promise<{ message: string; rollbackFailed?: boolean; rights?: readonly string[] }> {
  const client = await writer.connect();
  const real = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<unknown>;
  const injected = new Proxy(client, {
    get(target, key, receiver) {
      if (key !== 'query') return Reflect.get(target, key, receiver);
      return (text: string, values?: unknown[]) => {
        if (typeof text === 'string' && fails(text)) {
          if (options.skip === true) return Promise.resolve({ rows: [], rowCount: 0 });
          const message = `injected at ${text.slice(0, 24)}`;
          return Promise.reject(options.fault === 'socket'
            ? Object.assign(new Error(message), { code: 'ECONNRESET' })
            : Object.assign(new pg.DatabaseError(message, 0, 'error'), { code: 'XX000' }));
        }
        return real(text, values);
      };
    },
  });
  try {
    await restateReaderRole(injected, {
      role,
      ...(options.credential === undefined ? {} : { credential: options.credential }),
    });
    throw new Error('the restate did not fail');
  } catch (error) {
    return error as { message: string; rollbackFailed?: boolean; rights?: readonly string[] };
  } finally {
    await real('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/** Runs one statement as a read, and returns the error the server raised. */
async function refusal(sql: string, values?: unknown[]): Promise<{ code?: string; message: string }> {
  try {
    await boundedRead(readers, 'test', 5_000, 6_000, (query) => query(sql, values));
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error(`the readers' role ran: ${sql}`);
}

describe("the readers' role", () => {
  it('connects as auracle_reader, with no right beyond its own', async () => { // 1
    const { rows } = await readers.query<{
      session_user: string; rolsuper: boolean; rolreplication: boolean; rolbypassrls: boolean;
      signal: boolean; read_files: boolean; write_files: boolean; program: boolean;
    }>(
      `SELECT session_user, r.rolsuper, r.rolreplication, r.rolbypassrls,
              pg_has_role(session_user, 'pg_signal_backend', 'MEMBER') AS signal,
              pg_has_role(session_user, 'pg_read_server_files', 'MEMBER') AS read_files,
              pg_has_role(session_user, 'pg_write_server_files', 'MEMBER') AS write_files,
              pg_has_role(session_user, 'pg_execute_server_program', 'MEMBER') AS program
         FROM pg_roles r WHERE r.rolname = session_user`,
    );
    expect(rows).toEqual([{
      session_user: 'auracle_reader', rolsuper: false, rolreplication: false, rolbypassrls: false,
      signal: false, read_files: false, write_files: false, program: false,
    }]);
  });

  // The four effects a review of PR #152 found passing READ ONLY.
  it('refuses to end another session', async () => { // 1
    const other = await writer.connect();
    try {
      const { rows } = await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const error = await refusal('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
      expect(error.code).toBe('42501');
      // The other session is still alive.
      await expect(other.query('SELECT 1')).resolves.toBeDefined();
    } finally {
      other.release();
    }
  });

  it('refuses to write rows to the catalog', async () => { // 1
    const error = await refusal("SELECT pg_import_system_collations('pg_catalog'::regnamespace)");
    expect(error.code).toBe('42501');
  });

  it('refuses to create a replication slot', async () => { // 1
    const error = await refusal("SELECT pg_create_physical_replication_slot('reader_role_probe')");
    expect(error.code).toBe('42501');
  });

  it('refuses to create a replication origin', async () => { // 1
    const error = await refusal("SELECT pg_replication_origin_create('reader_role_probe')");
    expect(error.code).toBe('42501');
  });

  it('reads each table the readers read, and no other', async () => { // 2
    for (const table of READER_TABLES) {
      await expect(
        boundedRead(readers, 'test', 5_000, 6_000, (query) => query(`SELECT count(*) FROM ${table}`)),
        table,
      ).resolves.toBeDefined();
    }
    for (const table of ['schema_version', 'ticket_epoch']) {
      expect((await refusal(`SELECT count(*) FROM ${table}`)).code, table).toBe('42501');
    }
  });

  it('holds every public table in one of the two lists', async () => { // 2
    const { rows } = await writer.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    expect(rows.map((row) => row.table_name)).toEqual(
      [...READER_TABLES, 'schema_version', 'ticket_epoch'].sort(),
    );
  });
});

describe("what PUBLIC would give the readers' role", () => {
  // PUBLIC holds these by default, and Postgres cannot take a right from one
  // role that PUBLIC grants. The restate revokes them from PUBLIC in the
  // ledger's database.
  it('refuses to write to the WAL', async () => { // 1
    const error = await refusal("SELECT pg_logical_emit_message(false, 'reader_role_probe', 'x')");
    expect(error.code).toBe('42501');
  });

  it("refuses to end or cancel another session of the readers' role", async () => { // 1
    const other = await readers.connect();
    try {
      const { rows } = await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      expect((await refusal('SELECT pg_cancel_backend($1)', [rows[0]!.pid])).code).toBe('42501');
      expect((await refusal('SELECT pg_terminate_backend($1)', [rows[0]!.pid])).code).toBe('42501');
      await expect(other.query('SELECT 1')).resolves.toBeDefined();
    } finally {
      other.release();
    }
  });

  // Outside a read, on a plain connection, where READ ONLY does not apply.
  // Named here rather than read from the module's own list, so a function
  // dropped from that list fails this case.
  it('holds EXECUTE on none of the functions PUBLIC would give it', async () => { // 1
    const { rows } = await writer.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
        WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname = ANY($1::text[])
          AND has_function_privilege($2, p.oid, 'EXECUTE')`,
      [[
        'pg_logical_emit_message', 'pg_cancel_backend', 'pg_terminate_backend',
        'lo_create', 'lo_creat', 'lo_from_bytea', 'lo_put', 'lowrite', 'lo_truncate', 'lo_truncate64',
        'pg_advisory_lock', 'pg_advisory_lock_shared', 'pg_try_advisory_lock', 'pg_try_advisory_lock_shared',
        'pg_advisory_xact_lock', 'pg_advisory_xact_lock_shared', 'pg_try_advisory_xact_lock',
        'pg_try_advisory_xact_lock_shared',
      ], READER_ROLE],
    );
    expect(rows).toEqual([]);
  });

  // A session of the role holding the migration lock would stop every
  // migration for as long as it stayed open.
  it('refuses an advisory lock even outside a read', async () => { // 1, 22
    await expect(readers.query('SELECT pg_advisory_lock(153041)')).rejects.toMatchObject({ code: '42501' });
    await expect(readers.query('SELECT pg_try_advisory_lock_shared(153041)')).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a large object and a temp table even outside a read', async () => { // 1
    await expect(readers.query("SELECT lo_from_bytea(0, 'x')")).rejects.toMatchObject({ code: '42501' });
    await expect(readers.query('CREATE TEMP TABLE reader_role_probe (i int)')).rejects.toMatchObject({ code: '42501' });
  });

  it('carries a temp file limit a read cannot change', async () => { // 1
    const { rows } = await writer.query<{ rolconfig: string[] | null }>(
      'SELECT rolconfig FROM pg_roles WHERE rolname = $1',
      [READER_ROLE],
    );
    expect(rows[0]!.rolconfig).toContain('temp_file_limit=1GB');
    expect((await refusal("SELECT set_config('temp_file_limit', '-1', true)")).code).toBe('42501');
  });

  // A database does not pass its rights to a clone, so this asks the restate
  // itself: PUBLIC gets TEMP here, and the restate takes it back.
  it('takes TEMP back from PUBLIC when it restates', async () => { // 1
    const { rows: [db] } = await writer.query<{ name: string }>('SELECT current_database() AS name');
    await writer.query(`GRANT TEMP ON DATABASE ${db!.name} TO PUBLIC`);
    const plain = await readers.connect();
    try {
      await plain.query('CREATE TEMP TABLE reader_role_temp_probe (i int)');
    } finally {
      plain.release(true);
    }
    const { role, pool } = await scratchLogin('');
    await pool.end();
    await restate(role);
    await expect(readers.query('CREATE TEMP TABLE reader_role_temp_probe (i int)'))
      .rejects.toMatchObject({ code: '42501' });
  });
});

// Every db:migrate restates the role: its attributes, settings, memberships
// and the rights it holds. Run on a role of this file's own: the readers'
// role is the server's, and the other files read through it while this one
// runs.
describe('the restate', () => {
  it('takes back every attribute, setting and membership added by hand', async () => { // 3
    const { role, pool } = await scratchLogin('SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS CONNECTION LIMIT -1');
    await pool.end();
    const { rows: [db] } = await writer.query<{ name: string }>('SELECT current_database() AS name');
    await writer.query(`ALTER ROLE ${role} SET statement_timeout = 0`);
    await writer.query(`ALTER ROLE ${role} IN DATABASE ${db!.name} SET temp_file_limit = -1`);
    await writer.query(`GRANT pg_read_all_data TO ${role}`);
    // A membership another role granted. A REVOKE by the migrator alone
    // leaves it, with only a warning the driver drops.
    const admin = await scratchLogin('CREATEROLE');
    await writer.query(`GRANT pg_read_all_stats TO ${admin.role} WITH ADMIN OPTION`);
    await admin.pool.query(`GRANT pg_read_all_stats TO ${role}`);
    await admin.pool.end();

    await restate(role);

    const { rows } = await writer.query<Record<string, unknown>>(
      `SELECT r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
              r.rolconnlimit, r.rolconfig,
              (SELECT array_agg(setdatabase::int) FROM pg_db_role_setting WHERE setrole = r.oid) AS setting_rows,
              (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS members,
              has_table_privilege(r.rolname, 'run', 'SELECT') AS select_run
         FROM pg_roles r WHERE r.rolname = $1`,
      [role],
    );
    expect(rows[0]).toEqual({
      rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false,
      // The maintainer chose ten connections (issue #153).
      rolconnlimit: 10,
      rolconfig: ['temp_file_limit=1GB'],
      // One row, the role-wide one: the per-database setting is gone.
      setting_rows: [0],
      members: 0,
      select_run: true,
    });
  });

  // A membership the role passed on with an admin option has a dependent
  // grant, and a plain REVOKE refuses to take it.
  it('takes back a membership the role granted onward', async () => { // 3, 4
    const holder = await scratchLogin('');
    const onward = await scratchLogin('');
    await onward.pool.end();
    await writer.query(`GRANT pg_read_all_settings TO ${holder.role} WITH ADMIN OPTION`);
    await holder.pool.query(`GRANT pg_read_all_settings TO ${onward.role}`);
    await holder.pool.end();
    await restate(holder.role);
    const { rows } = await writer.query<{ holder: number; onward: number }>(
      `SELECT (SELECT count(*)::int FROM pg_auth_members WHERE member = $1::regrole) AS holder,
              (SELECT count(*)::int FROM pg_auth_members WHERE member = $2::regrole) AS onward`,
      [holder.role, onward.role],
    );
    expect(rows[0]).toEqual({ holder: 0, onward: 0 });
  });

  // A database made before PostgreSQL 15 still lets PUBLIC create in the
  // public schema, and a restate that left it would refuse every migrate.
  it('takes CREATE on the public schema back from PUBLIC', async () => { // 1, 4
    await writer.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
    const { role, pool } = await scratchLogin('');
    await pool.end();
    await restate(role);
    const { rows } = await writer.query<{ create: boolean }>(
      "SELECT has_schema_privilege($1, 'public', 'CREATE') AS create",
      [READER_ROLE],
    );
    expect(rows[0]!.create).toBe(false);
  });

  // Commit, then sort (issue #153): the restate strips what it can, and what
  // it states and finds otherwise stops the migrate with its name.
  it('commits what it took, then names what it states and finds otherwise', async () => { // 5
    const { role, pool } = await scratchLogin('CREATEDB');
    await pool.end();
    const { rows: [db] } = await writer.query<{ name: string }>('SELECT current_database() AS name');
    await writer.query(`GRANT CREATE ON DATABASE ${db!.name} TO PUBLIC`);
    try {
      const error = await restate(role).then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(ReaderRightsLeft);
      expect((error as ReaderRightsLeft).rights).toEqual([`TEMP or CREATE on database ${db!.name}`]);
      expect((error as Error).message).toMatch(/Its login is unchanged\. A right PUBLIC holds, a membership or an object/);
      const { rows } = await writer.query<{ rolcreatedb: boolean }>(
        'SELECT rolcreatedb FROM pg_roles WHERE rolname = $1',
        [role],
      );
      expect(rows[0]!.rolcreatedb).toBe(false);
    } finally {
      await writer.query(`REVOKE CREATE ON DATABASE ${db!.name} FROM PUBLIC`);
    }
  });

  // An object the role owns stays the role's. Given to the migrator, a
  // function the role wrote would run with a superuser's rights.
  it('never gives the role\'s objects to the migrator, and sets no login while it owns them', async () => { // 5, 10
    const { role, pool } = await scratchLogin('CREATEDB');
    await pool.end();
    const table = scratchName('reader_probe_owned');
    const fn = scratchName('reader_probe_definer');
    await writer.query(`CREATE TABLE ${table} (i int)`);
    await writer.query(`ALTER TABLE ${table} OWNER TO ${role}`);
    await writer.query(`CREATE FUNCTION ${fn}() RETURNS text SECURITY DEFINER LANGUAGE sql AS 'SELECT current_user::text'`);
    await writer.query(`ALTER FUNCTION ${fn}() OWNER TO ${role}`);
    try {
      const client = await writer.connect();
      let error: unknown;
      try {
        error = await restateReaderRole(client, { role, credential: 'changed' })
          .then(() => undefined, (failure: unknown) => failure);
      } finally {
        client.release();
      }
      expect(error).toBeInstanceOf(ReaderRightsLeft);
      expect((error as ReaderRightsLeft).rights).toEqual(expect.arrayContaining([
        `ownership of function ${fn}()`,
        `ownership of table ${table}`,
      ]));
      const { rows } = await writer.query<{ table_owner: string; fn_owner: string; rolcreatedb: boolean }>(
        `SELECT (SELECT tableowner FROM pg_tables WHERE tablename = $2) AS table_owner,
                (SELECT proowner::regrole::text FROM pg_proc WHERE proname = $3) AS fn_owner,
                (SELECT rolcreatedb FROM pg_roles WHERE rolname = $1) AS rolcreatedb`,
        [role, table, fn],
      );
      expect(rows[0]).toEqual({ table_owner: role, fn_owner: role, rolcreatedb: false });
      // The login is the one it had: the new password was never set.
      const old = new Pool({ connectionString: urlFor(readerDbUrl(), { user: role, password: 'probe' }), max: 1 });
      const fresh = new Pool({ connectionString: urlFor(readerDbUrl(), { user: role, password: 'changed' }), max: 1 });
      try {
        await expect(old.query('SELECT 1')).resolves.toBeDefined();
        await expect(fresh.query('SELECT 1')).rejects.toMatchObject({ code: '28P01' });
      } finally {
        await old.end();
        await fresh.end();
      }
    } finally {
      await writer.query(`DROP TABLE ${table}`);
      await writer.query(`DROP FUNCTION ${fn}()`);
    }
  });

  // The role may set its own default rights, as every role may. They are a
  // setting, not an object it owns, so they do not stop the migrate.
  it('passes default rights the role set for itself', async () => { // 4
    const { role, pool } = await scratchLogin('');
    try {
      await pool.query('ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC');
    } finally {
      await pool.end();
    }
    await expect(restate(role)).resolves.toBeUndefined();
  });

  // A hardened ledger takes CONNECT from PUBLIC. The role keeps its own.
  it('grants the role CONNECT on the ledger', async () => { // 11
    const { role, pool } = await scratchLogin('');
    await pool.end();
    const { rows: [db] } = await writer.query<{ name: string }>('SELECT current_database() AS name');
    await writer.query(`REVOKE CONNECT ON DATABASE ${db!.name} FROM PUBLIC`);
    try {
      await restate(role);
      const { rows } = await writer.query<{ connect: boolean }>(
        "SELECT has_database_privilege($1, current_database(), 'CONNECT') AS connect",
        [role],
      );
      expect(rows[0]!.connect).toBe(true);
    } finally {
      await writer.query(`GRANT CONNECT ON DATABASE ${db!.name} TO PUBLIC`);
    }
  });

  // Two hardened ledgers on one server share the role. The restate of one
  // leaves the role's CONNECT on the other alone.
  it("leaves the role's CONNECT on another ledger", async () => { // 11
    const { role, pool } = await scratchLogin('');
    await pool.end();
    const other = await scratchDatabase();
    await writer.query(`REVOKE CONNECT ON DATABASE ${other} FROM PUBLIC`);
    await writer.query(`GRANT CONNECT ON DATABASE ${other} TO ${role}`);
    await restate(role);
    const { rows } = await writer.query<{ connect: boolean }>(
      "SELECT has_database_privilege($1, $2, 'CONNECT') AS connect",
      [role, other],
    );
    expect(rows[0]!.connect).toBe(true);
  });

  // Each failure after a statement runs, injected on the migrator's own
  // connection, says what state is left.
  it('names the state each failure leaves', async () => { // 5, 13
    const { role, pool } = await scratchLogin('');
    await pool.end();
    const failing = (fails: (text: string) => boolean, options: InjectOptions = {}) =>
      restateFailing(options.role ?? role, fails, options);
    expect((await failing((text) => text === 'COMMIT')).message)
      .toMatch(new RegExp(`^restating ${role} failed and changed nothing: injected at COMMIT`));
    // A lost connection before the commit is sent changed nothing. One at the
    // commit may follow the commit, so it claims nothing.
    expect((await failing((text) => text.startsWith('GRANT CONNECT'), { fault: 'socket' })).message)
      .toMatch(new RegExp(`^restating ${role} failed and changed nothing: injected at GRANT CONNECT`));
    expect((await failing((text) => text === 'COMMIT', { fault: 'socket' })).message)
      .toMatch(new RegExp(`^restating ${role} failed, and whether it committed is unknown; a rerun is safe: injected at COMMIT`));
    const unknown = await failing((text) => text === 'COMMIT' || text === 'ROLLBACK');
    expect(unknown.message).toMatch(new RegExp(`^restating ${role} failed, and whether it committed is unknown`));
    expect(unknown.rollbackFailed).toBe(true);
    expect((await failing((text) => text.includes('pg_shdepend'))).message)
      .toMatch(new RegExp(`^${role} was restated and committed, and reading it back failed, so its login is unchanged`));
    expect((await failing((text) => text.includes('LOGIN PASSWORD'), { credential: 'changed' })).message)
      .toMatch(new RegExp(`^${role} was restated, committed and read back clean, and setting its login failed, so its login is unchanged`));
    // A lost connection can follow a commit, so it claims nothing.
    expect((await failing((text) => text.includes('LOGIN PASSWORD'), { credential: 'changed', fault: 'socket' })).message)
      .toMatch(new RegExp(`^${role} was restated, committed and read back clean, and setting its login failed, so its login may have changed`));
    // A grant that silently did nothing is named by the read-back.
    const { rows: [db] } = await writer.query<{ name: string }>('SELECT current_database() AS name');
    await writer.query(`REVOKE CONNECT ON DATABASE ${db!.name} FROM PUBLIC`);
    try {
      const fresh = await scratchLogin('');
      await fresh.pool.end();
      const skipped = await failing(
        (text) => text.startsWith('GRANT CONNECT') || text.startsWith('GRANT SELECT ON TABLE public.run '),
        { skip: true, role: fresh.role },
      );
      expect(skipped.rights)
        .toEqual([`no CONNECT on database ${db!.name}`, 'no SELECT on public.run']);
    } finally {
      await writer.query(`GRANT CONNECT ON DATABASE ${db!.name} TO PUBLIC`);
    }
  });

  // Each thing the restate states, left undone by a statement that reports
  // success and does nothing, is named by the read-back.
  it('names each thing it states and finds otherwise', async () => { // 5
    const { rows: [db] } = await writer.query<{ name: string }>('SELECT current_database() AS name');
    const fresh = async (grants = ''): Promise<string> => {
      const login = await scratchLogin(grants);
      await login.pool.end();
      return login.role;
    };
    const named = async (role: string, skipped: RegExp): Promise<readonly string[]> =>
      (await restateFailing(role, (text) => skipped.test(text), { skip: true })).rights ?? [];

    // A superuser also holds EXECUTE on every function, so the attributes and
    // the limit are the first six things named.
    const attributes = await named(
      await fresh('SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS CONNECTION LIMIT -1'),
      /^ALTER ROLE \S+ NOSUPERUSER/,
    );
    expect(attributes.slice(0, 6))
      .toEqual(['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'a connection limit of -1']);

    await writer.query(`GRANT TEMP ON DATABASE ${db!.name} TO PUBLIC`);
    try {
      expect(await named(await fresh(), /^REVOKE TEMP ON DATABASE/)).toEqual([`TEMP or CREATE on database ${db!.name}`]);
    } finally {
      await writer.query(`REVOKE TEMP ON DATABASE ${db!.name} FROM PUBLIC`);
    }

    const set = await fresh();
    await writer.query(`ALTER ROLE ${set} SET statement_timeout = 0`);
    expect(await named(set, /^ALTER ROLE \S+ RESET ALL$/))
      .toEqual(['the settings ["statement_timeout=0","temp_file_limit=1GB"]']);

    const perDatabase = await fresh();
    await writer.query(`ALTER ROLE ${perDatabase} IN DATABASE ${db!.name} SET work_mem = '64MB'`);
    expect(await named(perDatabase, /IN DATABASE \S+ RESET ALL$/)).toEqual([`a setting in database ${db!.name}`]);

    const member = await fresh();
    await writer.query(`GRANT pg_read_all_stats TO ${member}`);
    expect(await named(member, /^REVOKE \S+ FROM \S+ GRANTED BY/)).toEqual(['a membership in pg_read_all_stats']);

    await writer.query('GRANT EXECUTE ON FUNCTION pg_cancel_backend(integer) TO PUBLIC');
    try {
      expect(await named(await fresh(), /^REVOKE EXECUTE ON FUNCTION pg_cancel_backend/))
        .toEqual(['EXECUTE on pg_cancel_backend(integer)']);
    } finally {
      await writer.query('REVOKE EXECUTE ON FUNCTION pg_cancel_backend(integer) FROM PUBLIC');
    }

    await writer.query('GRANT CREATE ON SCHEMA public TO PUBLIC');
    try {
      expect(await named(await fresh(), /^REVOKE CREATE ON SCHEMA public FROM PUBLIC$/))
        .toEqual(['CREATE on schema public']);
    } finally {
      await writer.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    }

    await writer.query('REVOKE USAGE ON SCHEMA public FROM PUBLIC');
    try {
      expect(await named(await fresh(), /^GRANT USAGE ON SCHEMA public/)).toEqual(['no USAGE on schema public']);
    } finally {
      await writer.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
    }
  });

  // A ledger restored onto a server that never ran migration 041 has the
  // migration recorded and no role.
  it('creates the role when the server lacks it', async () => { // 16, 18
    const role = scratchName('reader_probe_absent');
    scratchRoles.push(role);
    const lines: string[] = [];
    const client = await writer.connect();
    try {
      await restateReaders(client, { role, say: { log: (line) => lines.push(line), warn: (line) => lines.push(line) } });
    } finally {
      client.release();
    }
    expect(lines).toEqual([
      `created and restated ${role}, which the server lacked; READER_DATABASE_URL is not set, so its login is unchanged`,
    ]);
    // A later step that fails still names the role the restate created. // 18
    const late = scratchName('reader_probe_absent');
    scratchRoles.push(late);
    const { rows: [db] } = await writer.query<{ name: string }>('SELECT current_database() AS name');
    await writer.query(`GRANT CREATE ON DATABASE ${db!.name} TO PUBLIC`);
    const lateClient = await writer.connect();
    try {
      await expect(restateReaders(lateClient, { role: late }))
        .rejects.toThrow(new RegExp(`^the server lacked ${late}, so the restate created it\\. restating ${late} committed`));
    } finally {
      lateClient.release();
      await writer.query(`REVOKE CREATE ON DATABASE ${db!.name} FROM PUBLIC`);
    }
    const { rows } = await writer.query<{ rolcanlogin: boolean; rolconnlimit: number }>(
      'SELECT rolcanlogin, rolconnlimit FROM pg_roles WHERE rolname = $1',
      [role],
    );
    expect(rows).toEqual([{ rolcanlogin: false, rolconnlimit: 10 }]);
  });

  // A session of the readers' role can hold the restate's advisory key.
  it('stops waiting for a held lock, and says what holds it', async () => { // 12
    const { role, pool } = await scratchLogin('');
    await pool.end();
    const holder = await writer.connect();
    await holder.query('SELECT pg_advisory_lock(153041)');
    try {
      const client = await writer.connect();
      try {
        await expect(restateReaderRole(client, { role, lockTimeoutMs: 200 })).rejects.toThrow(
          /^restating reader_probe_[0-9a-f]+ failed and changed nothing: another session holds the migration lock/,
        );
        // A wait of 0 would wait for ever.
        await expect(restateReaderRole(client, { role, lockTimeoutMs: 0 })).rejects.toThrow(
          /lockTimeoutMs must be a whole number of milliseconds of 1 or more, got 0$/,
        );
      } finally {
        client.release();
      }
    } finally {
      await holder.query('SELECT pg_advisory_unlock(153041)');
      holder.release();
    }
  });

  // The verifier must be the one Postgres would store for the same password
  // and salt, or the login the console sends never matches it.
  it('builds the verifier Postgres builds', async () => { // 9
    const role = scratchName('reader_probe');
    scratchRoles.push(role);
    const client = await writer.connect();
    try {
      await client.query("SET password_encryption = 'scram-sha-256'");
      await client.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pencil'`);
    } finally {
      client.release();
    }
    const { rows } = await writer.query<{ rolpassword: string }>(
      'SELECT rolpassword FROM pg_authid WHERE rolname = $1',
      [role],
    );
    const stored = rows[0]!.rolpassword;
    const [, iterations, salt] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$/.exec(stored)!;
    expect(scramVerifier('pencil', Buffer.from(salt!, 'base64'), Number(iterations))).toBe(stored);
  });
});

describe('a bounded read', () => {
  // A source guard is not the barrier, so the read checks the session itself.
  it('refuses a session that can act beyond a read, before the read runs', async () => { // 6
    let ran = false;
    await expect(boundedRead(writer, 'test', 5_000, 6_000, async (query) => {
      ran = true;
      return query('SELECT 1');
    })).rejects.toThrow(/^test: refuses a session as '[^']+', which can act beyond a read/);
    expect(ran).toBe(false);
  });

  // The check names the readers' role: a role with no superuser right is
  // not it either, and a non-superuser writer that owns the tables is one.
  it('refuses a session as any other role, privileged or not', async () => { // 6
    const { pool } = await scratchLogin('');
    try {
      await expect(boundedRead(pool, 'test', 5_000, 6_000, (query) => query('SELECT 1')))
        .rejects.toThrow(/^test: refuses a session as 'reader_probe_[0-9a-f]+'/);
    } finally {
      await pool.end();
    }
  });

  // SET SESSION AUTHORIZATION changes session_user as well, so the check
  // reads the user the connection logged in as.
  it("refuses a superuser session that has taken the readers' role as its session user", async () => { // 6
    const single = new Pool({ connectionString: dbUrl(), max: 1 });
    try {
      const client = await single.connect();
      await client.query(`SET SESSION AUTHORIZATION ${READER_ROLE}`);
      client.release();
      await expect(boundedRead(single, 'test', 5_000, 6_000, (query) => query('SELECT 1')))
        .rejects.toThrow(/^test: refuses a session as '[^']+', which can act beyond a read/);
    } finally {
      await single.end();
    }
  });

  // Each clause of the check, asked of a role of this file's own: the
  // readers' role is the server's, and the other files read through it.
  it('passes the role it names, and refuses it with an attribute, a membership or an object', async () => { // 6
    const asks = async (grants: string, after?: (role: string) => Promise<void>): Promise<boolean | null> => {
      const { role, pool } = await scratchLogin(grants);
      try {
        await after?.(role);
        const { rows } = await pool.query<{ reader: boolean | null }>(SESSION_CHECK, [role]);
        return rows[0]!.reader;
      } finally {
        await pool.end();
      }
    };
    expect(await asks('')).toBe(true);
    expect(await asks('SUPERUSER')).toBe(false);
    expect(await asks('REPLICATION')).toBe(false);
    expect(await asks('BYPASSRLS')).toBe(false);
    expect(await asks('CREATEDB')).toBe(false);
    expect(await asks('CREATEROLE')).toBe(false);
    expect(await asks('', (role) => writer.query(`GRANT pg_read_all_stats TO ${role}`).then(() => undefined)))
      .toBe(false);
    const owned = scratchName('reader_probe_owned');
    try {
      expect(await asks('', async (role) => {
        await writer.query(`CREATE TABLE ${owned} (i int)`);
        await writer.query(`ALTER TABLE ${owned} OWNER TO ${role}`);
      })).toBe(false);
    } finally {
      await writer.query(`DROP TABLE IF EXISTS ${owned}`);
    }
  });

  // The console asks this at startup, so a wrong URL stops it there rather
  // than on each page.
  it("lets the console refuse a pool that is not the readers' role before it listens", async () => { // 6
    await expect(probeReaders(writer, 'the operator console'))
      .rejects.toThrow(/^the operator console: READER_DATABASE_URL: refuses a session as/);
    const { rows: [db] } = await writer.query<{ name: string }>('SELECT current_database() AS name');
    await expect(probeReaders(readers, 'the operator console'))
      .resolves.toMatchObject({ database: db!.name });
  });

  it("refuses a superuser session that has taken the readers' role", async () => { // 6
    const single = new Pool({ connectionString: dbUrl(), max: 1 });
    try {
      const client = await single.connect();
      await client.query('SET ROLE auracle_reader');
      client.release();
      await expect(boundedRead(single, 'test', 5_000, 6_000, (query) => query('SELECT 1')))
        .rejects.toThrow(/^test: refuses a session as '[^']+', which can act beyond a read/);
    } finally {
      await single.end();
    }
  });
});

describe('one ledger', () => {
  // Two URLs that each pass their own probe can still name two ledgers.
  it('lets the console refuse a readers\' pool on another ledger', async () => { // 7
    await expect(assertOneLedger(writer, readers, 'the operator console')).resolves.toBeUndefined();
    const other = await scratchDatabase();
    const elsewhere = new Pool({ connectionString: urlFor(readerDbUrl(), { database: other }), max: 1 });
    try {
      await expect(assertOneLedger(writer, elsewhere, 'the operator console')).rejects.toThrow(
        new RegExp(`^the operator console: READER_DATABASE_URL reaches the database '${other}'.*Both must name one ledger\\.$`),
      );
    } finally {
      await elsewhere.end();
    }
  });

  // A session's TimeZone and DateStyle format a timestamp's text, so the
  // check must not read one.
  it('takes one ledger as one, whatever the writer session formats times as', async () => { // 14
    const zoned = new Pool({ connectionString: dbUrl(), max: 1, options: '-c TimeZone=America/New_York -c DateStyle=SQL,DMY' });
    try {
      await expect(assertOneLedger(zoned, readers, 'the operator console')).resolves.toBeUndefined();
      const client = await zoned.connect();
      try {
        expect((await readerReach(client, readerDbUrl())).sameLedger).toBe(true);
      } finally {
        client.release();
      }
    } finally {
      await zoned.end();
    }
  });

  // The migrator's own steps after the restate, each with the state it names.
  it('has the migrator name why it stops and what it leaves', async () => { // 15
    const lines: string[] = [];
    const say = { log: (line: string) => lines.push(line), warn: (line: string) => lines.push(line) };
    const { role, pool } = await scratchLogin('');
    await pool.end();
    const asRole = (database?: string) => urlFor(readerDbUrl(), {
      user: role, password: 'pw-one', ...(database === undefined ? {} : { database }),
    });
    const client = await writer.connect();
    try {
      await restateReaders(client, { role, say });
      expect(lines).toEqual([`restated ${role}; READER_DATABASE_URL is not set, so its login is unchanged`]);

      lines.length = 0;
      await restateReaders(client, { role, say, credential: 'pw-one', readerUrl: asRole(), migratorUrl: dbUrl() });
      expect(lines[0]).toBe(`restated ${role}, which logs in with the password READER_DATABASE_URL names`);
      // The second line depends on the server's pg_hba: a test clone admits
      // the role on every server the suites run on.
      expect(lines.length).toBeGreaterThan(1);
      for (const line of lines.slice(1)) {
        expect(line).toMatch(new RegExp(`^${role} (can log in to |logs in to no other database)`));
      }

      // What the restate states and finds otherwise passes through as it is.
      const { rows: [db] } = await writer.query<{ name: string }>('SELECT current_database() AS name');
      await writer.query(`GRANT CREATE ON DATABASE ${db!.name} TO PUBLIC`);
      try {
        await expect(restateReaders(client, { role, say })).rejects.toBeInstanceOf(ReaderRightsLeft);
      } finally {
        await writer.query(`REVOKE CREATE ON DATABASE ${db!.name} FROM PUBLIC`);
      }

      // A URL that names another database is refused before the restate, so
      // the login keeps the password it had. // 17
      await expect(restateReaders(client, {
        role, say, credential: 'pw-three', readerUrl: asRole(await scratchDatabase()), migratorUrl: dbUrl(),
      })).rejects.toThrow(new RegExp(`^the migrations applied, and READER_DATABASE_URL names another host, port or database than DATABASE_URL, so ${role} was not restated and its login is unchanged`));
      const kept = new Pool({ connectionString: asRole(), max: 1 });
      try {
        await expect(kept.query('SELECT 1')).resolves.toBeDefined();
      } finally {
        await kept.end();
      }
      // A host name in another case is the same host.
      lines.length = 0;
      const spelled = new URL(asRole());
      spelled.hostname = spelled.hostname.toUpperCase();
      await restateReaders(client, { role, say, credential: 'pw-one', readerUrl: spelled.toString(), migratorUrl: dbUrl() });
      expect(lines[0]).toBe(`restated ${role}, which logs in with the password READER_DATABASE_URL names`);

      await expect(restateReaders(client, {
        role, say, credential: 'pw-two', readerUrl: asRole(), migratorUrl: dbUrl(),
      })).rejects.toThrow(new RegExp(`^the migrations applied, and ${role} was restated with its login\\. Checking where it can log in failed: ${role} cannot log in`));
    } finally {
      client.release();
    }
    // A migrator that is not a superuser is told so.
    const plain = await scratchLogin('');
    const plainClient = await plain.pool.connect();
    try {
      // The migration lock is the first thing it is refused, once a restate
      // has taken pg_advisory_lock from PUBLIC.
      await expect(restateReaders(plainClient, { role, say }))
        .rejects.toThrow(new RegExp(`^the migrations applied, and ${role} was not restated .*needs a superuser`));
      await expect(migrate(plainClient)).rejects.toThrow(/^nothing was migrated: .*needs a superuser/);
    } finally {
      plainClient.release();
      await plain.pool.end();
    }
  });

  it('names why the migrator cannot log in as the role', async () => { // 15
    const client = await writer.connect();
    try {
      await expect(readerReach(client, urlFor(readerDbUrl(), { password: 'wrong' })))
        .rejects.toThrow(/^auracle_reader cannot log in with READER_DATABASE_URL: password authentication failed/);
    } finally {
      client.release();
    }
  });

  // The migrator logs in as the role to see where it reaches. Every server
  // the suites run on admits a clone-named database, so this asserts what
  // holds on each; the compose stack's refusal of other names is the
  // runbook's to show.
  it('lets the migrator see the ledger and the other databases the role logs in to', async () => { // 7
    // A colon or a slash in a name must reach the server as it is.
    const plain = await scratchDatabase();
    const other = `${plain}:1/x`;
    scratchDatabases.push(`"${other}"`);
    await writer.query(`CREATE DATABASE "${other}"`);
    // A login the server lets in counts, even when the role cannot then say
    // which ledger it reached.
    const mute = await scratchDatabase();
    const muted = new Pool({ connectionString: urlFor(dbUrl(), { database: mute }), max: 1 });
    try {
      await muted.query('REVOKE EXECUTE ON FUNCTION pg_postmaster_start_time() FROM PUBLIC');
    } finally {
      await muted.end();
    }
    const client = await writer.connect();
    try {
      const here = await readerReach(client, readerDbUrl());
      expect(here.sameLedger).toBe(true);
      expect(here.otherDatabases).toContain(other);
      expect(here.otherDatabases).toContain(mute);
      expect(here.undetermined).toEqual([]);
      const there = await readerReach(client, urlFor(readerDbUrl(), { database: plain }));
      expect(there.sameLedger).toBe(false);
    } finally {
      client.release();
    }
  });

  it('holds the migration lock until it has checked the login', async () => { // 19, 20, 21
    const { role, pool } = await scratchLogin('');
    await pool.end();
    const say = { log: () => undefined, warn: () => undefined };
    const asRole = urlFor(readerDbUrl(), { user: role, password: 'pw-one' });
    // The restate's advisory key, as pg_locks shows a single bigint key.
    // Its own pool: the watcher and the other session must not wait behind
    // the migrator's connection for one of the writer's.
    const watcher = new Pool({ connectionString: dbUrl(), max: 2 });
    const held = async (pid: number) => (await watcher.query<{ held: boolean }>(
      `SELECT count(*) > 0 AS held FROM pg_locks
        WHERE locktype = 'advisory' AND classid = 0 AND objid = 153041 AND objsubid = 1 AND pid = $1 AND granted`,
      [pid],
    )).rows[0]!.held;
    const client = await writer.connect();
    const other = await watcher.connect();
    try {
      const { rows: [me] } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const real = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<unknown>;
      const atLogin: boolean[] = [];
      const atReach: boolean[] = [];
      const watched = new Proxy(client, {
        get(target, key, receiver) {
          if (key !== 'query') return Reflect.get(target, key, receiver);
          return async (text: unknown, values?: unknown[]) => {
            // At the login, and at the reach check after the role's own
            // login, which lists the databases it can reach.
            if (typeof text === 'string' && text.startsWith('ALTER ROLE') && text.includes('LOGIN PASSWORD')) {
              atLogin.push(await held(me!.pid));
            }
            if (typeof text === 'string' && text.startsWith('SELECT datname FROM pg_database WHERE datallowconn')) {
              atReach.push(await held(me!.pid));
            }
            return real(text as string, values);
          };
        },
      });
      await restateReaders(watched, { role, say, credential: 'pw-one', readerUrl: asRole, migratorUrl: dbUrl() });
      expect(atLogin).toEqual([true]);
      expect(atReach).toEqual([true]);
      expect(await held(me!.pid)).toBe(false);

      // A run that fails gives the lock back too.
      const { rows: [db] } = await writer.query<{ name: string }>('SELECT current_database() AS name');
      await writer.query(`GRANT CREATE ON DATABASE ${db!.name} TO PUBLIC`);
      try {
        await expect(restateReaders(client, { role, say })).rejects.toBeInstanceOf(ReaderRightsLeft);
      } finally {
        await writer.query(`REVOKE CREATE ON DATABASE ${db!.name} FROM PUBLIC`);
      }
      expect(await held(me!.pid)).toBe(false);

      // While another session holds it, the migrator waits, then stops
      // before it restates anything.
      await other.query('SELECT pg_advisory_lock(153041)');
      try {
        await expect(restateReaders(client, {
          role, say, credential: 'pw-two', readerUrl: asRole, migratorUrl: dbUrl(), lockTimeoutMs: 200,
        })).rejects.toThrow(new RegExp(
          `^the migrations applied, and ${role} was not restated and its login is unchanged: another session `
            + `holds the migration lock, perhaps another migrator or a session of ${role}; a rerun succeeds once `
            + 'that session ends',
        ));
      } finally {
        await other.query('SELECT pg_advisory_unlock(153041)');
      }

      // A migrator that waits restates once the other session lets go.
      await other.query('SELECT pg_advisory_lock(153041)');
      const waiting = restateReaders(client, {
        role, say, credential: 'pw-one', readerUrl: asRole, migratorUrl: dbUrl(), lockTimeoutMs: 10_000,
      });
      let settled = false;
      void waiting.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      await other.query('SELECT pg_advisory_unlock(153041)');
      await expect(waiting).resolves.toBeUndefined();
      const kept = new Pool({ connectionString: asRole, max: 1 });
      try {
        await expect(kept.query('SELECT 1')).resolves.toBeDefined();
      } finally {
        await kept.end();
      }
    } finally {
      other.release();
      client.release();
      await watcher.end();
    }
  });

  it('stops the migrator before any file when the readers\' URL is bad', async () => { // 8, 15
    const empty = await scratchDatabase();
    const run = spawnSync(
      process.execPath,
      [`${REPO_ROOT}node_modules/tsx/dist/cli.mjs`, `${REPO_ROOT}src/ledger/migrate.ts`],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL: urlFor(dbUrl(), { database: empty }),
          READER_DATABASE_URL: urlFor(readerDbUrl(), { user: 'auracle', database: empty }),
        },
      },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/READER_DATABASE_URL names the user 'auracle'; it must name auracle_reader.*, so nothing was migrated\./);
    // A URL that names another database stops it before any file too.
    const elsewhere = spawnSync(
      process.execPath,
      [`${REPO_ROOT}node_modules/tsx/dist/cli.mjs`, `${REPO_ROOT}src/ledger/migrate.ts`],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_URL: urlFor(dbUrl(), { database: empty }),
          READER_DATABASE_URL: urlFor(readerDbUrl(), { database: await scratchDatabase() }),
        },
      },
    );
    expect(elsewhere.status).toBe(1);
    expect(elsewhere.stderr).toContain(
      'READER_DATABASE_URL names another host, port or database than DATABASE_URL, so nothing was migrated',
    );
    // A writer's URL the driver cannot read is named as that.
    const unreadable = spawnSync(
      process.execPath,
      [`${REPO_ROOT}node_modules/tsx/dist/cli.mjs`, `${REPO_ROOT}src/ledger/migrate.ts`],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: 'postgres://auracle:x@localhost:abc/auracle' },
      },
    );
    expect(unreadable.status).toBe(1);
    expect(unreadable.stderr).toMatch(/DATABASE_URL could not be read: .+, so nothing was migrated/);
    expect(unreadable.stderr).not.toContain(':x@');
    const target = new Pool({ connectionString: urlFor(dbUrl(), { database: empty }), max: 1 });
    try {
      const { rows } = await target.query<{ tables: number }>(
        "SELECT count(*)::int AS tables FROM pg_tables WHERE schemaname = 'public'",
      );
      expect(rows[0]!.tables).toBe(0);
    } finally {
      await target.end();
    }
  });
});
