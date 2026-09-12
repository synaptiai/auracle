// The calendar day arithmetic the ledger jobs agree on.
//
// `lastCompleteDay` was written twice: `src/bands/run.ts` validated its input
// and named the job in the error, and `src/seed/run.ts` did neither. The
// arithmetic agreed — both subtract 24 hours — so the copies differed only in
// what they do when handed an invalid date. The seed copy let it reach
// `toISOString`, which throws a bare `RangeError` with nothing in it about
// what an operator got wrong.
//
// This module holds no I/O and imports nothing, so any job can take it.
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The most recent complete UTC day.
 *
 * Not today. A partial day's sample is compared against baselines built from
 * whole days, so a rate measured over three hours of traffic sits against a
 * mean of thirty full ones and every morning reads as an excursion. The
 * three-sigma action is a pull request, so that costs real work.
 *
 * The same day is the newest one worth seeding, which is why the seed planner
 * wanted it too.
 */
export function lastCompleteDay(now: Date = new Date()): string {
  if (Number.isNaN(now.getTime())) {
    throw new Error('cannot name the last complete day from an invalid date');
  }
  return new Date(now.getTime() - MS_PER_DAY).toISOString().slice(0, 10);
}
