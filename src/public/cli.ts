// What a long-running process needs to report a fault and exit.
//
// The console is a separate package with its own entry point, so it needs the
// same tail every daemon uses. This is the only part of the core that a
// non-core entry point should reach for.
export { runEntry, describeFault } from '../cli/entry.js';
export type { EntryOptions } from '../cli/entry.js';
export { errorMessage } from '../errors.js';
// The one rule for a listener's interface, which the console shares with the
// webhook so neither binds every interface on a blank value.
export { hostEnv } from '../config/env.js';
// The bound on a shutdown, which the console shares with the webhook.
export { SHUTDOWN_GRACE_MS, endWithin } from '../cli/shutdown.js';
