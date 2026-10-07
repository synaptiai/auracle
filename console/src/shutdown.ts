// How long a stopping console waits for a request still in flight (issue #27).
//
// Its own module so a bound that must stay inside it can be held to it: the
// read-back gives up before this wait ends, which leaves the rest of the wait
// for the approval's own statements. A transaction that asks for a connection
// after the pool closed is refused, and commits nothing.
//
// The value is the core's, so the console and the webhook cannot drift apart.
export { SHUTDOWN_GRACE_MS } from 'auracle/cli';
