// How a latency reads to an operator.
//
// Pure, and its own module because the operator console needs it. It used to
// live in `src/latency/run.ts`, which is a CLI entry point (DEC-11, issue
// #73).

/** A duration as an operator reads it, not as the ledger stores it. */
export function humanMs(ms: number | null): string {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}
