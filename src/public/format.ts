// Pure formatting and calendar helpers, for any package that renders a
// ledger number to a person, and the one structured log line a process
// writes.
//
// Nothing here reads a ledger, a clock, argv or the environment. That is the
// point: the console imports these from here, not from `bands/run.js` or
// `latency/run.js`, which are CLI entry points.
export { humanValue } from '../bands/format.js';
export { humanMs } from '../latency/format.js';
export { logLine } from '../log/line.js';
export { lastCompleteDay, MS_PER_DAY } from '../time/day.js';
