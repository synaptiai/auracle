// The arrival signal: intake tells the consumer a message is queued, so the
// consumer stops sleeping through it.
//
// Why this exists. `pnpm run latency` over a synthetic history of 2397 runs
// reported a mean queue wait of 2.78 s against a poll floor of 2.50 s, at
// 1.37 % utilisation. Ninety percent of the wait was the loop's own sleep,
// and one run in a hundred waited longer than one poll period. The V2 design
// document (`v2-head-of-line-delay-correction.md`) names three sources of
// delay and maps corrections for two of them; the sleep is the third, and it
// is the one the measurement indicts.
//
// What this is not. It is not a lease and not a lock service, both of which
// DEC-27 rejects. A notification grants no exclusivity and no mutual
// exclusion. Ownership still comes from the partition assignment, and the
// fencing epoch (DEC-28) still covers a rebalance overlap. Nothing about the
// write path changes.
//
// The signal is an optimisation and never an authority. The queued row is
// the authority, and `CONSUMER_INTERVAL_MS` still bounds the wait when no
// notification arrives — a dropped packet, a reconnect, or a row written by
// a process that predates this module. Lost work is therefore impossible:
// the worst a broken signal costs is the latency the system has today.
//
// One exception to that reading, stated because the reading is otherwise
// too comfortable: `enqueueTicket` emits inside its transaction, so the
// notification does gate that commit. Postgres holds pending notifications
// in a server-side queue, and a `COMMIT` fails if that queue is full. The
// placement is deliberate — it is what makes a rolled-back redelivery signal
// nobody — but it means a listener that stops consuming for long enough can
// refuse an ingress that was otherwise sound.
//
// Every connection failure here degrades to the poll, never to a stopped
// daemon. So each one is caught, each one is logged with a reason, and each
// one schedules another attempt.
import { Client } from 'pg';

import { errorMessage } from '../errors.js';
import { logLine } from '../log/line.js';

/**
 * The channel name, written once so the emitter and the listener cannot
 * drift apart. `src/coordinator/intake.ts` emits on it; this module listens.
 *
 * `LISTEN` takes an identifier, and Postgres binds no parameter there, so
 * the statement below interpolates this value. That is safe only while the
 * value stays a literal constant. The assertion is the guard: a later change
 * that made the channel configurable fails here rather than becoming an
 * injection point. AGENTS.md states the rule — enforce with an assertion,
 * not a comment.
 */
export const ARRIVAL_CHANNEL = 'ticket_arrived';

if (!/^[a-z][a-z0-9_]*$/.test(ARRIVAL_CHANNEL)) {
  throw new Error(
    `ARRIVAL_CHANNEL must be a plain lower-case identifier, because LISTEN `
      + `interpolates it and Postgres binds no parameter there. Got ${ARRIVAL_CHANNEL}.`,
  );
}

/** The first delay before a dropped listener tries to connect again. */
const RECONNECT_MS = 1000;

/**
 * The ceiling on that delay.
 *
 * The retry is unbounded in count, because a listener that gave up would
 * leave the consumer on the poll for the rest of the process lifetime with
 * every health signal green. It is bounded in rate instead: a day-long
 * outage at a flat second would be 86 400 attempts and 86 400 log lines per
 * consumer, against a signal whose loss costs only latency.
 */
const RECONNECT_CEILING_MS = 30_000;

/**
 * How long a connection must be held before the backoff resets.
 *
 * A database that accepts `LISTEN` and then drops the socket is a flap, not a
 * recovery, and the ceiling is meant to bound exactly that volume.
 */
const HOLD_TO_RESET_MS = 60_000;

export interface ArrivalSignal {
  /** Begins listening. Calls `wake` with the partition of each arrival. */
  start(wake: (partition: number) => void): Promise<void>;
  /** Stops listening and releases the connection. */
  stop(): Promise<void>;
}

/**
 * A signal over one dedicated Postgres connection.
 *
 * It takes a connection string and never a `Pool`, deliberately. Every
 * daemon builds its pool with `max: 1`, and a `LISTEN` connection is held
 * for the process lifetime; taking that client from the pool would leave the
 * daemon with no client for its actual work. `enqueueTicket` already carries
 * a comment about wedging the ingress exactly that way.
 */
