/**
 * The explicit clock the fenced write path accepts.
 *
 * `run.created_at` carries a `DEFAULT now()`, so every run row records the
 * wall clock of the process that wrote it. `pnpm run bands` judges one UTC
 * day against the thirty measured days before it, and `pnpm run latency`
 * windows on the same column. Neither can be exercised without a history,
 * and a demo cannot wait thirty-one days.
 *
 * So a caller may supply the timing, and a seeder then writes a backdated
 * history through the real ledger path: the same epoch checks, the same
 * journal writes, the same transaction. The rows a report describes are rows
 * the system actually produced.
 *
 * The clock is a trailing parameter on the two fenced writes rather than a
 * field on their input types. Two reasons, and both are load-bearing:
 *
 *   1. The no-clock statement stays the statement that shipped before the
 *      seam existed. Its column list omits `created_at`, so the DEFAULT
 *      still fires and no production row moves.
 *   2. Unreachability from a daemon becomes an arity property of each call
 *      site, which `clock-reachability.test.ts` reads off the import graph.
 *      A field on `FencedRunInput` would leave a field-name grep as the only
 *      guard, and a helper that filled the field would defeat it.
 */

/** The timing a caller supplies to `fencedInsert`. */
export interface SeededInsertClock {
  /** The pickup instant, written to `run.created_at`. */
  createdAt: Date;
  /**
   * The finish instant, used only when the insert lands `superseded`
   * (section 4.2 rule 2), which is terminal. Absent means the run never
   * ran, and the creation instant is then the honest finish.
   */
  finishedAt?: Date;
}

/** The timing a caller supplies to `fencedTransition`. */
export interface SeededFinishClock {
  /** The finish instant, written to `run.finished_at` on a terminal state. */
  finishedAt: Date;
}

/**
 * A caller supplied a timing triple that cannot be a timeline.
 *
 * Named, because the acceptance criterion asks for a named error and because
 * a caller that had to match on message text would be matching on prose.
 * Thrown before the transaction opens, so a refused triple leaves no
 * `ticket_epoch` upsert, no `run` row and no `outbox` row. It is a caller
 * bug, not a concurrency outcome, so it is not a fourth member of
 * `FencedInsertResult`.
 */
export class LedgerClockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerClockError';
  }
}

/**
 * Refuses exactly what `src/latency/query.ts` would label `'unordered'`.
 *
 * That agreement is the point. A stored row the reader drops from the
 * distribution exists and counts for nothing, so the write refuses it
 * instead. The reader compares with `<`, so an equal pair is `'measured'`
 * and is accepted here: a zero queue wait is a wait, and a zero service time
 * is a service time.
 */
function refuse(earlier: string, later: string, earlierAt: Date, laterAt: Date): never {
  throw new LedgerClockError(
    `explicit clock is not a timeline: ${earlier} ${earlierAt.toISOString()}`
      + ` precedes ${later} ${laterAt.toISOString()}`,
  );
}

/**
 * Refuses a `Date` that carries no time.
 *
 * `new Date('nonsense')` is a `Date`, so the type system passes it through.
 * Its `getTime()` is `NaN`, and every comparison against `NaN` is false, so
 * it clears both order checks below. It then reaches `toISOString()` inside
 * the transaction and throws a bare `RangeError` — after the epoch upsert,
 * and untyped, so no caller matching on `LedgerClockError` classifies it.
 * So the guard runs here, where the named error lives and where the refusal
 * still happens before the write.
 */
function assertReal(column: string, value: Date): void {
  if (Number.isNaN(value.getTime())) {
    throw new LedgerClockError(`explicit clock is not a timeline: ${column} carries no time`);
  }
}

/**
 * Checks a `fencedInsert` clock against the row it is about to write.
 *
 * `stateIsTerminal` decides whether the insert will store the finish at all.
 * A finish supplied for a state that has not finished is refused rather than
 * accepted and dropped: the caller said when the run ended, and a write that
 * quietly disagreed would leave `finished_at` null, which the latency reader
 * labels `unstamped`. The losing side of a zero-row outbox insert lands
 * `superseded` and takes its finish from the creation instant, because such
 * a run never ran, so that branch needs no finish from the caller.
 */
export function assertInsertClock(
  clock: SeededInsertClock,
  enqueuedAt: Date | null | undefined,
  stateIsTerminal: boolean,
): void {
  if (clock.finishedAt !== undefined && !stateIsTerminal) {
    throw new LedgerClockError(
      'explicit clock supplies finished_at for a state that has not finished;'
        + ' the insert would not store it',
    );
  }
  assertReal('created_at', clock.createdAt);
  if (clock.finishedAt !== undefined) assertReal('finished_at', clock.finishedAt);
  if (enqueuedAt != null) assertReal('enqueued_at', enqueuedAt);
  if (enqueuedAt != null && clock.createdAt.getTime() < enqueuedAt.getTime()) {
    refuse('created_at', 'enqueued_at', clock.createdAt, enqueuedAt);
  }
  if (clock.finishedAt !== undefined && clock.finishedAt.getTime() < clock.createdAt.getTime()) {
    refuse('finished_at', 'created_at', clock.finishedAt, clock.createdAt);
  }
}

/**
 * Checks a `fencedTransition` clock for a time it can carry.
 *
 * The order comparison is **not** here, and that is deliberate. It compares
 * against the row's stored `created_at`, and Postgres stores a `timestamptz`
 * at microsecond precision while node-postgres parses it into a JS `Date` at
 * millisecond precision, truncating downward. A comparison in JavaScript is
 * therefore permissive by up to 999 microseconds: it accepted a finish that
 * the database then saw as earlier than the creation, and the latency reader
 * labelled that row `unordered` and dropped it. So the comparison runs in
 * the same `SELECT ... FOR UPDATE` that reads the row, at the precision the
 * column actually holds. `fencedTransition` throws `finishUnordered` when
 * that flag comes back true.
 */
export function assertFinishClock(clock: SeededFinishClock): void {
  assertReal('finished_at', clock.finishedAt);
}

/**
 * The refusal `fencedTransition` raises when the database answers that the
 * supplied finish precedes the row's stored creation.
 *
 * A function rather than a thrown constant, so the message names the values
 * the caller sent and the row held.
 */
export function finishUnordered(finishedAt: Date, createdAt: Date): LedgerClockError {
  return new LedgerClockError(
    `explicit clock is not a timeline: finished_at ${finishedAt.toISOString()}`
      + ` precedes created_at ${createdAt.toISOString()}`,
  );
}
