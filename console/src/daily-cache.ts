// A daily count, held briefly (issue #101).
//
// Its own module, as `views.ts` is: `main.ts` runs `main()` when it is
// imported, so a rule defined there cannot be reached from a test.
//
// The queue header counts the UTC day on every load of the landing page. The
// count is a figure for the day, so a value a few seconds old is still true
// enough to state, and a reviewer reloading the queue costs the ledger one
// count per window rather than one per load.

/**
 * `read`, answered from its last value while that value is younger than
 * `ttlMs` and still names the current UTC day.
 *
 * A value from before midnight is never stated after it, whatever its age.
 * A failed read is not held: the next call reads again, so a fault does not
 * outlast the ledger's recovery. Calls on the same UTC day that arrive while
 * a read runs share it. A call after midnight does not join a read begun
 * before it, and that older read's answer never replaces a newer held value.
 *
 * A read that has not settled within `giveUpMs` fails, for every call joined
 * to it, and the next call starts another. A read over a connection that died
 * never settles and nothing answers it, and shared with every later call it
 * would hang the page until midnight. A late answer from it is not held.
 */
export function cachedDaily<T extends { readonly day: string }>(
  read: () => Promise<T>,
  ttlMs: number,
  clock: () => number = Date.now,
  giveUpMs: number = Number.POSITIVE_INFINITY,
): () => Promise<T> {
  let held: { readonly at: number; readonly value: T } | null = null;
  let running: { readonly day: string; readonly value: Promise<T> } | null = null;
  const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);
  return async () => {
    const now = clock();
    const today = dayOf(now);
    if (held !== null && now - held.at < ttlMs && held.value.day === today) {
      return held.value;
    }
    if (running !== null && running.day === today) return running.value;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let resolveRead: (value: T) => void = () => undefined;
    let rejectRead: (error: unknown) => void = () => undefined;
    const started: { readonly day: string; readonly value: Promise<T> } = {
      day: today,
      value: new Promise<T>((resolve, reject) => {
        resolveRead = resolve;
        rejectRead = reject;
      }),
    };
    // Named as the running read before the read starts, so every way the read
    // can end, a throw on the first line included, finds itself here.
    running = started;
    const failed = (error: unknown): void => {
      if (timer !== null) clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (running === started) running = null;
      rejectRead(error);
    };
    const answered = (value: T): void => {
      if (timer !== null) clearTimeout(timer);
      if (settled) return;
      settled = true;
      // Only the newest read may hold its answer. An older one resolving late
      // would put a staler value over a newer one.
      if (running === started) {
        held = { at: clock(), value };
        running = null;
      }
      resolveRead(value);
    };
    if (Number.isFinite(giveUpMs)) {
      timer = setTimeout(() => {
        failed(new Error(`the read did not finish within ${giveUpMs}ms`));
      }, giveUpMs);
      // A pending bound is no reason to keep the process alive at shutdown.
      timer.unref?.();
    }
    // A read that throws before it returns a promise fails like one that
    // rejects, and the next call reads again.
    try {
      read().then(answered, failed);
    } catch (error) {
      failed(error);
    }
    return started.value;
  };
}
