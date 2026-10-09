// The readers' role, restated on every migration (DEC-04).
//
// Migration 041 creates `auracle_reader` and nothing more. The rest is stated
// here and restated on every migration: its attributes, limits and settings,
// no membership, the rights it holds, the rights PUBLIC holds that would let
// it act beyond a read, and its login.
//
// The role is the barrier against code that holds the readers' URL or pool.
// It is not a barrier against a superuser who grants it more by hand.
//
// Run by `pnpm run db:migrate` after the migrations, and by the test harness.
// Each statement needs a superuser: on PostgreSQL 16 nothing less can strip a
// role's attributes or revoke a predefined role.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

import pg from 'pg';
import type { PoolClient } from 'pg';

import { errorMessage } from '../errors.js';
import { LEDGER_IDENTITY, type LedgerIdentity } from '../db/probe-readers.js';
import { driverParameters } from '../db/driver-parameters.js';
import { READER_ROLE } from '../db/reader-role-name.js';

export { READER_ROLE };

/**
 * The connections the role may hold at once, across the server: the
 * console's pool of four, the latency report, and headroom. A read that turns
 * off its own statement timeout leaves its query running when the client gives
 * up, and this bounds how many such queries can pile up.
 */
export const READER_CONNECTION_LIMIT = 10;

/**
 * The temp-file space one process may use; a parallel query has several. A
 * read cannot change it.
 */
const READER_TEMP_FILE_LIMIT = '1GB';

/**
 * The tables the readers read, which the restate grants the role SELECT on. A
 * reader that needs another table adds it here. The restate takes back no
 * other grant: a grant someone adds by hand is outside it.
 */
export const READER_TABLES: readonly string[] = [
  'case_hold', 'case_hold_event', 'conversation', 'document', 'document_rerun', 'gate_latest',
  'intake', 'outbox', 'reviewer', 'run', 'step_journal', 'turn',
];

/**
 * Functions PUBLIC may execute by default that act beyond a read: writing to
 * the WAL, signalling a session, writing large objects, and advisory locks.
 * A session of the role holding the migration lock would stop every
 * migration for as long as it stayed open. Postgres cannot
 * take a right from one role that PUBLIC grants, so they are revoked from
 * PUBLIC in the ledger's database. No code in this repository calls them, and
 * a superuser keeps every right.
 */
const PUBLIC_FUNCTIONS = [
  'pg_logical_emit_message', 'pg_cancel_backend', 'pg_terminate_backend',
  'lo_create', 'lo_creat', 'lo_from_bytea', 'lo_put', 'lowrite', 'lo_truncate', 'lo_truncate64',
  'pg_advisory_lock', 'pg_advisory_lock_shared', 'pg_try_advisory_lock', 'pg_try_advisory_lock_shared',
  'pg_advisory_xact_lock', 'pg_advisory_xact_lock_shared', 'pg_try_advisory_xact_lock',
  'pg_try_advisory_xact_lock_shared',
];

/**
 * Serialises two migrators restating the role from one database. An advisory
 * lock belongs to its database, so it does not serialise two ledgers on one
 * server: the second of two such runs at once can fail, and a rerun succeeds.
 */
const RESTATE_LOCK = 153_041;

/**
 * Takes the migration lock for this session: the restate's key, held from
 * the first file to the last, or from the restate until the login is
 * checked. A second migrator waits. The restate takes the same key in its
 * own transaction, which this session already holds. The lock wait is
 * bounded, and the session's own lock_timeout is put back after it.
 *
 * A failure throws the driver's error. The caller names the state it leaves,
 * and `whyLocked` names a held lock.
 */
export async function acquireRestateLock(client: PoolClient, lockTimeoutMs = 30_000): Promise<void> {
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
    throw new Error(`lockTimeoutMs must be a whole number of milliseconds of 1 or more, got ${lockTimeoutMs}`);
  }
  const { rows: [prior] } = await client.query<{ value: string }>("SELECT current_setting('lock_timeout') AS value");
  try {
    await client.query("SELECT set_config('lock_timeout', $1, false)", [`${lockTimeoutMs}ms`]);
    await client.query('SELECT pg_advisory_lock($1)', [RESTATE_LOCK]);
  } finally {
    // A lost connection fails this too, and the session ends with it.
    await client.query("SELECT set_config('lock_timeout', $1, false)", [prior!.value]).catch(() => undefined);
  }
}

