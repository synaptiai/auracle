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
  ApproveOptions, ApproveOutcome, DraftReadBack, SaveOutcome, SaveReplyOptions,
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
