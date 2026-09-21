// The console's approval write (issue #27, DEC-11, DEC-40).
//
// DEC-11 rejected "a Slack queue; a new web queue" by name, and section 4.2
// says adopters do not install a new interface to receive a draft. DEC-40
// permits this console to approve one while keeping the parking rule intact:
// the draft still lives in the helpdesk, and this is a second approval path,
// never a second parking path.
//
// So there is no approval here. This function validates a run id off a form
// post and hands the work to `approveRun` — the same function `pnpm run
// approve` calls. The transaction, the fencing epoch and the approval edit
// distance are therefore the command line's, not a second implementation of
// them.
//
// This is the console's one approval path, and `select-only.test.ts` is what
// holds it to one: the holds (DEC-46) are the console's other writes, and it
// names every write it makes.
import type { Pool } from 'pg';
import type {
  ApproveOptions, ApproveOutcome, CloseOptions, CloseOutcome, DraftReadBack, RewriteOptions,
  RewriteOutcome, SaveOutcome, SaveReplyOptions, SendBackOptions, SendBackOutcome, SnoozeOptions,
  SnoozeOutcome, UndoOutcome,
} from 'auracle/ledger-read';

import { ReadBackFailed } from './read-back.js';
import type { ConsoleReadBack } from './read-back.js';

/**
 * A run id is a UUID the ledger minted. It arrives from a form post, so it
 * is checked rather than trusted, and it never reaches a statement of ours
 * in any case — `approveRun` binds it as a parameter.
 */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a string has the shape of a run id.
 *
 * Exported because the read path needs the same answer. `run_id` is a `uuid`
 * column, so an id of any other shape makes Postgres raise rather than return
 * no rows: `GET /run/abc` answered 500 where the route promises 404, and each
 * one cost a pool connection and a round trip on a page a reviewer was reading.
 * One definition, so the read and the write agree.
 */
export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

export interface ApproveDeps {
  readonly pool: Pool;
  /** Injected, so a test proves the delegation rather than the ledger. */
  readonly approveRun: (
    pool: Pool,
    runId: string,
    options?: ApproveOptions,
  ) => Promise<ApproveOutcome>;
  /**
   * The helpdesk the draft is read back from, or undefined when the console
   * reads nothing back (section 4.10). `read-back.ts` decides which, and
   * bounds the read.
   */
  readonly readDraft?: DraftReadBack;
  /**
   * Where a failed read-back's fault goes. The page names the failure and
   * nothing more, so the fault is kept beside the run it stopped.
   */
  readonly onReadBackFailed?: (runId: string, fault: string, draftExternalId: string | null) => void;
  /**
   * DEC-44: whether this console's adapter cannot send the copy it parks, so
   * the approval sends the reply the ledger holds.
   *
   * Required, and not inferred from `readDraft`: the two are separate facts.
   * An adapter can be read back and still send its own parked copy, which is
   * every adapter that keeps the DEC-40 path.
   */
  readonly ledgerReply: boolean;
  /**
   * DEC-51: the period this console's sends wait before the relay may post
   * them. Absent is no hold, which is what the command line does.
   *
   * It reaches the approval as an option and not from the environment again:
   * the console read `CONSOLE_SEND_HOLD_MS` once at startup, and a second read
   * here could disagree with the period the pages promise.
   */
  readonly sendHoldMs?: number;
}

/**
 * What the console's approval answered: the ledger's outcome, or a read-back
 * that failed before the ledger was asked.
 *
 * A console outcome rather than a new ledger one. `approveRun` reads the draft
 * before its transaction opens, so a failed read committed nothing, and the
 * command line reports the same fault as an error.
 */
export type ConsoleApproveOutcome =
  | ApproveOutcome
  | { readonly outcome: 'read_back_failed'; readonly fault: string }
  /**
   * DEC-44: the read-back refused a copy this instance cannot compare, and a
   * retry cannot change that. The one shape that reaches it is a parked
   * thread the helpdesk does not hold as an internal note, which means the
   * processes that park and approve read the helpdesk's configuration
   * differently. Its own outcome, because the next step differs: the
   * operator aligns the processes rather than checking a connection.
   */
  | { readonly outcome: 'read_back_not_a_note'; readonly fault: string };

