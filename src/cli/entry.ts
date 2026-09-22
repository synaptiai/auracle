// The tail every CLI and daemon ends with.
//
// Twenty entry points used to end with their own copy, and the copies had
// drifted into four different answers to the same question. Fifteen printed
// `err.message`. `bands/run.ts` and `latency/run.ts` printed the whole Error
// when it carried a cause, because `src/artifacts/versioned.ts` attaches one
// to every filesystem fault it wraps and the message alone drops the errno.
// `console/src/main.ts` walked the chain into a string with a third
// implementation. `groundedness/report.ts` printed the raw object. The fix
// was made three times in three shapes and backported to none of the other
// fifteen, so an artifact-write fault in fifteen tools still lost its errno.
//
// One shape now, and it is the corrected one.
import { errorMessage } from '../errors.js';
import { terminalText } from './terminal-text.js';

/**
 * How deep the cause walk goes.
 *
 * The seen-set below stops a cycle, but a chain can be long without
 * repeating a node. This is the second bound, and it exists because a fault
 * printer runs at the one moment everything else has already failed.
 */
const MAX_CAUSE_DEPTH = 16;

/**
 * Everything a thrown value has to say, including its cause chain.
 *
 * Returns a string rather than printing the `Error` itself, which is what
 * `bands` and `latency` did. That is a deliberate trade: Node renders a
 * stack for a thrown object, and a string drops it. The errno survives —
 * a filesystem cause carries it in its own message, as
 * `ENOENT: no such file or directory, open '...'` — and an operator reading
 * a refused configuration gets one sentence instead of six stack frames.
 * A string is also the only form a test can assert on.
 */
export function describeFault(error: unknown): string {
  // The head is described unconditionally, and only then does the walk
  // begin. Folding the two together made `undefined` — which `throw
  // undefined` produces, and which is legal — print an empty line, because
  // the test for "no further cause" and the head were the same test.
  const parts: string[] = [errorMessage(error)];
  // Identity, not equality: two distinct Errors may carry the same message,
  // and only a repeat of the same object is a cycle.
  const seen = new Set<unknown>([error]);
  let current: unknown = causeOf(error);
  let truncated = false;
  while (current !== undefined) {
    if (parts.length >= MAX_CAUSE_DEPTH) {
      truncated = true;
      break;
    }
    if (typeof current === 'object' && current !== null) {
      if (seen.has(current)) break;
      seen.add(current);
    }
    parts.push(errorMessage(current));
    current = causeOf(current);
  }
  // Said, not silent. An operator reading a line that stops at sixteen links
  // cannot otherwise tell a chain that ended from one that was cut.
  if (truncated) parts.push('... (cause chain truncated)');
  return parts.join(': ');
}

/**
 * The next link, or `undefined` when there is none.
 *
 * `new Error(msg, { cause: undefined })` defines the property, so reading it
 * and testing for undefined is right where `'cause' in error` would append
 * the word 'undefined' to the operator's line. The read itself is guarded
 * because `cause` can be a getter, and a getter that throws here would
 * replace the fault being reported with one from the reporter.
 */
function causeOf(error: unknown): unknown {
  if (!(error instanceof Error)) return undefined;
  try {
    return error.cause;
  } catch {
    return undefined;
  }
}

/**
 * Prints the fault, and cannot itself throw.
 *
 * `describeFault` is defensive throughout, so the likelier failure is the
 * write: `console.error` raises EPIPE when stderr is a pipe nobody is
 * reading any more, which is what `node dist/thing.js 2>&1 | head -1`
 * leaves behind. A fallback that writes the same way would raise it again
 * and escape, turning a controlled exit 1 into an unhandled rejection —
 * so the fallback is tried once and then the failure to report is itself
 * given up on. The exit code is already set by the time this runs, so a
 * process that cannot say anything still says it failed.
 */
function report(error: unknown): void {
  try {
    console.error(terminalText(describeFault(error)));
  } catch {
    try {
      console.error('the entry point failed, and describing the fault failed too');
    } catch {
      // Nothing left to try. Silence beats replacing the exit code with a
      // crash from the reporter.
    }
  }
}

/** What a caller may do when the entry point fails. */
export interface EntryOptions {
  /**
   * Released when, and only when, `main` rejects.
   *
   * The console needs it: a pool holding an idle client keeps the event loop
   * alive, so a throw between the ledger probe and `listen` would hang the
   * process at exit code 1 rather than ending it. A fault of its own is
   * reported and never replaces the fault that brought us here.
   */
  onFault?: () => void | Promise<void>;
}

/**
 * Runs an entry point's `main`, reports any fault, and sets the exit code.
 *
 * `process.exitCode`, never `process.exit()`. Several entry points have a
 * pending teardown or a server close behind them, and `process.exit()` would
 * cut it. It also leaves an exit code `main` set for itself alone: `kb/cli.ts`
 * sets 1 on a failed document and returns normally, and a tail that reset it
 * would report success.
 */
export async function runEntry(
  main: () => void | Promise<void>,
  options: EntryOptions = {},
): Promise<void> {
  try {
    // Awaited inside the try, so a `main` that throws before its first await
    // lands here rather than escaping as a synchronous throw.
    await main();
  } catch (error) {
    // The exit code first, before anything that could itself fail. Printing
    // used to come first, and a failure to print took the whole catch block
    // with it: the process exited 0 and `onFault` never ran, so the
    // console's pool stayed open and a failure reported success.
    //
    // `report` below is now unable to throw, which is what actually closes
    // that hole — so no test can tell this ordering from its reverse. It
    // stays as the second line of defence, and it is honest to say that
    // only the first one is covered.
    process.exitCode = 1;
    report(error);
    const { onFault } = options;
    if (onFault !== undefined) {
      try {
        await onFault();
      } catch (teardownFault) {
        // Reported, not rethrown, and not in place of the fault above. An
        // escaping rejection here would become an unhandled one and replace
        // a controlled exit 1 with a crash.
        console.error(
          `the entry point could not release its resources: ${terminalText(describeFault(teardownFault))}`,
        );
      }
    }
  }
}
