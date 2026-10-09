// The only write path to `step_journal` (section 4.2, DEC-04).
//
// Four modules wrote this table, with three different column lists and three
// different spellings of the same insert. `src/coordinator/coordinator.ts`
// held two closures over the run id; `consumer.ts`, `relay/relay.ts` and
// `seed/write.ts` each open-coded a statement. A column added to the table
// had to be found in four places, and a writer that forgot one wrote a row
// the readers could not explain.
//
// One column list exists here. Three entry points use it, because the
// writers are three shapes and not one:
//
//   journalStart   the write-before-act row: the step says what it is about
//                  to do, and `result` stays null until it knows.
//   journalFinish  the outcome of a step `journalStart` opened.
//   journalStep    one row, complete when written. The callers outside the
//                  coordinator never journal an intent: each records a step
//                  that already happened, inside a transaction that is
//                  committing the rest of it.
//
// Forcing those three into start-then-finish would put a second statement
// inside `consumer.ts` and `relay.ts`'s open transactions and change what they
// commit, which the step split lists as a non-goal.
//
// DEC-28 is not weakened here and not extended here. `step_journal` carries
// no epoch column: the fence lives on `run` and `outbox`, through
// `ticket_epoch`, and `src/ledger/insert.ts` owns it. A journal row is
// reachable only through its `run_id`, so the fenced write that created the
// run is what admits it.
import type { Pool, PoolClient } from 'pg';

/**
 * A pool, or a client already inside a transaction.
 *
 * Six of the seven callers journal inside an open transaction and must not
 * take a second connection: a `Pool` would deadlock against rows their own
 * uncommitted transaction holds. `src/ledger/journal-writers.test.ts` names
 * each caller and the handle it passes.
 */
export type JournalDb = Pool | PoolClient;

/**
 * The column list, in order. Every insert names all seven.
 *
 * `result` is nullable by design — `db/006_ledger_constraints.sql:49` records
 * why: it is null between the write-before-act entry and the outcome. The
 * other six are NOT NULL on any migrated ledger (`db/006` lines 29-31 and
 * 35-47), so each writer supplies them.
 */
export const JOURNAL_COLUMNS = [
  'run_id',
  'step_id',
  'status',
  'result',
  'prompt_ver',
  'model_ver',
  'cost_micros',
] as const;

/**
 * The insert, built from the one list.
 *
 * `ifAbsent` appends `ON CONFLICT (run_id, step_id) DO NOTHING`, which the
 * relay needs and nobody else does: it journals an `escalate` row per
 * escalation and a repeat must keep the first reason rather than raise a
 * duplicate key. The default is off, because a coordinator step that wrote
 * twice is a defect and silence would hide it.
 */
export function journalInsertStatement(ifAbsent = false): string {
  const placeholders = JOURNAL_COLUMNS
    .map((column, index) => (column === 'result' ? `$${index + 1}::jsonb` : `$${index + 1}`))
    .join(', ');
  return `INSERT INTO step_journal (${JOURNAL_COLUMNS.join(', ')})`
    + ` VALUES (${placeholders})`
    + (ifAbsent ? ' ON CONFLICT (run_id, step_id) DO NOTHING' : '');
}

/**
 * The update a finished step applies to the row its start wrote.
 *
 * Not built from `JOURNAL_COLUMNS`: it names the three columns an outcome
 * changes and must never touch the other four. Rewriting `prompt_ver` here
 * would let a step finish under a pin it did not run on (DEC-26).
 */
export function journalFinishStatement(): string {
  return 'UPDATE step_journal SET status = $3, result = $4::jsonb, cost_micros = $5'
    + ' WHERE run_id = $1 AND step_id = $2';
}

/** One complete journal row. */
export interface JournalRow {
  runId: string;
  stepId: string;
  status: string;
  /**
   * The step's outcome, as the JSON object the column holds. Null only
   * where the row is an intent rather than an outcome.
   *
   * `object` rather than `Record<string, unknown>`: three writers pass a
   * declared interface, and TypeScript refuses an interface without an
   * index signature to an index-signature type. Widening the parameter is
   * the alternative to every caller spreading its own record into a copy.
   */
  result: object | null;
  /** DEC-26: the pins the step ran under. */
  promptVer: string;
  modelVer: string;
  /** DEC-25: the run's accumulated spend when the row was written. */
  costMicros: number;
}