/**
 * The console approves; it does not compose.
 *
 * There is deliberately no final body here. `approveRun` puts an explicit
 * body in the ledger — `turn.approved_reply_text` and the approval edit
 * distance — but it never puts it on the wire: the outbox payload for a
 * draft-backed park is `{ draftExternalId }`, and the relay sends that draft
 * verbatim. So text typed here would be recorded as the approved reply and
 * the customer would receive the original. The edit distance feeds a
 * published control band, so the band would ingest a difference nobody sent.
 *
 * The draft parks in the helpdesk and is edited there (DEC-11, DEC-40). This
 * console is the second approval path, not a second composer.
 */
export interface ApproveRequest {
  readonly runId: string;
  /**
   * DEC-42: the approver a trusted proxy named, when one did.
   *
   * Required, because the console serves no write without one (DEC-45). It
   * is the identity the gate resolved against the roster, so the ledger
   * records it with the source `roster`. `approveRun` bounds what it keeps
   * all the same, and a value it refuses records nobody.
   */
  readonly approvedBy: string;
  /**
   * DEC-46: the digest of the reply the page the reviewer read drew.
   *
   * Required, because every approval this console makes is an approval of a
   * page it rendered. The approval recomputes it from the reply the ledger
   * holds, under the run's lock, and refuses the send when the two differ.
   */
  readonly shown: string;
  /**
   * DEC-44: the digest of the helpdesk copy the reviewer read and decided to
   * send past, from the refusal's own form. Absent when the reviewer is not
   * deciding that.
   */
  readonly copyAcknowledged?: string;
}

/**
 * The console's save (DEC-44), which is a delegation for the same reason the
 * approval is: `saveReply` owns the transaction, the DEC-46 guard and the
 * turn it writes on, and a second implementation here would be a second set
 * of rules about the same text.
 */
export interface SaveDeps {
  readonly pool: Pool;
  /** Injected, so a test proves the delegation rather than the ledger. */
  readonly saveReply: (
    pool: Pool,
    runId: string,
    text: string,
    options?: SaveReplyOptions,
  ) => Promise<SaveOutcome>;
}

export interface SaveRequest {
  readonly runId: string;
  /** The whole reply, as the reviewer wrote it or as a callout assembled it. */
  readonly text: string;
  /** DEC-46: the digest of the reply the page that posted this drew. */
  readonly shown: string;
}

/** What the console's save answered: the ledger's outcome, or nothing. */
export type ConsoleSaveOutcome = SaveOutcome;

export async function saveFromConsole(
  deps: SaveDeps,
  request: SaveRequest,
): Promise<ConsoleSaveOutcome> {
  const runId = request.runId.trim();
  if (!RUN_ID.test(runId)) {
    throw new Error(`'${request.runId}' is not a run id`);
  }
  // The digest always travels: every save this console makes is a save of a
  // page it rendered, so a request without one never reaches the ledger.
  return deps.saveReply(deps.pool, runId, request.text, { shown: request.shown });
}

export async function approveFromConsole(
  deps: ApproveDeps,
  request: ApproveRequest,
): Promise<ConsoleApproveOutcome> {
  const runId = request.runId.trim();
  if (!RUN_ID.test(runId)) {
    throw new Error(`'${request.runId}' is not a run id`);
  }
  // No final body. With an adapter, this is the path `pnpm run approve
  // --read-back` takes: the helpdesk copy is read and the distance measured
  // against it. Without one it is the manual path, and the distance stays
  // null, which is the truthful reading when nobody captured what was sent.
  const options: ApproveOptions = {
    approvedBy: request.approvedBy,
    // DEC-44: where the adapter cannot send the copy it parks, the ledger
    // holds the reply and this approval sends it. Read off the adapter at
    // startup, so the console never draws an editor the approval ignores.
    ...(deps.ledgerReply === true ? { ledgerReply: true } : {}),
    // DEC-45: the console only serves an identity it checked against the
    // roster, so the ledger records where this name came from.
    approvedBySource: 'roster',
    // DEC-46: the reply this page drew, so the approval can refuse a case
    // whose saved reply moved under the reviewer.
    shown: request.shown,
    // DEC-44: the reviewer's decision about a helpdesk copy a person edited.
    // The digest is of the copy the refusal drew, so a copy that moved again
    // refuses rather than being sent past on a stale decision.
    ...(request.copyAcknowledged === undefined
      ? {}
      : { copyAcknowledged: request.copyAcknowledged }),
    // DEC-51: the hold every console send waits, so a batch can be undone.
    ...(deps.sendHoldMs === undefined ? {} : { sendHoldMs: deps.sendHoldMs }),
    ...(deps.readDraft === undefined ? {} : { readDraft: deps.readDraft }),
  };
  try {
    return await deps.approveRun(deps.pool, runId, options);
  } catch (error) {
    if (error instanceof ReadBackFailed) {
      deps.onReadBackFailed?.(runId, error.message, error.draftExternalId);
      return error.permanent
        ? { outcome: 'read_back_not_a_note', fault: error.message }
        : { outcome: 'read_back_failed', fault: error.message };
    }
    throw error;
  }
}

