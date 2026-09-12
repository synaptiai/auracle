// What a long-running process needs to report a fault and exit (issue #72).
//
// The console is a separate package with its own entry point, so it needs the
// same tail every daemon uses. This is the only part of the core that a
// non-core entry point should reach for.
export { runEntry, describeFault } from '../cli/entry.js';
export type { EntryOptions } from '../cli/entry.js';
export { errorMessage } from '../errors.js';
