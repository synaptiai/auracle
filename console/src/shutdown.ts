// How long a stopping console waits for a request still in flight (issue #27).
//
// Its own module so a bound that must stay inside it can be held to it: the
// read-back gives up before this wait ends, which leaves the rest of the wait
// for the approval's own statements. A transaction that asks for a connection
// after the pool closed is refused, and commits nothing.

/**
 * How long a shutdown waits for a request that is still running.
 *
 * Shorter than any ordinary supervisor's grace period, so the bounded wait
 * ends before SIGKILL rather than after it.
 */
export const SHUTDOWN_GRACE_MS = 5_000;