/**
 * The approval the console's entry point hands its server.
 *
 * It reads the draft back through `readBack` when there is one, logs a failed
 * read-back with its run and its draft, and answers the outcome alone. The
 * page names the failure; the fault stays in the log.
 */
export function approvalFor(deps: {
  readonly pool: Pool;
  readonly approveRun: ApproveDeps['approveRun'];
  readonly readBack: ConsoleReadBack | null;
  readonly ledgerReply: boolean;
  /** DEC-51: the hold each send this console makes waits. */
  readonly sendHoldMs: number;
  readonly log: (record: Readonly<Record<string, unknown>>) => void;
}): (
  runId: string,
  approvedBy: string,
  shown: string,
  copyAcknowledged?: string,
) => Promise<ConsoleApproveOutcome['outcome']> {
  return async (runId, approvedBy, shown, copyAcknowledged) => {
    const outcome = await approveFromConsole(
      {
        pool: deps.pool,
        approveRun: deps.approveRun,
        ledgerReply: deps.ledgerReply,
        sendHoldMs: deps.sendHoldMs,
        ...(deps.readBack === null ? {} : { readDraft: deps.readBack.readDraft }),
        onReadBackFailed: (failedRun, fault, draftExternalId) => {
          deps.log({ event: 'console_read_back_failed', runId: failedRun, draftExternalId, fault });
        },
      },
      {
        runId,
        approvedBy,
        shown,
        ...(copyAcknowledged === undefined ? {} : { copyAcknowledged }),
      },
    );
    return outcome.outcome;
  };
}

/**
 * The undo the console's entry point hands its server (DEC-51).
 *
 * The same shape as `saveFor` and for the same reason: the entry point owns
 * the pool, and the server takes functions so it can be driven without one.
 * The window, the row lock and the refusal are the core's; this adds nothing
 * but the pool.
 */
export function undoFor(deps: {
  readonly pool: Pool;
  readonly undoApproval: (
    pool: Pool,
    runId: string,
    options: { readonly reviewer: string },
  ) => Promise<UndoOutcome>;
}): (runId: string, reviewer: string) => Promise<UndoOutcome> {
  return async (runId, reviewer) => deps.undoApproval(deps.pool, runId, { reviewer });
}

/**
 * The save the console's entry point hands its server.
 *
 * The same shape as `approvalFor`, and for the same reason: the entry point
 * owns the pool and the log, and the server takes functions so it can be
 * driven without either.
 */
export function saveFor(deps: {
  readonly pool: Pool;
  readonly saveReply: SaveDeps['saveReply'];
}): (runId: string, text: string, shown: string) => Promise<ConsoleSaveOutcome['outcome']> {
  return async (runId, text, shown) =>
    (await saveFromConsole(
      { pool: deps.pool, saveReply: deps.saveReply },
      { runId, text, shown },
    )).outcome;
}

/**
 * The close the console's entry point hands its server (DEC-48).
 *
 * A delegation, like the approval and the save: `closeRun` owns the
 * transaction, the DEC-46 guard and the journal row, and a second
 * implementation here would be a second set of rules about the same case.
 *
 * The identity travels with the source `roster`, as it does on the approval
 * path: the gate resolved it against the reviewer roster before this route
 * was reached, so what the ledger records is a checked name.
 */
export function closeFor(deps: {
  readonly pool: Pool;
  readonly closeRun: (
    pool: Pool,
    runId: string,
    options: CloseOptions,
  ) => Promise<CloseOutcome>;
  /**
   * DEC-44: whether the adapter's ledger holds the reply.
   *
   * Read off the adapter at startup, as the approval's is. It decides which
   * text the case drew, and so which text the guard compares: the reply a
   * person saved, or the body the park journaled.
   */
  readonly ledgerReply: boolean;
}): (
  runId: string,
  reviewer: string,
  reason: string,
  shown: string,
) => Promise<CloseOutcome['outcome']> {
  return async (runId, reviewer, reason, shown) => {
    // Refused here, as the approval and the save refuse it: `run_id` is a
    // `uuid` column, so a value of another shape makes the ledger raise rather
    // than answer `unknown_run`, and the page would blame the ledger for a
    // request that never reached it.
    const id = runId.trim();
    if (!RUN_ID.test(id)) throw new Error(`'${runId}' is not a run id`);
    return (await deps.closeRun(deps.pool, id, {
      reason,
      closedBy: reviewer,
      closedBySource: 'roster',
      ledgerReply: deps.ledgerReply,
      shown,
    })).outcome;
  };
}

