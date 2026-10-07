// How long a stopping process waits for a request still in flight.
//
// The webhook and the console both bound their shutdown with it, so a
// supervisor's grace period covers either one the same way.

/**
 * How long a shutdown waits for a request that is still running.
 *
 * A stuck shutdown waits twice: once for the connections, then once for the
 * pool. So a supervisor must allow more than twice this before SIGKILL.
 * `docker-compose.dev.yml` gives the webhook and the console 15 seconds.
 */
export const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Runs `end` and waits at most `ms` for it.
 *
 * pg's `pool.end()` waits for every checked-out client, and a client stuck
 * behind a lock never comes back. So a stopping process bounds the wait, and
 * on `'timeout'` it exits on its own: that client's socket would keep it
 * alive. A failure of `end` itself passes through to the caller.
 */
export async function endWithin(end: () => Promise<void>, ms: number): Promise<'ended' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'timeout'>((settle) => {
    timer = setTimeout(() => settle('timeout'), ms);
    // The timer must not itself keep the process alive.
    timer.unref();
  });
  try {
    return await Promise.race([end().then(() => 'ended' as const), late]);
  } finally {
    clearTimeout(timer);
  }
}