export function pgArrivalSignal(connectionString: string): ArrivalSignal {
  let client: Client | null = null;
  let stopped = true;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let delayMs = RECONNECT_MS;
  /**
   * A connect that has not finished. `stop()` awaits it, because a client
   * still being established is one this signal started, and the caller ends
   * its pool the moment `stop()` resolves.
   */
  let inFlight: Promise<void> | null = null;
  /** Pending reset of the backoff, armed when a connection is published. */
  let holdTimer: NodeJS.Timeout | null = null;
  /**
   * Which connection attempt owns the current client.
   *
   * Without it, a late error from a client that has already been retired
   * re-enters `reconnect`, reads `client` as the *healthy* connection that
   * replaced it, and ends that one instead. The handler compares its own
   * generation against the live one and does nothing when they differ.
   */
  let generation = 0;

  async function connect(wake: (partition: number) => void): Promise<void> {
    const mine = generation;
    // `keepAlive` matters more here than anywhere else in the system. pg
    // raises 'error' only on a close it observes, and this is the one
    // connection that sits idle for hours by design. A router or a load
    // balancer that drops an idle flow without a FIN would otherwise leave a
    // dead socket that never errors, never reconnects, and never recovers —
    // the silent degradation this module's header forbids. The
    // pg_terminate_backend case cannot catch it, because that path does
    // deliver a close.
    const next = new Client({
      connectionString,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      // Bounded, so an unreachable host cannot outlast the shutdown budget
      // the consumer gives this signal. Without it a dial runs to the
      // operating system's default and `stop()` waits behind it.
      connectionTimeoutMillis: 5_000,
    });
    // Attached before connect: a connection that fails during the handshake
    // emits here, and an unhandled 'error' event on a Client is fatal to the
    // process. The daemon must survive a database that blinks.
    next.on('error', (error) => {
      if (mine !== generation) return;
      console.error(
        logLine({
          event: 'arrival_signal_lost',
          at: new Date().toISOString(),
          error: errorMessage(error),
        }),
      );
      void reconnect(wake);
    });
    next.on('notification', (message) => {
      // The same discipline the 'error' handler keeps. A retired client can
      // deliver between `reconnect`'s un-awaited `end()` and the socket
      // actually closing, and a wake after shutdown belongs to nobody.
      if (stopped || mine !== generation) return;
      // A payload the listener cannot read is ignored, never thrown. This
      // handler runs outside any await chain, so a throw here becomes an
      // unhandled rejection and kills the daemon — for a signal whose whole
      // contract is that losing it costs latency and nothing else.
      //
      // Parsed against exactly what the emitter sends, `String(partition)`.
      // `Number` is wider than that: `Number('')` is 0, so an empty payload
      // used to wake partition 0 specifically, and `'0x10'` and `'1e3'` were
      // accepted too.
      const payload = message.payload ?? '';
      if (!/^\d+$/.test(payload)) return;
      try {
        wake(Number.parseInt(payload, 10));
      } catch (error) {
        // The caller's contract is that `wake` does not throw. It is
        // enforced here rather than assumed, because the cost of the
        // assumption being wrong is the whole daemon.
        console.error(
          logLine({
            event: 'arrival_wake_failed',
            at: new Date().toISOString(),
            error: errorMessage(error),
          }),
        );
      }
    });

    try {
      await next.connect();
      await next.query(`LISTEN ${ARRIVAL_CHANNEL}`);
    } catch (error) {
      // The client may be fully connected even though LISTEN failed, and it
      // was never published, so nothing else can ever close it. A leaked
      // connected client also holds the Node event loop open, which stops
      // the daemon exiting on SIGTERM. Its listener goes with it, for the
      // same reason as the discard branch below.
      next.removeAllListeners('error');
      await next.end().catch(() => undefined);
      throw error;
    }

    // Published only if it is still wanted. `stop()` can run to completion
    // while these awaits are in flight, and a client assigned afterwards
    // would outlive the shutdown that was supposed to release it.
    if (stopped || mine !== generation || client !== null) {
      // The listener goes with it. On this branch `mine === generation` can
      // still hold, so a late error from a client nobody kept would pass the
      // guard above and end the healthy one that replaced it.
      next.removeAllListeners('error');
      await next.end().catch(() => undefined);
      return;
    }
    client = next;
    // The backoff resets only once the connection has proved it can be held.
    // Resetting on publish alone let a database that accepts LISTEN and then
    // drops the socket reconnect at one second for ever, which is the log and
    // attempt volume the ceiling exists to bound.
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      delayMs = RECONNECT_MS;
    }, HOLD_TO_RESET_MS);
    holdTimer.unref?.();
  }

  function reconnect(wake: (partition: number) => void): void {
    if (stopped || reconnectTimer !== null) return;
    generation += 1;
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    const dead = client;
    client = null;
    // The connection is already gone; end() only releases the handle.
    if (dead !== null) void dead.end().catch(() => undefined);
    const wait = delayMs;
    delayMs = Math.min(delayMs * 2, RECONNECT_CEILING_MS);
    const mine = generation;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (stopped) return;
      const attempt = connect(wake).catch((error: unknown) => {
        // ERR-8: only when this attempt still owns the connection. A client
        // whose 'error' handler already logged and rescheduled would
        // otherwise log the same failure twice.
        if (mine === generation) {
          console.error(
            logLine({
              event: 'arrival_signal_lost',
              at: new Date().toISOString(),
              error: errorMessage(error),
            }),
          );
        }
        reconnect(wake);
      });
      inFlight = attempt;
      void attempt;
      // Jitter, so a fleet that lost one database does not reconnect in
      // lockstep and arrive as a thundering herd when it returns.
    }, wait + Math.floor(Math.random() * wait));
    reconnectTimer.unref?.();
  }

  return {
    async start(wake): Promise<void> {
      stopped = false;
      const attempt = connect(wake);
      inFlight = attempt.catch(() => undefined);
      try {
        await attempt;
      } catch (error) {
        // A database that is down at daemon start must not disable the
        // signal for the process lifetime. The 'error' handler only exists
        // on a client that connected, so a failed first attempt schedules
        // its own retry: the path that establishes the listener and the
        // path that re-establishes it are the same path.
        console.error(
          logLine({
            event: 'arrival_signal_lost',
            at: new Date().toISOString(),
            error: errorMessage(error),
          }),
        );
        reconnect(wake);
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      generation += 1;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      // A connect still in flight releases its own client, because `stopped`
      // is already true and the guard inside `connect` reads it. Awaiting
      // that release is what makes this method's contract true: nothing this
      // signal started still holds a connection when it resolves.
      const pending = inFlight;
      inFlight = null;
      if (pending !== null) await pending.catch(() => undefined);
      const open = client;
      client = null;
      if (open !== null) await open.end().catch(() => undefined);
    },
  };
}