/**
 * The snooze the console's entry point hands its server (DEC-48).
 *
 * A delegation, like the close: `snoozeRun` owns the transaction, the period,
 * the DEC-46 guard and the journal row. The identity travels with the source
 * `roster`, as it does on every other console write, because the gate
 * resolved it against the ledger's roster before the route was reached.
 *
 * The adapter's declaration travels too: it decides which text a page drew,
 * and so which text the guard compares.
 */
export function snoozeFor(deps: {
  readonly pool: Pool;
  readonly snoozeRun: (
    pool: Pool,
    runId: string,
    options: SnoozeOptions,
  ) => Promise<SnoozeOutcome>;
  readonly ledgerReply: boolean;
}): (
  runId: string,
  reviewer: string,
  periodMs: number,
  shown: string,
) => Promise<SnoozeOutcome['outcome']> {
  return async (runId, reviewer, periodMs, shown) => {
    const id = runId.trim();
    if (!RUN_ID.test(id)) throw new Error(`'${runId}' is not a run id`);
    return (await deps.snoozeRun(deps.pool, id, {
      periodMs,
      snoozedBy: reviewer,
      snoozedBySource: 'roster',
      ledgerReply: deps.ledgerReply,
      shown,
    })).outcome;
  };
}

/**
 * The send-back the console's entry point hands its server (DEC-49).
 *
 * A delegation, like the snooze: `sendBackRun` owns the transaction, the two
 * conditions, the DEC-46 guard and the journal row. The identity travels with
 * the source `roster`, because the gate resolved it against the ledger's
 * roster before the route was reached.
 *
 * The note travels unbounded, and that is deliberate: `sendBackRun` is what
 * bounds it, so the console has one implementation of the bound rather than a
 * second one that can drift from the page's field.
 *
 * The adapter's declaration travels too, and here it is half of the first
 * condition: where the helpdesk can send the copy it parks, there is a copy a
 * person could send and no new attempt is started.
 */
export function sendBackFor(deps: {
  readonly pool: Pool;
  readonly sendBackRun: (
    pool: Pool,
    runId: string,
    options: SendBackOptions,
  ) => Promise<SendBackOutcome>;
  readonly ledgerReply: boolean;
}): (
  runId: string,
  reviewer: string,
  note: string,
  shown: string,
) => Promise<SendBackOutcome['outcome']> {
  return async (runId, reviewer, note, shown) => {
    const id = runId.trim();
    if (!RUN_ID.test(id)) throw new Error(`'${runId}' is not a run id`);
    return (await deps.sendBackRun(deps.pool, id, {
      note,
      sentBackBy: reviewer,
      sentBackBySource: 'roster',
      ledgerReply: deps.ledgerReply,
      shown,
    })).outcome;
  };
}

/**
 * The rewrite the console's entry point hands its server (DEC-48).
 *
 * A delegation, like the snooze: `rewriteReply` owns the transaction, the
 * turn it writes on, the DEC-46 guard and the journal row. The identity
 * travels with the source `roster`, because the gate resolved it against the
 * ledger's roster before the route was reached.
 *
 * The adapter's declaration travels too, and here it is the whole condition:
 * only where the ledger holds the reply does a reply written in the console
 * reach the customer. `rewriteReply` refuses the draft path by name.
 */
export function rewriteFor(deps: {
  readonly pool: Pool;
  readonly rewriteReply: (
    pool: Pool,
    runId: string,
    text: string,
    options: RewriteOptions,
  ) => Promise<RewriteOutcome>;
  readonly ledgerReply: boolean;
}): (
  runId: string,
  reviewer: string,
  text: string,
  shown: string,
) => Promise<RewriteOutcome['outcome']> {
  return async (runId, reviewer, text, shown) => {
    const id = runId.trim();
    if (!RUN_ID.test(id)) throw new Error(`'${runId}' is not a run id`);
    return (await deps.rewriteReply(deps.pool, id, text, {
      rewrittenBy: reviewer,
      rewrittenBySource: 'roster',
      ledgerReply: deps.ledgerReply,
      shown,
    })).outcome;
  };
}
