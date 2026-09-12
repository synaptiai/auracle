// The console's one write (issue #27, DEC-11, DEC-40).
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
// This is the console's only statement against the ledger that is not a
// SELECT, and `select-only.test.ts` is what holds that claim to one.
import type { Pool } from 'pg';
import type { ApproveOptions, ApproveOutcome } from 'auracle/ledger-read';

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
 * one cost a pool connection and a round trip on an endpoint that
 * authenticates nobody. One definition, so the read and the write agree.
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
}

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
   * Passed through rather than defaulted. `approveRun` bounds what it keeps
   * and records `unattributed` for anything else, and two places deciding
   * that would eventually disagree about which one an operator is reading.
   */
  readonly approvedBy?: string;
}

export async function approveFromConsole(
  deps: ApproveDeps,
  request: ApproveRequest,
): Promise<ApproveOutcome> {
  const runId = request.runId.trim();
  if (!RUN_ID.test(runId)) {
    throw new Error(`'${request.runId}' is not a run id`);
  }
  // No final body and no read-back: this is the CLI's manual path, the one
  // `pnpm run approve` takes without `--read-back`. The distance stays null,
  // which is the truthful reading when nobody captured what the person sent.
  const options: ApproveOptions =
    request.approvedBy === undefined ? {} : { approvedBy: request.approvedBy };
  return deps.approveRun(deps.pool, runId, options);
}