/**
 * The cause of a failed acquireRestateLock when another session holds the
 * key, or nothing. The lock wait is the one statement there that can wait,
 * so a statement timeout (57014) ends it too. A session of the readers' role
 * held the key before a restate revoked pg_advisory_lock from PUBLIC.
 */
export function whyLocked(error: unknown, role: string): string {
  const code = (error as { code?: string }).code;
  return code === '55P03' || code === '57014'
    ? `another session holds the migration lock, perhaps another migrator or a session of ${role}; `
      + 'a rerun succeeds once that session ends: '
    : '';
}

/**
 * Gives back the lock acquireRestateLock took. A failure is not reported:
 * the lock ends with the session, and the migrator ends its session next.
 */
export async function releaseRestateLock(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_unlock($1)', [RESTATE_LOCK]).catch(() => undefined);
}

/** What the restate did that its caller reports. */
export interface RestateResult {
  /** True when the server lacked the role and the restate created it. */
  readonly created: boolean;
}

export interface RestateOptions {
  /** The role to restate. A test restates a role of its own. */
  readonly role?: string;
  readonly connectionLimit?: number;
  /** The password to log in with, from READER_DATABASE_URL. Absent leaves the login as it is. */
  readonly credential?: string;
  /** How long the restate waits for its lock. A test shortens it. */
  readonly lockTimeoutMs?: number;
}

/**
 * The credential READER_DATABASE_URL carries, checked before anything is
 * migrated, so a bad URL fails the run before it applies a file.
 *
 * The user and password are the driver's own reading of the URL, so the
 * verifier built here matches the password the console sends. Refuses a URL
 * that names another user, that sets the user or password in its query, or
 * whose password is not printable ASCII: Postgres prepares a non-ASCII
 * password before it hashes it.
 */
export function readerCredential(readerUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(readerUrl);
  } catch {
    throw new Error('READER_DATABASE_URL is not a connection URL of the form postgres://auracle_reader:<password>@host:port/database');
  }
  if (parsed.searchParams.has('user') || parsed.searchParams.has('password')) {
    throw new Error('READER_DATABASE_URL names its user or password in its query; name them before the host instead');
  }
  try {
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch {
    throw new Error('READER_DATABASE_URL holds a % that starts no escape; percent-encode the password');
  }
  // The driver fills a user or password the URL leaves out from PGUSER and
  // PGPASSWORD, which may be the migrator's own. The URL must carry both.
  if (parsed.username === '' || parsed.password === '') {
    throw new Error(`READER_DATABASE_URL carries no user or no password for ${READER_ROLE} to log in with`);
  }
  const user = decodeURIComponent(parsed.username);
  const credential = decodeURIComponent(parsed.password);
  if (user !== READER_ROLE) {
    throw new Error(`READER_DATABASE_URL names the user '${user}'; it must name ${READER_ROLE}`);
  }
  // The console connects through the driver, so the login is set only when
  // the driver reads the same user and password. It reads some URLs apart:
  // one with a space or a % that starts no escape, or with a leading space.
  let driver: { user: string; password: string | null | undefined };
  try {
    driver = driverParameters(readerUrl);
  } catch (error) {
    throw new Error(`READER_DATABASE_URL could not be read: ${errorMessage(error)}`);
  }
  if (driver.user !== user || driver.password !== credential) {
    throw new Error(
      'READER_DATABASE_URL is read differently by the Postgres driver; keep spaces and a % that starts no '
        + 'escape out of it, and percent-encode the password',
    );
  }
  if (!/^[\x20-\x7e]+$/.test(credential)) {
    throw new Error('READER_DATABASE_URL carries a password with a character outside printable ASCII');
  }
  return credential;
}

/**
 * The SCRAM-SHA-256 verifier Postgres stores for `credential`.
 *
 * The server receives the verifier and never the password, so neither its log
 * nor its view of running statements can show the password. The format is the
 * one Postgres writes itself, RFC 5803.
 */
