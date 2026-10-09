// The ordering rules an explicit ledger clock must obey.
//
// A seeder writes a backdated history through the real fenced path, so the
// three timing columns come from a caller instead of `now()`. A caller that
// supplied an inconsistent triple would store a negative duration, and
// `src/latency/query.ts` would label the row 'unordered' and drop it from
// the distribution. The row would exist and count for nothing.
//
// So the write refuses the triple instead. These cases pin the refusal
// boundary, and they pin it as the exact complement of the reader's own
// label: the reader compares with `<`, so an equal pair is 'measured' and
// must be accepted here.
//
// One comparison is not here. The transition side compares a supplied finish
// against the row's stored `created_at`, and that runs in the database,
// because a JS `Date` truncates the stored microseconds. See
// `clock.db.test.ts` for its cases.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  LedgerClockError,
  assertFinishClock,
  assertInsertClock,
  finishUnordered,
} from './clock.js';

const REPO_ROOT = new URL('../../', import.meta.url).pathname;
const T0 = new Date('2026-08-01T00:00:00.000Z');
const T1 = new Date('2026-08-01T00:01:00.000Z');
const T2 = new Date('2026-08-01T00:02:00.000Z');

describe('assertInsertClock', () => {
  it('accepts an ordered triple on a terminal state', () => {
    expect(() => assertInsertClock({ createdAt: T1, finishedAt: T2 }, T0, true)).not.toThrow();
  });

  it('accepts a clock with no finish time', () => {
    expect(() => assertInsertClock({ createdAt: T1 }, T0, false)).not.toThrow();
  });

  it('accepts a clock with no arrival time, because the column is nullable', () => {
    expect(() => assertInsertClock({ createdAt: T1 }, undefined, false)).not.toThrow();
  });

  // The reader compares with `<`, so a zero-length wait is measured, not
  // unordered. A validator that refused equality would refuse a row the
  // report is happy to describe.
  it('accepts a zero queue wait and a zero service time', () => {
    expect(() => assertInsertClock({ createdAt: T1, finishedAt: T1 }, T1, true)).not.toThrow();
  });

  it('refuses a created_at before the arrival time', () => {
    expect(() => assertInsertClock({ createdAt: T0 }, T1, false)).toThrow(LedgerClockError);
  });

  it('names the column pair and both values when it refuses an arrival', () => {
    let caught: unknown;
    try {
      assertInsertClock({ createdAt: T0 }, T1, false);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LedgerClockError);
    const message = (caught as Error).message;
    expect(message).toContain('created_at');
    expect(message).toContain('enqueued_at');
    expect(message).toContain(T0.toISOString());
    expect(message).toContain(T1.toISOString());
  });

  it('refuses a finished_at before the created_at', () => {
    expect(() => assertInsertClock({ createdAt: T1, finishedAt: T0 }, undefined, true)).toThrow(
      LedgerClockError,
    );
  });

  it('names the column pair and both values when it refuses a finish', () => {
    let caught: unknown;
    try {
      assertInsertClock({ createdAt: T1, finishedAt: T0 }, undefined, true);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain('finished_at');
    expect((caught as Error).message).toContain('created_at');
    expect((caught as Error).message).toContain(T0.toISOString());
  });

  // The insert stores a finish only for a state that has finished. A finish
  // supplied for any other state used to be accepted and then dropped, and
  // the column stayed null, which the latency reader labels `unstamped`. The
  // caller heard nothing.
  it('refuses a finish supplied for a state that has not finished', () => {
    let caught: unknown;
    try {
      assertInsertClock({ createdAt: T1, finishedAt: T2 }, undefined, false);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LedgerClockError);
    expect((caught as Error).message).toContain('has not finished');
  });

  // A named error is the acceptance criterion. An anonymous Error would make
  // a caller match on message text, and the message is prose.
  it('carries the class name on the instance, so a caller can match it', () => {
    const error = new LedgerClockError('x');
    expect(error.name).toBe('LedgerClockError');
    expect(error).toBeInstanceOf(Error);
  });
});

describe('assertFinishClock', () => {
  it('accepts a finish that carries a time', () => {
    expect(() => assertFinishClock({ finishedAt: T2 })).not.toThrow();
  });

  // The order comparison is the database's, so this guard must not carry a
  // second copy of it. A guard that compared here as well would be the
  // truncating comparison this design removed.
  it('does not compare the finish against anything', () => {
    expect(() => assertFinishClock({ finishedAt: T0 })).not.toThrow();
  });
});

describe('finishUnordered', () => {
  it('names both values the database compared', () => {
    const error = finishUnordered(T0, T1);
    expect(error).toBeInstanceOf(LedgerClockError);
    expect(error.message).toContain('finished_at');
    expect(error.message).toContain('created_at');
    expect(error.message).toContain(T0.toISOString());
    expect(error.message).toContain(T1.toISOString());
  });
});

// A Date that carries no time is still a Date, so the type system passes it
// through. Every comparison against NaN is false, so it used to clear both
// guards, open the transaction and then throw a bare RangeError out of
// toISOString — untyped, and after the epoch upsert.
describe('a Date that carries no time', () => {
  const NOWHERE = new Date('nonsense');

  it('is refused as a created_at', () => {
    expect(() => assertInsertClock({ createdAt: NOWHERE }, undefined, false)).toThrow(
      LedgerClockError,
    );
  });

  it('is refused as a finished_at on the insert side', () => {
    expect(() =>
      assertInsertClock({ createdAt: T1, finishedAt: NOWHERE }, undefined, true),
    ).toThrow(LedgerClockError);
  });

  it('is refused as a finished_at on the transition side', () => {
    expect(() => assertFinishClock({ finishedAt: NOWHERE })).toThrow(LedgerClockError);
  });

  it('is refused as the arrival reference', () => {
    expect(() => assertInsertClock({ createdAt: T1 }, NOWHERE, false)).toThrow(LedgerClockError);
  });

  it('says which column carries no time', () => {
    let caught: unknown;
    try {
      assertInsertClock({ createdAt: NOWHERE }, undefined, false);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toContain('created_at');
    expect((caught as Error).message).toContain('carries no time');
  });
});

// The whole point of the refusal is that the reader would have dropped the
// row. If the reader's comparison changed and this validator did not, the
// two would disagree and a refused triple would no longer be a triple the
// report rejects.
describe('the refusal boundary and the latency reader', () => {
  // The reader's half of the agreement: it must still compare with `<`.
  // A reader that moved to `<=` would drop the equal pair these guards
  // accept, and the two would then disagree.
  it('reads a reader that still compares with a strict less-than', () => {
    const reader = readFileSync(`${REPO_ROOT}src/latency/query.ts`, 'utf8');
    expect(reader).toContain('created_at < enqueued_at');
    expect(reader).toContain('finished_at < created_at');
    expect(reader).not.toContain('created_at <= enqueued_at');
    expect(reader).not.toContain('finished_at <= created_at');
  });

  // The guards' half, asserted at the boundary itself. The case above reads
  // a file and would stay green if a guard moved to `<=`, or if it gained a
  // slack of a millisecond; this one would not.
  it('accepts each pair at equality and refuses it one millisecond earlier', () => {
    const at = new Date('2026-08-01T00:00:00.000Z');
    const justBefore = new Date(at.getTime() - 1);

    expect(() => assertInsertClock({ createdAt: at }, at, false)).not.toThrow();
    expect(() => assertInsertClock({ createdAt: justBefore }, at, false)).toThrow(
      LedgerClockError,
    );

    expect(() => assertInsertClock({ createdAt: at, finishedAt: at }, undefined, true)).not.toThrow();
    expect(() =>
      assertInsertClock({ createdAt: at, finishedAt: justBefore }, undefined, true),
    ).toThrow(LedgerClockError);
  });
});