function values(row: JournalRow): unknown[] {
  // `object` is wider than the column. An array is valid jsonb, so the
  // write would succeed and every reader's `result->>'reason'` would return
  // null rather than raise — a step with no explicable outcome. A function
  // stringifies to `undefined`, which pg binds as NULL, losing the row's
  // whole content silently. Refused here rather than typed away, because
  // `Record<string, unknown>` is what forced the widening: TypeScript
  // refuses a declared interface to an index-signature type, and three
  // writers pass one.
  if (row.result !== null && (Array.isArray(row.result) || typeof row.result === 'function')) {
    throw new Error(
      `step_journal.result must be a JSON object, got ${Array.isArray(row.result) ? 'an array' : 'a function'}`,
    );
  }
  return [
    row.runId,
    row.stepId,
    row.status,
    row.result === null ? null : JSON.stringify(row.result),
    row.promptVer,
    row.modelVer,
    row.costMicros,
  ];
}

/**
 * Writes one finished step.
 *
 * For a writer that knows the outcome when it writes: the consumer's
 * abandonment record, the relay's escalation, and the seeder's backdated
 * history. Each already sits inside a transaction, and each passes that
 * transaction's client.
 */
export async function journalStep(
  db: JournalDb,
  row: JournalRow,
  options: { ifAbsent?: boolean; replace?: boolean } = {},
): Promise<void> {
  await db.query(journalStatement(options), values(row));
}

/**
 * The statement one `journalStep` call runs, from its option.
 *
 * `replace` writes the row the step already has, and it exists for the writes
 * a reviewer repeats: the undo (DEC-51), where a reviewer confirms, undoes,
 * confirms again, and undoes again, and the snooze (DEC-48), where a case
 * returns and is put aside again. The row then names the latest person and
 * moment. The columns the key does not hold are the outcome's, so replacing
 * them changes the record and never the step's identity.
 *
 * The relay keeps `ifAbsent` and not this: an escalation's reason is the
 * record of what happened, and a later scan must not rewrite it.
 */
function journalStatement(options: { ifAbsent?: boolean; replace?: boolean }): string {
  if (options.replace === true) {
    return journalInsertStatement()
      + ' ON CONFLICT (run_id, step_id) DO UPDATE SET'
      + ' status = EXCLUDED.status, result = EXCLUDED.result,'
      + ' prompt_ver = EXCLUDED.prompt_ver, model_ver = EXCLUDED.model_ver,'
      + ' cost_micros = EXCLUDED.cost_micros';
  }
  return journalInsertStatement(options.ifAbsent ?? false);
}

/**
 * Writes the intent: this step is about to act (section 4.3 task 3, DEC-04).
 *
 * The status is fixed at 'started' and `result` is null, which is what makes
 * the row a marker rather than a record. A crash between this and the finish
 * leaves the marker standing, and the park path reads exactly that to refuse
 * a second draft (DEC-11).
 */
export async function journalStart(
  db: JournalDb,
  entry: { runId: string; stepId: string; promptVer: string; modelVer: string; costMicros: number },
): Promise<void> {
  await journalStep(db, { ...entry, status: 'started', result: null });
}

/**
 * Records the outcome on the row `journalStart` opened.
 *
 * Updates nothing else. A finish that names no started row updates no rows
 * and raises nothing — that is the same silence the open-coded statement
 * had, and it is correct here: every caller writes its start first, on the
 * same connection, in program order.
 */
export async function journalFinish(
  db: JournalDb,
  entry: {
    runId: string;
    stepId: string;
    status: string;
    result: object;
    costMicros: number;
  },
): Promise<void> {
  await db.query(journalFinishStatement(), [
    entry.runId,
    entry.stepId,
    entry.status,
    JSON.stringify(entry.result),
    entry.costMicros,
  ]);
}