export function scramVerifier(credential: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(credential, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/**
 * Takes TEMP on one database from PUBLIC. A database cloned from a template
 * does not copy the template's rights, so the test harness calls this on each
 * clone, as the restate does on the ledger.
 */
export async function revokeTempFromPublic(client: Pick<PoolClient, 'query'>, database: string): Promise<void> {
  const { rows } = await client.query<{ text: string }>(
    "SELECT format('REVOKE TEMP ON DATABASE %I FROM PUBLIC', $1::text) AS text",
    [database],
  );
  await client.query(rows[0]!.text);
}

/**
 * What the restate states and found otherwise in the ledger's database after
 * it committed. The role's login is unchanged.
 */
export class ReaderRightsLeft extends Error {
  constructor(role: string, readonly rights: readonly string[]) {
    super(
      `restating ${role} committed, and left it in a state the restate does not state: ${rights.join('; ')}. `
        + 'Its login is unchanged. A right PUBLIC holds, a membership or an object the role owns needs a '
        + 'person: revoke the right or membership, or drop the object or give it to its proper owner. A right '
        + 'the role lacks ("no ...") needs a person to find what revoked it. An attribute or limit another '
        + 'session changed, or a setting the role changed for itself, clears on a rerun once those sessions '
        + 'end. Then migrate again.',
    );
    this.name = 'ReaderRightsLeft';
  }
}

/**
 * Restates the role, commits, then reads back what it stated.
 *
 * The role is the barrier against code that holds the readers' URL or pool. It
 * is not a barrier against a superuser who grants the role more by hand: the
 * restate takes back the attributes, settings and memberships such a person
 * could add, and states the role's own rights, but it does not hunt for every
 * other grant Postgres allows.
 *
 * Postgres answers a REVOKE that matched nothing with a warning, and the
 * driver drops warnings, so what the restate states is read back after the
 * commit. A difference throws ReaderRightsLeft, and the login is set only
 * after a clean read-back.
 */
export async function restateReaderRole(client: PoolClient, options: RestateOptions = {}): Promise<RestateResult> {
  const role = options.role ?? READER_ROLE;
  const limit = options.connectionLimit ?? READER_CONNECTION_LIMIT;
  const lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 1) {
    throw new Error(`restating ${role}: lockTimeoutMs must be a whole number of milliseconds of 1 or more, got ${lockTimeoutMs}`);
  }
  const sql = async (template: string, ...values: unknown[]): Promise<void> => {
    const { rows } = await client.query<{ text: string }>(`SELECT format(${template}) AS text`, values);
    await client.query(rows[0]!.text);
  };

  let created = false;
  let committing = false;
  try {
    await client.query('BEGIN');
    // A session of the readers' role can take the same advisory key, so the
    // wait is bounded and a held key fails the run rather than hanging it.
    await sql("'SET LOCAL lock_timeout = %L', $1::text", `${lockTimeoutMs}ms`);
    await client.query('SELECT pg_advisory_xact_lock($1)', [RESTATE_LOCK]);
    // Migration 041 created the role on the server it ran on. A ledger
    // restored onto another server has 041 recorded and no role, so the
    // restate creates it when it is absent.
    const { rows: [present] } = await client.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS present',
      [role],
    );
    created = !present!.present;
    if (created) await sql("'CREATE ROLE %I NOLOGIN', $1::text", role);
    await sql(
      "'ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT %s', $1::text, $2::int",
      role, limit,
    );
    // Every setting, for the role and per database, then the one the role
    // keeps. A per-database setting would override the role's own.
    await sql("'ALTER ROLE %I RESET ALL', $1::text", role);
    const perDatabase = await client.query<{ datname: string }>(
      `SELECT d.datname FROM pg_db_role_setting s
         JOIN pg_database d ON d.oid = s.setdatabase
        WHERE s.setrole = $1::regrole`,
      [role],
    );
    for (const { datname } of perDatabase.rows) {
      await sql("'ALTER ROLE %I IN DATABASE %I RESET ALL', $1::text, $2::text", role, datname);
    }
    await sql("'ALTER ROLE %I SET temp_file_limit = %L', $1::text, $2::text", role, READER_TEMP_FILE_LIMIT);
    // A REVOKE without GRANTED BY takes back only the grants the current user
    // made, so each membership names the role that granted it. CASCADE takes
    // back any grant the role made onward with an admin option.
    const memberships = await client.query<{ name: string; grantor: string }>(
      `SELECT m.roleid::regrole::text AS name, m.grantor::regrole::text AS grantor
         FROM pg_auth_members m WHERE m.member = $1::regrole`,
      [role],
    );
    for (const { name, grantor } of memberships.rows) {
      await sql(`'REVOKE %s FROM %I GRANTED BY %s CASCADE', $1::text, $2::text, $3::text`, name, role, grantor);
    }
    // The rights the role holds: to connect to the ledger, and to read the
    // tables the readers read.
    await sql("'GRANT CONNECT ON DATABASE %I TO %I', current_database(), $1::text", role);
    await sql("'GRANT USAGE ON SCHEMA public TO %I', $1::text", role);
    for (const table of READER_TABLES) {
      await sql("'GRANT SELECT ON TABLE public.%I TO %I', $1::text, $2::text", table, role);
    }
    // What PUBLIC holds that acts beyond a read: the functions above, CREATE
    // on the public schema (a database made before PostgreSQL 15 still grants
    // it), and TEMP on the database.
    const functions = await client.query<{ signature: string }>(
      `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p
        WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname = ANY($1::text[])`,
      [PUBLIC_FUNCTIONS],
    );
    for (const { signature } of functions.rows) {
      await client.query(`REVOKE EXECUTE ON FUNCTION ${signature} FROM PUBLIC`);
    }
    await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    const { rows: [current] } = await client.query<{ name: string }>('SELECT current_database() AS name');
    await revokeTempFromPublic(client, current!.name);
    committing = true;
    await client.query('COMMIT');
  } catch (error) {
    let rollbackFault = '';
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      rollbackFault = errorMessage(rollbackError) || 'an unnamed error';
    });
    const code = (error as { code?: string }).code;
    const why = code === '55P03'
      ? `another session holds the migration lock or a row it needs, perhaps a session of ${role}; `
        + 'a rerun succeeds once that session ends: '
      : '';
    // A commit that failed off the server, such as a lost connection or a
    // client timeout, may follow the commit. A ROLLBACK after it succeeds
    // with a warning, so its success proves nothing.
    if (rollbackFault === '' && committing && !(error instanceof pg.DatabaseError)) {
      throw Object.assign(
        new Error(`restating ${role} failed, and whether it committed is unknown; a rerun is safe: ${errorMessage(error)}`),
        { code },
      );
    }
    if (rollbackFault === '') {
      throw Object.assign(new Error(`restating ${role} failed and changed nothing: ${why}${errorMessage(error)}`), { code });
    }
    throw Object.assign(
      new Error(
        `restating ${role} failed, and whether it committed is unknown; a rerun is safe: ${why}${errorMessage(error)}. `
          + `Its rollback failed too: ${rollbackFault}`,
      ),
      { code, rollbackFailed: true },
    );
  }

  try {
    await readBackAndLogin(client, role, limit, lockTimeoutMs, options.credential, sql);
  } catch (error) {
    // The role was committed before this failed, so a role the restate
    // created is named with it.
    if (created && error instanceof Error) {
      error.message = `the server lacked ${role}, so the restate created it. ${error.message}`;
    }
    throw error;
  }
  return { created };
}

