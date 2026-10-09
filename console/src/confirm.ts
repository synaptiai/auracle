/**
 * The batch confirm and its undo (DEC-51).
 *
 * A reviewer who has read a group of clean cases confirms them together. Each
 * case goes through the one approval this console has — `approveRun`, the
 * same function the command line calls — with a hold period on the send, so a
 * reviewer who confirmed by mistake can undo before the relay posts anything.
 *
 * The batch is a loop over that approval and nothing more. It adds no second
 * transaction, no second verdict and no second guard: the DEC-46 digest
 * travels per case, so a case whose reply moved since the page was drawn
 * refuses while its neighbours send. That is why the answer is a list of
 * outcomes rather than one.
 */
import type { UndoOutcome } from 'auracle/ledger-read';
import { describeFault } from 'auracle/cli';

/**
 * One case's answer from a batch, under the id the batch asked about.
 *
 * A fault is an answer too. A ledger that stops answering half-way through a
 * batch used to discard every outcome the batch had collected, so the page
 * could not say which cases had committed; every case now gets a row, and a
 * faulted one carries the fault instead of an outcome.
 */
export type BatchOutcome<TOutcome> =
  | { readonly runId: string; readonly outcome: TOutcome }
  | { readonly runId: string; readonly fault: string };

/** Whether one batch row is a fault rather than an answer. */
export function isFault<TOutcome>(
  row: BatchOutcome<TOutcome>,
): row is { readonly runId: string; readonly fault: string } {
  return 'fault' in row;
}

export interface BatchDeps<TOutcome> {
  /**
   * The console's one approval, as the case screen calls it. Injected, so a
   * test proves the delegation rather than the ledger.
   *
   * No `copyAcknowledged` here: a batch is not the place a reviewer chooses
   * between two texts. A case whose helpdesk copy was edited answers
   * `copy_changed`, and that reviewer decides on the case.
   */
  readonly approve: (runId: string, approvedBy: string, shown: string) => Promise<TOutcome>;
  readonly undo: (runId: string, reviewer: string) => Promise<UndoOutcome>;
}

/**
 * How many cases one batch may carry.
 *
 * The reviewer design's own list is six, and a reviewer confirms what they
 * have read. The bound exists because a form field is a place any text can be
 * put, and a batch of ten thousand would hold a connection and a transaction
 * for each case.
 */
export const MAX_BATCH = 50;

/** One case to confirm: its run, and the reply digest the page drew. */
export interface ConfirmableCase {
  readonly runId: string;
  /** DEC-46: the digest of the reply the page showed for this case. */
  readonly shown: string;
}

/**
 * Confirm every case in the batch, in the order the page listed them.
 *
 * No case's answer stops another: an approval that refuses is an outcome for
 * that case, and the rest still send. The caller draws both lists.
 */
export async function confirmBatch<TOutcome>(
  deps: BatchDeps<TOutcome>,
  cases: readonly ConfirmableCase[],
  approvedBy: string,
): Promise<BatchOutcome<TOutcome>[]> {
  const outcomes: BatchOutcome<TOutcome>[] = [];
  for (const one of cases) {
    try {
      outcomes.push({
        runId: one.runId,
        outcome: await deps.approve(one.runId, approvedBy, one.shown),
      });
    } catch (error) {
      // One case that cannot reach the ledger is that case's answer. The
      // batch goes on: stopping would leave the cases after it unaddressed
      // and the caller unable to say which of the earlier ones committed.
      outcomes.push({ runId: one.runId, fault: describeFault(error) });
    }
  }
  return outcomes;
}

/**
 * Undo every case in the batch.
 *
 * The same shape as the confirm, and for the same reason: one case that can
 * no longer be undone does not stop the others. `already_sent` and
 * `window_passed` are answers about that case, not failures of the batch.
 */
export async function undoBatch(
  deps: { readonly undo: (runId: string, reviewer: string) => Promise<UndoOutcome> },
  runIds: readonly string[],
  reviewer: string,
): Promise<BatchOutcome<UndoOutcome>[]> {
  const outcomes: BatchOutcome<UndoOutcome>[] = [];
  for (const runId of runIds) {
    try {
      outcomes.push({ runId, outcome: await deps.undo(runId, reviewer) });
    } catch (error) {
      outcomes.push({ runId, fault: describeFault(error) });
    }
  }
  return outcomes;
}
