# The readers connect as their own role

## Problem

The console's readers and the latency report run each read in one READ ONLY
transaction. Source guards hold each reader to that path. The guards catch
a mistake in ordinary code. They do not stop code that someone writes to evade
them.

Each process connects with one role, and in the compose stack that role is a
superuser. READ ONLY refuses a write to a table, and nothing else. Under a
superuser a read can end another session or write rows to the catalog. It can
also create a replication slot or a replication origin. Four readers build their
statements at runtime, so no source guard reads them.

Some of these rights belong to every role, not only to a superuser. PUBLIC can
cancel or end a session of the same role. It can write a message to the WAL,
create a large object and create a temporary table.

## Proposed outcome

The readers connect as `auracle_reader`, a role that cannot do these things. A
read that tries one fails at the database, whatever the source says.

- Migration 041 creates the role without a login, and nothing more. The
  restate creates it too when the server lacks it.
- `pnpm run db:migrate` restates the role after every run. It strips every
  attribute beyond a login, and every setting. It removes every membership,
  whoever granted it, and any grant the role made from one. It limits the role
  to 10 connections and to 1 GB of temporary files per process.
- The restate grants the role CONNECT on the ledger and USAGE on `public`.
  It grants SELECT on the twelve tables the readers read. It never gives an
  object the role owns to another role.
- In the ledger's database, the restate revokes some rights from PUBLIC.
  These are the WAL message, session signal, large object and advisory lock
  functions.
  They are also CREATE on the `public` schema and TEMP. No process in this
  repository uses them.
- The restate commits, then reads back what it states. A difference fails the
  migration and names it, and so does an object the role owns. The migrator
  sets the login only after a clean read-back.
- `pg_hba.conf` lets the role log in to the ledger's database and no other.
  In a checkout the compose rule also admits the databases a test run clones.
  The deploy overlay admits the ledger alone, and the runbook gives the rule
  for any other server.
- With `READER_DATABASE_URL` set, `db:migrate` also gives the role its login.
  First it refuses a URL that names another host, port or database than
  `DATABASE_URL`, or a weaker TLS setting. It connects nowhere to decide.
  A migration lock makes two migrators on one ledger run in turn. It sends the server a
  SCRAM verifier, never the password. Then it logs in as the role and checks
  the server it reaches. It warns about each other database that admits the
  role through that URL's host.
- `boundedRead` checks the session in the statement that sets its bounds. It
  refuses the read unless the login user and the session user are both
  `auracle_reader`. The role must also hold no membership, no attribute
  beyond a login, and no object. So the check refuses a superuser that takes
  the readers' role.
- The console opens a second pool from `READER_DATABASE_URL` for the twelve
  readers. It refuses to start without the variable. It also refuses a pool
  that is not the readers' role, or that reaches another ledger. The latency
  report connects through the same variable.

## Affected users and systems

- The console, which needs `READER_DATABASE_URL` beside `DATABASE_URL`.
- `pnpm run latency`, which needs `READER_DATABASE_URL` in place of
  `DATABASE_URL`.
- `pnpm run db:migrate`, which now needs a superuser. It restates the role on
  every run and sets the role's login.
- The compose overlay and the deploy, which pass the URL to the migration and
  the console. The compose Postgres reads the `pg_hba.conf` rule.
- Operators, who supply the role's password.
- Any role on the ledger's database that is not a superuser. It loses the
  rights that `db:migrate` revokes from PUBLIC.

## Constraints

- A reader returns what it returned before. Only the role it connects as
  changes.
- The console's writes keep their own pool and their own role.
- A read that does not go through `boundedRead` keeps the console's own pool.
- The repository holds no credential. The compose default is a local value,
  and the runbook says to replace it on a host that serves traffic.
- The role is the barrier against code that holds the readers' URL or pool.
  It is not a barrier against a superuser who grants it more by hand. The
  restate does not look for every right such a person can grant.
- A Postgres role belongs to the whole server. Two ledgers on one server share
  the readers' role and its password, and each keeps its own CONNECT grant.
- Some effects stay open to the role, and Postgres bounds them. A read can
  take a transaction ID. It can raise its own statement timeout, and the
  connection limit bounds how many such queries run at once.
- The role can change its own password, its own settings and its default
  rights. Postgres lets every role do so. The next migration resets the
  settings. With `READER_DATABASE_URL` set, it resets the password too.
- Nothing bounds a lock, a snapshot or a held notification queue. A session
  of the role can keep each open outside a read, and a person ends it.

## Decisions affected

Affects: DEC-04, DEC-40, DEC-44

DEC-04. The ledger gains a role for its readers, and every read through
`boundedRead` runs as that role. The ledger's writes keep their own role.

DEC-40 lets a read-only operator console approve a parked action. This change
makes the console's readers read-only in the database's rights, not only in
their transaction. A superuser's effects that READ ONLY lets through now fail.

DEC-44 makes the console write on every adapter. Those writes keep the
console's own pool, so no write runs as the readers' role.

## Open questions

None.