/** After the commit: reads back what the restate states, then sets the login. */
async function readBackAndLogin(
  client: PoolClient,
  role: string,
  limit: number,
  lockTimeoutMs: number,
  credential: string | undefined,
  sql: (template: string, ...values: unknown[]) => Promise<void>,
): Promise<void> {
  let left: string[];
  try {
    left = await whatItStatesOtherwise(client, role, limit);
  } catch (error) {
    throw Object.assign(
      new Error(
        `${role} was restated and committed, and reading it back failed, so its login is unchanged. `
          + `A rerun is safe: ${errorMessage(error)}`,
      ),
      { code: (error as { code?: string }).code },
    );
  }
  if (left.length > 0) throw new ReaderRightsLeft(role, left);
  if (credential !== undefined) {
    try {
      await client.query('BEGIN');
      await sql("'SET LOCAL lock_timeout = %L', $1::text", `${lockTimeoutMs}ms`);
      await sql("'ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text", role, scramVerifier(credential));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (error as { code?: string }).code;
      // Only the server's own refusal proves nothing committed. Any other
      // fault, a lost connection among them, can follow a commit.
      const state = error instanceof pg.DatabaseError ? 'its login is unchanged' : 'its login may have changed';
      throw Object.assign(
        new Error(
          `${role} was restated, committed and read back clean, and setting its login failed, so ${state}. `
            + `A rerun is safe: ${errorMessage(error)}`,
        ),
        { code },
      );
    }
  }
}

