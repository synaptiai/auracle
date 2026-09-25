// One read at a time, shared by every caller that asks while it runs.
//
// Its own module, as `daily-cache.ts` is: `main.ts` runs `main()` when it is
// imported, so a rule defined there cannot be reached from a test.
//
// The knowledge screen reads several statements over a 14-day window. Two
// reviewers loading it together would each hold a pool connection that an
// approval may need, for the same answer.

/**
 * `read`, shared by the calls that arrive while it runs.
 *
 * Nothing is held once it settles: the next call reads again, so a figure is
 * never older than the read that drew it, and a failure does not outlast the
 * ledger's recovery.
 */
export function sharedRead<T>(read: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | null = null;
  return () => {
    if (running !== null) return running;
    const started = read().finally(() => {
      running = null;
    });
    running = started;
    return started;
  };
}

/**
 * `read`, given up after `giveUpMs`: the call then fails, and the read runs on
 * until its own bounds end it.
 *
 * The core bounds the read and the pool bounds the wait for a connection.
 * This ends the page's wait on whatever those leave, so a page that awaits a
 * read draws its "not read" line at this limit at most. A read that fails
 * after the page gave up has no page to tell, so `late` hears it, and the
 * console logs it: its reason would otherwise reach no one.
 *
 * The timer does not keep a stopping console alive, as the other page timers
 * do not.
 */
export function givingUp<A extends unknown[], T>(
  read: (...args: A) => Promise<T>,
  giveUpMs: number,
  name: string,
  late: (error: unknown) => void,
): (...args: A) => Promise<T> {
  return (...args: A) => new Promise<T>((resolve, reject) => {
    let gaveUp = false;
    const timer = setTimeout(() => {
      gaveUp = true;
      reject(new Error(`${name}: gave up after ${giveUpMs} ms`));
    }, giveUpMs);
    timer.unref?.();
    let started: Promise<T>;
    try {
      started = read(...args);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    started.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => {
        clearTimeout(timer);
        if (gaveUp) late(error);
        else reject(error);
      },
    );
  });
}

/**
 * The two knowledge reads as the console serves them (DEC-50).
 *
 * The screen's read is shared while it runs, so reviewers who load it
 * together hold one connection between them. Each page gives up on its read
 * at `giveUpMs`, and a read that fails after that goes to `late`. The limit
 * wraps the sharing, not the reverse: a page that gave up leaves the read
 * running for the next page to join.
 */
export function knowledgeReads<K, G>(
  reads: {
    readonly readKnowledge: () => Promise<K>;
    readonly readCaseGap: (runId: string) => Promise<G>;
  },
  giveUpMs: number,
  late: (read: string, error: unknown) => void,
): { readonly readKnowledge: () => Promise<K>; readonly readCaseGap: (runId: string) => Promise<G> } {
  return {
    readKnowledge: givingUp(sharedRead(reads.readKnowledge), giveUpMs, 'readKnowledge',
      (error) => late('readKnowledge', error)),
    readCaseGap: givingUp(reads.readCaseGap, giveUpMs, 'readCaseGap', (error) => late('readCaseGap', error)),
  };
}
