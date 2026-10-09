// How a control-band number reads to an operator.
//
// Pure, and its own module because the operator console needs it. It used to
// live in `src/bands/run.ts`, which is a CLI entry point: importing it ran a
// module that parses argv and sets `process.exitCode`, so the console loaded a
// command-line program to format a number (DEC-11).
//
// Nothing here touches a ledger, a clock or the environment.

/** A number as an operator reads it: a rate to three places, a count whole. */
export function humanValue(value: number | null): string {
  if (value === null) return '-';
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}