/**
 * Each object the role owns in this database or on the server, described. A
 * default right the role set is a default right, not an object.
 */
async function ownedHere(client: PoolClient, role: string): Promise<string[]> {
  const { rows } = await client.query<{ what: string }>(
    `SELECT pg_describe_object(s.classid, s.objid, s.objsubid) AS what
       FROM pg_shdepend s
      WHERE s.refobjid = $1::regrole AND s.deptype = 'o'
        AND s.classid <> 'pg_default_acl'::regclass
        AND (s.dbid = 0 OR s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database()))
      ORDER BY 1`,
    [role],
  );
  return rows.map(({ what }) => what);
}

/**
 * Each thing the restate states that the database reports otherwise. Empty
 * when the restate did what it says. It reads back only what the restate
 * states, and that the role owns nothing here.
 */
async function whatItStatesOtherwise(client: PoolClient, role: string, limit: number): Promise<string[]> {
  const left = (await ownedHere(client, role)).map((what) => `ownership of ${what}`);
  const { rows: [attributes] } = await client.query<{
    rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolreplication: boolean;
    rolbypassrls: boolean; rolconnlimit: number; rolconfig: string[] | null;
  }>(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit, rolconfig
       FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  for (const attribute of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'] as const) {
    if (attributes![attribute]) left.push(attribute);
  }
  if (attributes!.rolconnlimit !== limit) left.push(`a connection limit of ${attributes!.rolconnlimit}`);
  if (JSON.stringify(attributes!.rolconfig) !== JSON.stringify([`temp_file_limit=${READER_TEMP_FILE_LIMIT}`])) {
    left.push(`the settings ${JSON.stringify(attributes!.rolconfig)}`);
  }
  const { rows } = await client.query<{ what: string }>(
    `SELECT 'a membership in ' || m.roleid::regrole::text AS what
       FROM pg_auth_members m WHERE m.member = $1::regrole
     UNION ALL
     SELECT 'a setting in database ' || d.datname
       FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
      WHERE s.setrole = $1::regrole
     UNION ALL
     SELECT 'EXECUTE on ' || p.oid::regprocedure::text
       FROM pg_proc p
      WHERE p.pronamespace = 'pg_catalog'::regnamespace AND p.proname = ANY($2::text[])
        AND has_function_privilege($1, p.oid, 'EXECUTE')
     UNION ALL
     SELECT 'TEMP or CREATE on database ' || current_database()
      WHERE has_database_privilege($1, current_database(), 'TEMP')
         OR has_database_privilege($1, current_database(), 'CREATE')
     UNION ALL
     SELECT 'CREATE on schema public'
      WHERE has_schema_privilege($1, 'public', 'CREATE')
     UNION ALL
     SELECT 'no CONNECT on database ' || current_database()
      WHERE NOT has_database_privilege($1, current_database(), 'CONNECT')
     UNION ALL
     SELECT 'no USAGE on schema public'
      WHERE NOT has_schema_privilege($1, 'public', 'USAGE')
     UNION ALL
     SELECT 'no SELECT on public.' || t
       FROM unnest($3::text[]) t
      WHERE to_regclass('public.' || quote_ident(t)) IS NULL
         OR NOT has_table_privilege($1, ('public.' || quote_ident(t))::regclass, 'SELECT')`,
    [role, PUBLIC_FUNCTIONS, READER_TABLES],
  );
  for (const { what } of rows) left.push(what);
  return left;
}

export interface ReaderReach {
  /** False when READER_DATABASE_URL names another database or server than the migrator's. */
  readonly sameLedger: boolean;
  /** The other databases on this server the role logged in to. */
  readonly otherDatabases: string[];
  /** Other databases where the login failed for a reason other than a refusal, with that reason. */
  readonly undetermined: string[];
}

/**
 * Logs in as the role with READER_DATABASE_URL, and reports where it can.
 *
 * The rights the restate takes away are taken in the ledger's database only.
 * A login to another database on the server gets PUBLIC's rights there, so
 * pg_hba must refuse it. This measures whether it does, by trying. It stops
 * at the first login when that reaches another ledger, so the password goes
 * to no further database there.
 */
export async function readerReach(client: PoolClient, readerUrl: string): Promise<ReaderReach> {
  const { rows: [ledger] } = await client.query<LedgerIdentity>(LEDGER_IDENTITY);
  const reader = await tryReaderLogin(readerUrl);
  if (reader.identity === undefined) {
    const who = driverParameters(readerUrl).user;
    throw new Error(
      reader.admitted
        ? `${who} logged in with READER_DATABASE_URL and could not read which ledger it reached: ${reader.fault}`
        : `${who} cannot log in with READER_DATABASE_URL: ${reader.fault}`,
    );
  }
  const sameLedger = reader.identity.database === ledger!.database && reader.identity.started === ledger!.started;
  if (!sameLedger) return { sameLedger, otherDatabases: [], undetermined: [] };
  const { rows } = await client.query<{ datname: string }>(
    'SELECT datname FROM pg_database WHERE datallowconn AND datname <> current_database() ORDER BY datname',
  );
  const otherDatabases: string[] = [];
  const undetermined: string[] = [];
  for (const { datname } of rows) {
    const login = await tryReaderLogin(readerUrl, datname);
    if (login.admitted) otherDatabases.push(datname);
    else if (loginOutcome(login.code) === 'unknown') undetermined.push(`${datname} (${login.fault})`);
  }
  return { sameLedger, otherDatabases, undetermined };
}

/**
 * What a failed login says about where the role can log in. pg_hba's
 * refusal, a database that is gone, and a missing CONNECT right each mean it
 * cannot. Anything else, a full connection limit or a timeout among them,
 * decides nothing.
 */
export function loginOutcome(code: string | undefined): 'refused' | 'unknown' {
  return code === '28000' || code === '3D000' || code === '42501' ? 'refused' : 'unknown';
}

interface Login {
  /** True when the server let the role in, whatever happened next. */
  readonly admitted: boolean;
  readonly identity?: LedgerIdentity | undefined;
  readonly code?: string | undefined;
  readonly fault?: string | undefined;
}

/**
 * One login as the role, to the URL's database or to `database`. The driver
 * reads every field from a URL ahead of a field beside it, so another
 * database is set on the parameters the driver parsed, never written into
 * the URL, where a name with a colon or a slash would come back changed.
 */
async function tryReaderLogin(url: string, database?: string): Promise<Login> {
  const parsed = driverParameters(url);
  const reader = new pg.Client({
    user: parsed.user, password: parsed.password ?? '', host: parsed.host, port: parsed.port,
    ssl: parsed.ssl, ...(parsed.options === undefined ? {} : { options: parsed.options }),
    database: database ?? parsed.database,
    connectionTimeoutMillis: 5_000,
    // A login that stalls after it connects decides nothing; it does not hang.
    query_timeout: 5_000,
  });
  // An error after connect would otherwise reach the process unhandled.
  reader.on('error', () => undefined);
  try {
    await reader.connect();
  } catch (error) {
    return { admitted: false, code: (error as { code?: string }).code, fault: errorMessage(error) };
  }
  try {
    const { rows } = await reader.query<LedgerIdentity>(LEDGER_IDENTITY);
    return { admitted: true, identity: rows[0] };
  } catch (error) {
    // Let in, and unable to say where: still a login the role should not have.
    return { admitted: true, code: (error as { code?: string }).code, fault: errorMessage(error) };
  } finally {
    await reader.end().catch(() => undefined);
  }
}
