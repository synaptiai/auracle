/**
 * Approval completion entrypoint (section 4.2). Obeys DEC-11, DEC-12,
 * DEC-24, DEC-28, DEC-29, DEC-40.
 *
 * An operator, or the adopter's helpdesk webhook, calls this after a person
 * approves a parked draft in the helpdesk UI. The draft parks in the helpdesk
 * and nowhere else (DEC-11). DEC-40 permits an operator console to call this
 * as well, and one ships: the `@auracle/console` package's approval surface
 * calls this through `approveFromConsole`. So there are two callers and one
 * implementation — the console has no approval of its own, and the
 * transaction and the fencing epoch are the ones this function commits
 * whichever path an operator used. The console passes no `finalBody`: the
 * outbox payload for a draft-backed park is `{ draftExternalId }` and the
 * relay sends that draft verbatim, so a body supplied here is recorded and
 * never sent. Read-back is the honest way to measure an edit.
 *
 * DEC-44 adds the second path through here. A caller whose adapter cannot
 * send the copy it parks passes `ledgerReply`: the approval then resolves
 * the text from the ledger — the reply a person saved, or the body the park
 * journaled — checks the copy against what the park put there, and writes
 * that text onto the outbox record for the relay to send.
 *
 * The copy is read once, before the transaction opens, and its answer is
 * checked against the digest the caller supplies. What that covers, and what
 * it does not: a copy a person edited before this call is either sent or
 * refused, so it is never discarded unseen. An edit that lands between this
 * read and the relay's send is not seen by anything — the relay posts what
 * the outbox record holds, and a capable adapter declares no read-back at the
 * send (DEC-30). The window is stated here and in the runbook because a lost
 * helpdesk edit is otherwise mistaken for a system that refused nothing.
 *
 * One transaction does all of:
 *   1. refuse the move unless the run sits in `awaiting_approval` (DEC-12)
 *   2. read the fencing epoch against ticket_epoch (DEC-28), under the same row
 *      lock. A parked run passes it whatever the fence says: a person's write
 *      is not an old owner's write, and a deploy that raised the fence was
 *      refusing the approval the reply needed
 *   3. commit the run's next state
 *   4. insert the relayable outbox record
 *   5. when a final body was captured or read back, record the
 *      approval-edit distance (section 4.10) so the metric commits with
 *      the state move
 *
 * The outbox record carries payload `{ draftExternalId }` for a parked
 * draft, or the journaled action payload for a ledger-only park (V2
 * compensation), plus the semantic idempotency key (DEC-24) and the
 * delivery rule the action class declared (DEC-29). An insert of zero rows
 * is a distinct result (section 4.2 rule 2):
 * the run lands 'superseded', never resolved with a phantom record.
 */
import type { Pool, PoolClient } from 'pg';

import type {
  DraftReadBack, PersonProvenance, Provenance, ReplyProvenance,
} from '../adapters/types.js';
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import {
  lockTurnAttempt, readSavedReply, recordApprovedReply, turnIsClosed,
} from '../ledger/conversation.js';
import { fencedTransition } from '../ledger/insert.js';
import { deriveIdemKey } from '../ledger/keys.js';
import { approverFrom, type NameSource, sourceOf } from './approver.js';
import { releaseHoldIn } from '../holds/hold.js';
import { recordApprovalEditDistance } from './measure.js';
import { copyEditWouldBeLost, copyHoldsText } from './reply-copy.js';
import { replyDigest } from './shown.js';

export type ApproveOutcome =
  | {
      readonly outcome: 'approved';
      readonly idemKey: string;
      /**
       * DEC-44: present when this approval sent the ledger's reply past a
       * helpdesk copy a person had edited, on a caller's acknowledgement.
       *
       * A bare `true`, and not the digest the caller supplied: the fact worth
       * recording is that a person's edit was set aside on purpose, and the
       * text it was set aside for is the reply the outbox record holds.
       */
      readonly copyAcknowledged?: true;
    }
  | { readonly outcome: 'unknown_run' }
  | { readonly outcome: 'not_awaiting_approval'; readonly state: string }
  /** Section 4.2 rule 2: another semantic action already holds the key. */
  | { readonly outcome: 'superseded' }
  /**
   * The fence refused the write. Since the fix for stranded approvals, no
   * caller reaches this arm from here: a run parked in `awaiting_approval` is
   * outside the fence's reach (src/ledger/insert.ts), so a person's approval
   * commits whatever the ticket's fence says. It stays in the union because the
   * console maps every outcome by name, and removing it would leave that
   * mapping to fail on a value it could still be handed by a later parked
   * state.
   */
  | { readonly outcome: 'stale_epoch'; readonly highestAcceptedEpoch: bigint }
  /**
   * Read-back found no draft in the target system. The approval refuses:
   * approving a missing draft would fabricate the edit distance
   * (section 4.10). The operator reconciles the draft by hand, then
   * approves again.
   */
  | { readonly outcome: 'draft_missing'; readonly draftExternalId: string }
  /**
   * DEC-46: the reply the caller was shown is not the reply the ledger holds.
   * The console refuses to send a decision a person made on other text, and
   * the change is the reply: a run that left `awaiting_approval` is refused
   * above, as `not_awaiting_approval`, which names that state.
   */
  | { readonly outcome: 'shown_changed' }
  /**
   * DEC-44: a person edited the copy in the helpdesk after the park. The
   * design refuses to discard that edit silently, so both texts travel with
   * this outcome: the reply the ledger would send, and the copy as it reads
   * now. The caller shows them and lets the person choose. Nothing is sent.
   */
  | {
      readonly outcome: 'copy_changed';
      /** The text the approval was about to send: the ledger's reply. */
      readonly ledgerText: string;
      /** The copy the target system holds, as it reads now. */
      readonly copyText: string;
    }
  /**
   * DEC-44, DEC-14: the reply the ledger holds carries no disclosure, so it
   * may not be sent. Only a park that an earlier version journaled has no
   * disclosure beside its body: the adapters refuse an empty one at park
   * time, so a new reply always has one.
   */
  | { readonly outcome: 'no_disclosure' }
  /**
   * DEC-48: the reply the ledger holds is a person's, and the author it
   * records is not one this approval can state.
   *
   * Only a ledger written by something else reaches this: the rewrite writes
   * the provenance in the same statement as the text. It is its own outcome
   * because naming the model instead would name an author who did not write
   * the text, and the remedy `no_disclosure` gives an operator does not apply.
   */
  | { readonly outcome: 'rewrite_incomplete' }
  /**
   * DEC-49: a reviewer sent this attempt back, so the turn is on a later one.
   *
   * Two runs of one turn can wait at one attempt — a message redelivered
   * after its ack joins the attempt its turn is on — and a send-back of one
   * rejects the attempt, not the run. The other still shows the same reply,
   * and approving it would send the reply the reviewer rejected beside the
   * new attempt's. Nothing is sent.
   */
  | { readonly outcome: 'sent_back' }
  /**
   * DEC-49: the turn already holds a reply that reached the customer, may
   * have, or will. A turn takes one reply, and a second would reach a
   * customer who has one. Nothing is sent.
   *
   * The console cannot reach this after a send-back on its own: it refuses a
   * send-back on a closed turn and an approval of a rejected attempt. It
   * guards a turn another path wrote to — a seed, a replay, a run of the
   * conversation with no turn — and a twin run of the turn, refused here
   * rather than on the key collision.
   */
  | { readonly outcome: 'turn_closed' };

/** Optional inputs for one approval. */
export interface ApproveOptions {
  /**
   * The final text the person sent, when it differs from or completes the
   * parked draft. Passing it records the approval-edit distance
   * (section 4.10) inside the approval transaction. An explicit final body
   * wins over `readDraft`.
   */
  readonly finalBody?: string;
  /**
   * Draft read-back for the approval path (section 4.10). With no explicit
   * `finalBody`, the approval reads the parked draft's current body from
   * the target system, so the distance measures what the person actually
   * edited (DEC-11). A read-back that finds no draft refuses the approval.
   */
  readonly readDraft?: DraftReadBack;
  /**
   * DEC-42: who approved, as a claim rather than an authentication.
   *
   * A caller supplies this only when a trusted proxy named the approver. The
   * console reads that header only through its roster (DEC-45), and passes
   * the identity it verified. A command-line approval names nobody and
   * records `none`.
   *
   * Absent records `unattributed`, which is a statement that nobody was
   * named. It is not the same as the column's null, which is a run no
   * approval reached.
   */
  readonly approvedBy?: string;
  /**
   * DEC-45: how the name was established, recorded beside it.
   *
   * `roster` means a console checked the identity against the reviewer
   * roster. `header` is DEC-42's claim, and it is the default, because a
   * caller that names one at all is claiming rather than proving. A caller
   * that names nobody records `none` whatever it passes here.
   */
  readonly approvedBySource?: NameSource;
  /**
   * DEC-44: this approval's target system cannot send the copy it parks, so
   * the ledger holds the reply and this approval sends it.
   *
   * The text is the turn's saved reply when a person saved one, the parked
   * body otherwise. With `readDraft`, two questions decide a refusal, and
   * `copyEditWouldBeLost` states both: did a person edit the copy in the
   * helpdesk after the park, and is the text about to be sent something other
   * than that edit? A copy that answers both yes refuses as `copy_changed`,
   * with both texts, rather than being sent or discarded in silence. A
   * reviewer's own edit in the console is not compared — it is what this path
   * exists to send — and neither is the copy itself once that is the text the
   * reviewer chose to send.
   *
   * A caller that says both this and `finalBody` says two things about which
   * text to send, so the approval refuses the pair instead of picking one.
   */
  readonly ledgerReply?: boolean;
  /**
   * DEC-46: the digest of the reply the reviewer was shown, when a page
   * showed them one.
   *
   * The console draws a case from the parked reply and carries
   * `replyDigest(body)` in its approval form. Supplied, it is recomputed
   * under the run's row lock against the reply the ledger holds now, and a
   * mismatch refuses the approval (`shown_changed`) — so the guard cannot be
   * outrun by a reply rewritten between the page and the press.
   *
   * Absent means no page: `pnpm run approve` passes none and is exempt, and
   * so is any caller that read the case itself.
   */
  readonly shown?: string;
  /**
   * DEC-44: the digest of the helpdesk copy a person read and decided to send
   * past, when the copy differs from the reply the ledger holds.
   *
   * The refusal shows both texts and lets a reviewer choose. Choosing the
   * helpdesk copy is a save, and the approval that follows sends it. Choosing
   * the ledger's reply has no such move: the copy is in a helpdesk this
   * system cannot write into, so the two texts never agree on their own. This
   * is how that choice is made — and it is bound to the text the person read,
   * because it is the digest of that copy. A copy that changed once more does
   * not match, so it refuses again rather than discarding the newer edit.
   *
   * It never suppresses the refusal for a copy nobody was shown: the digest
   * has to be of the copy this approval read.
   */
  readonly copyAcknowledged?: string;
  /**
   * DEC-51: this caller's send waits this many milliseconds before the relay
   * may post it, when the ledger holds the reply.
   *
   * The console's batch sets it, so a reviewer who confirmed by mistake can
   * undo. Absent is no hold: the command line, and every caller that offers
   * no undo, send immediately. It applies to the ledger-held path alone — a
   * reply on the DEC-40 draft path can be sent from the helpdesk by hand at
   * any moment, so a hold there would promise nothing.
   */
  readonly sendHoldMs?: number;
}

/** What the coordinator's `park` step recorded in the journal. */
interface ParkRecord {
  /** Present when the park created a helpdesk draft (customer replies). */
  readonly draftExternalId?: string;
  actionClass: string;
  delivery: 'at_least_once' | 'at_most_once';
  /** The parked body exactly as the approval bridge recorded it (section 4.10). */
  body: string;
  /**
   * V2: present when the park carried no adapter call (compensation). The
   * payload approveRun copies onto the outbox record verbatim.
   */
  readonly payload?: Record<string, unknown>;
  /**
   * DEC-38: the turn that requested this action, when the run had one. A
   * park journaled before DEC-38 has none, and its key keeps the V1 form,
   * so an approval in flight across the upgrade still matches its record.
   */
  readonly turnNumber?: number;
  /**
   * DEC-49: which attempt of that turn the park was. The approval derives
   * the outbox key from this record, so the attempt has to survive the wait
   * beside the turn, exactly as the turn survives it. Absent on a park
   * written before db/031, which was the first attempt of its turn.
   */
  readonly attempt?: number;
  /**
   * DEC-44: the adopter's disclosure and the reply's provenance (DEC-14,
   * DEC-33), journaled so an approval that sends this reply from the ledger
   * attaches what the adapter would have attached. Absent on a park that an
   * earlier version journaled, which is what `no_disclosure` names.
   */
  readonly disclosure?: string;
  readonly provenance?: ReplyProvenance;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A person's provenance (DEC-48), or nothing.
 *
 * The two strings a reply a person wrote carries, and no model and no prompt.
 * A record holding anything else is not a provenance this approval can state,
 * and naming the model instead would name an author who did not write it.
 */
function heldProvenance(value: unknown): PersonProvenance | null {
  if (!isPlainObject(value)) return null;
  const generatedBy = value['generatedBy'];
  const generatedAt = value['generatedAt'];
  if (typeof generatedBy !== 'string' || generatedBy.length === 0) return null;
  if (typeof generatedAt !== 'string' || generatedAt.length === 0) return null;
  return { generatedBy, generatedAt };
}

/**
 * The author a turn's reply holds, as one comparable value (DEC-48).
 *
 * Three answers: no person wrote it (either a null column or an absent row),
 * a person did, or the column holds something no reply can carry. The third
 * is its own string so that it compares unequal to both of the others: a
 * guard that read an unreadable provenance as "nobody wrote it" would send
 * the reply under the model's name, which is the claim it exists to refuse.
 */
function authorKey(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  const held = heldProvenance(value);
  return held === null ? 'unreadable' : JSON.stringify([held.generatedBy, held.generatedAt]);
}

/** The four strings a provenance record carries (DEC-33), or nothing. */
function isProvenance(value: unknown): value is ReplyProvenance {
  if (!isPlainObject(value)) return false;
  return (['generatedBy', 'modelId', 'promptVer', 'generatedAt'] as const).every(
    (field) => typeof value[field] === 'string' && (value[field] as string).length > 0,
  );
}

function parkRecordFrom(journalResult: unknown): ParkRecord {
  if (!isPlainObject(journalResult)) {
    throw new Error('park journal step carries no result object');
  }
  const r = journalResult;
  const draftExternalId = r['draftExternalId'];
  const actionClass = r['actionClass'];
  const delivery = r['delivery'];
  const body = r['body'];
  const payload = r['payload'];
  const turnNumber = r['turnNumber'];
  const attempt = r['attempt'];
  const disclosure = r['disclosure'];
  const provenance = r['provenance'];
  if (
    (draftExternalId !== undefined && (typeof draftExternalId !== 'string' || draftExternalId.length === 0))
    || typeof actionClass !== 'string'
    || actionClass.length === 0
    || typeof body !== 'string'
    || body.length === 0
    || (delivery !== 'at_least_once' && delivery !== 'at_most_once')
    || (payload !== undefined && !isPlainObject(payload))
    || (turnNumber !== undefined
        && (typeof turnNumber !== 'number' || !Number.isInteger(turnNumber)))
    // DEC-49: the attempt a park was written for. A zero, a fraction or a
    // string is not an attempt this approval can derive a key from, and
    // reading it as the first attempt would send the key of a record that
    // belongs to another request.
    || (attempt !== undefined
        && (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1))
    || (disclosure !== undefined && (typeof disclosure !== 'string' || disclosure.length === 0))
    || (provenance !== undefined && !isProvenance(provenance))
  ) {
    throw new Error('park journal result is malformed for approval');
  }
  return {
    ...(draftExternalId === undefined ? {} : { draftExternalId }),
    actionClass,
    delivery,
    body,
    ...(payload === undefined ? {} : { payload }),
    ...(turnNumber === undefined ? {} : { turnNumber }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(disclosure === undefined ? {} : { disclosure }),
    ...(provenance === undefined ? {} : { provenance }),
  };
}

/**
 * Thrown for a ledger-only park that journaled no payload. The record can
 * never relay, so approval refuses instead of inserting a phantom outbox
 * row.
 */
function throwMalformedPark(actionClass: string): never {
  throw new Error(
    `park journal result for action class '${actionClass}' carries neither a draft handle nor an action payload`,
  );
}

/**
 * Approve one parked action and queue it for the relay: a customer reply
 * parked as a helpdesk draft (DEC-11), or a V2 compensation of an
 * irreversible action parked in the ledger alone.
 *
 * With `options.finalBody`, the same transaction also records the
 * approval-edit distance (section 4.10) between the parked draft and that
 * final text: a crash can never lose one side of the pair. Omit it when no
 * body was captured; the distance then stays null on the run. With
 * `options.readDraft` and no explicit body, the approval instead reads the
 * draft's current body from the target system, so the distance measures
 * what the person actually edited. A read-back that finds no draft
 * refuses: the operator reconciles by hand, and nothing commits.
 *
 * The run moves to `resolved`: the person's work here is done, exactly as
 * the automatic path resolves once its outbox record commits. If the send
 * later fails into an unknown state, the relay escalates the run (DEC-30).
 *
 * DEC-51 is the one write that moves a run back out of a terminal state: a
 * caller that asked for a hold may undo it inside that window, and
 * `src/approval/undo.ts` returns the run to `awaiting_approval` and clears
 * everything this function wrote.
 */
export async function approveRun(
  pool: Pool,
  runId: string,
  options?: ApproveOptions,
): Promise<ApproveOutcome> {
  const rows = await pool.query(
    `SELECT ticket_id, state, cost_micros, steps_used, conversation_id
       FROM run WHERE run_id = $1`,
    [runId],
  );
  if (rows.rows.length === 0) {
    return { outcome: 'unknown_run' };
  }
  const row = rows.rows[0]!;
  const state = row.state as string;
  if (state !== 'awaiting_approval') {
    return { outcome: 'not_awaiting_approval', state };
  }

  const parked = await pool.query(
    "SELECT result FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
    [runId],
  );
  if (parked.rows.length === 0) {
    throw new Error(`run ${runId} awaits approval but journals no park step`);
  }
  const park = parkRecordFrom(parked.rows[0]!.result);

  // Draft-backed parks relay `sendDraft` against the parked handle;
  // ledger-only parks (V2 compensation) relay their journaled action
  // payload through `performAction`. Either way the idempotency key comes
  // from the action semantics (DEC-24), never from this run's identity.
  const outboxPayload: Record<string, unknown> =
    park.draftExternalId !== undefined
      ? { draftExternalId: park.draftExternalId }
      : park.payload ?? throwMalformedPark(park.actionClass);

  // Read before the key is derived: a turn number is only unique inside its
  // conversation, so the key needs both (DEC-35, DEC-38).
  const conversationId = row.conversation_id as string | null;

  const idemKey = deriveIdemKey({
    actionClass: park.actionClass,
    ticketId: row.ticket_id as string,
    // DEC-38: two turns asking for the same thing are two requests, on the
    // approval path exactly as on the automatic one.
    ...(park.turnNumber === undefined ? {} : { turnNumber: park.turnNumber }),
    conversationId,
    // DEC-49: the attempt the park belongs to. An approval of a later
    // attempt without it would derive the first attempt's key, lose the
    // outbox insert and stop the run superseded.
    ...(park.attempt === undefined ? {} : { attempt: park.attempt }),
    payload: outboxPayload,
  });

  // DEC-44: a caller that says the ledger holds the reply and also names a
  // body says two things about which text to send, so the pair is refused
  // rather than resolved by a precedence no reader of the call can see.
  const ledgerReply = options?.ledgerReply === true;
  if (ledgerReply && options?.finalBody !== undefined) {
    throw new TypeError(
      'approveRun was given both ledgerReply and finalBody: the ledger holds the reply, '
        + 'so a caller cannot also name the text to send',
    );
  }

  // Resolve the final body (section 4.10). On DEC-44's path the ledger holds
  // it: the reply a person saved, or the body the park journaled when nobody
  // saved one. Otherwise an explicit capture wins; failing that, for a
  // draft-backed park, read-back fetches what the person actually edited in
  // the target system. A ledger-only park holds no draft to read, so its
  // distance stays null. The read happens before the transition opens: the
  // distance records what the target system held at read time.
  let finalBody = options?.finalBody;
  // DEC-44: the reply the outbox record carries, when the ledger holds it.
  // Built here with the text it sends, and kept out of `payload`: the payload
  // is hashed into the idempotency key, and DEC-49 keeps the body out of it,
  // so an edited reply must not derive a second key.
  let outboxReply: Record<string, unknown> | undefined;
  /** DEC-44: the reply the ledger holds, when this approval sends it. */
  let ledgerText: string | undefined;
  /** DEC-48: the author the payload was built from, as the turn held it. */
  let ledgerAuthor: unknown;
  /** DEC-51: how long the record is held, when this caller holds it. */
  let holdMs: number | undefined;
  /** DEC-49: set by the precondition when the turn is on a later attempt. */
  let attemptRejected = false;
  /** DEC-49: set by the precondition when the turn already holds a reply. */
  let turnClosed = false;
  // DEC-44 governs a customer reply, and only a customer reply: that is the
  // park which carries a handle into the target system. A ledger-only park
  // (DEC-34 compensation) holds no reply and journals no disclosure, so it
  // takes the path it always took, and `performAction` still performs it.
  const holdsACustomerReply = ledgerReply && park.draftExternalId !== undefined;
  if (holdsACustomerReply) {
    if (park.disclosure === undefined || park.provenance === undefined) {
      // DEC-44, DEC-14: every customer reply carries the adopter's disclosure
      // and its provenance (DEC-33). The park journals both, so a park
      // without them is one an earlier version wrote, and the approval
      // cannot attach what the ledger does not hold.
      return { outcome: 'no_disclosure' };
    }
    // The reply and its author in one statement. A rewrite commits the
    // turn's text and its journal row together, so two reads could take the
    // text from one commit and the author from another, and the record would
    // then send a person's words under the model's name (DEC-48). The empty
    // string reads as no saved reply, the rule `readSavedReply` applies.
    // The author travels with the text, because a turn is served by every run
    // that answers it: a retry after a crash, or a send-back, parks a second
    // run on the same turn. Reading the author from this run's own journal
    // made the run the author of a text a sibling run's reviewer rewrote, and
    // the customer received a person's words under the model's name (DEC-48).
    const held = await pool.query(
      `SELECT NULLIF(saved.saved_reply_text, '') AS saved_reply,
              saved.saved_reply_provenance     AS saved_provenance
         FROM run r
         LEFT JOIN turn saved
           ON saved.conversation_id = r.conversation_id AND saved.turn_number = $2
        WHERE r.run_id = $1`,
      [runId, park.turnNumber ?? null],
    );
    const heldRow = held.rows[0];
    if (heldRow === undefined) {
      throw new Error(`run ${runId} vanished between its park read and the reply read`);
    }
    // Null means the reply the park journaled: the model's, whatever this run
    // recorded. An object means a person wrote the reply the customer
    // receives.
    const written = heldRow.saved_provenance;
    // Kept raw for the in-transaction guard, which compares it with what the
    // turn holds then.
    ledgerAuthor = written;
    let authored: Provenance = park.provenance;
    if (written !== null && written !== undefined) {
      const held = heldProvenance(written);
      if (held === null) {
        // DEC-33, DEC-48: the column holds something no reply can carry. The
        // approval cannot state who wrote the text, and naming the model
        // would name an author who did not write it. Its own outcome, because
        // the cause is this ledger's and the remedy the operator is given for
        // a missing disclosure does not apply here.
        return { outcome: 'rewrite_incomplete' };
      }
      authored = held;
    }
    const replyText = (heldRow.saved_reply as string | null) ?? park.body;
    finalBody = replyText;
    ledgerText = replyText;
    outboxReply = {
      bodyText: replyText,
      disclosure: park.disclosure,
      provenance: authored,
    };
    // DEC-51: the console's batch holds its sends, so an undo inside the
    // window can return the run to approval. The moment is resolved here, at
    // the approval, and written onto the record: the relay reads the record.
    if (options?.sendHoldMs !== undefined) {
      // A value that is not whole milliseconds at or above zero is a caller
      // defect. It would reach the insert as `$9::bigint` and raise a driver
      // error naming neither the option nor a range — the outcome this check
      // exists to prevent. A safe integer is the widest value that survives
      // that cast without a precision loss the caller did not ask for.
      if (!Number.isSafeInteger(options.sendHoldMs) || options.sendHoldMs < 0) {
        throw new TypeError(
          `sendHoldMs must be whole milliseconds at or above zero, `
            + `got ${String(options.sendHoldMs)}`,
        );
      }
      holdMs = options.sendHoldMs;
    }
  } else if (
    finalBody === undefined
    && options?.readDraft !== undefined
    && park.draftExternalId !== undefined
  ) {
    const read = await options.readDraft.readDraft(park.draftExternalId);
    if (read === null) {
      return { outcome: 'draft_missing', draftExternalId: park.draftExternalId };
    }
    finalBody = read.body;
  }

  // DEC-44: with the ledger holding the reply, a read-back is a check and not
  // a source. Two questions decide the refusal, and `copyEditWouldBeLost`
  // states both: did a person edit the copy in the helpdesk after the park,
  // and is the text about to be sent something other than that edit?
  //
  // Neither question alone is right. Comparing the copy against the parked
  // body alone refuses every console edit, which is the thing DEC-44 exists
  // to allow. Comparing it against the text to send alone refuses a reviewer
  // who chose the copy, and would leave no way to send the text the refusal
  // was about.
  //
  // A copy that cannot be read — no read-back configured, or none found —
  // leaves nothing to compare and the send proceeds: on this path the parked
  // copy was never the text that sends, so its absence strands nothing. A copy
  // whose text a person cleared reads the same way, for the same reason
  // (`copyHoldsText`).
  //
  // The acknowledgement is checked here, against the copy this call read. A
  // caller that says it read one copy and a helpdesk that holds another is a
  // refusal, not a send: the person acknowledged text they were shown.
  let copyAcknowledged = false;
  if (
    ledgerText !== undefined
    && options?.readDraft !== undefined
    && park.draftExternalId !== undefined
  ) {
    const read = await options.readDraft.readDraft(park.draftExternalId);
    const copyText = read?.body ?? null;
    if (copyHoldsText(copyText) && copyEditWouldBeLost(park.body, ledgerText, copyText)) {
      if (options.copyAcknowledged !== replyDigest(copyText)) {
        return { outcome: 'copy_changed', ledgerText, copyText };
      }
      copyAcknowledged = true;
    }
  }

  // The reply the person approved is the agent's half of the conversation
  // (DEC-37). Three conditions must hold, and each one has a reason:
  // a ledger-only park has no customer-visible text (DEC-34), a V1-era run
  // has no conversation, and a park from before DEC-38 carries no turn.
  const reply =
    park.draftExternalId !== undefined
    && conversationId !== null
    && park.turnNumber !== undefined
      ? {
          conversationId,
          turnNumber: park.turnNumber,
          bodyText: finalBody ?? park.body,
        }
      : undefined;

  // DEC-42: recorded on every approval, so the absence of a proxy is a
  // recorded fact rather than a missing row. Trimmed, and a caller that
  // supplies only whitespace named nobody.
  const approver = approverFrom(options?.approvedBy);
  // DEC-45: the source travels with the name, and a name nobody holds has
  // no source to record. A refused name reads `none` beside `unattributed`,
  // which is what the migration gives every historical row of that shape.
  const approverSource = sourceOf(approver, options?.approvedBySource);

  const afterWrite = async (client: PoolClient): Promise<void> => {
    if (finalBody !== undefined) {
      // Section 4.2 rule 1 applied to the measurement: the edit distance
      // commits with the approval, or not at all.
      await recordApprovalEditDistance(client, {
        runId,
        parkedBody: park.body,
        finalBody,
      });
    }
    if (reply !== undefined) {
      await recordApprovedReply(client, reply);
    }
    // DEC-42 and DEC-45, in the approval transaction for the same reason: an
    // approver recorded outside it would name a person for a move that did
    // not commit. The pair commits together, and the CHECK holds them
    // together: a name without its source is a row no reader can classify.
    await client.query(
      'UPDATE run SET approved_by = $2, approved_by_source = $3 WHERE run_id = $1',
      [runId, approver, approverSource],
    );
    // DEC-46: sending ends the hold on the case, in this transaction.
    // Released outside it, a hold would outlive an approval that rolled back
    // — and the case would read as still being worked by somebody whose send
    // never happened.
    //
    // Every approval releases, a caller that named nobody included: the case
    // has left the queue either way, and a hold left on it would be recorded
    // as a lapse twenty minutes later instead of the send that ended it.
    // `released_by` carries the ledger's own word for a nameless approver,
    // which is the same word `run.approved_by` records.
    await releaseHoldIn(client, { runId, reviewer: approver, kind: 'send' });
  };

  const shown = options?.shown;
  // DEC-44: the text this approval sends was resolved before the transition
  // opened, and the outbox row is built from it. So the digest checked under
  // the lock is the caller's when a page supplied one, and otherwise the
  // digest of the text this call means to send — a caller that read the
  // ledger itself is still holding the reply it read.
  const guardDigest = shown
    ?? (ledgerText === undefined ? undefined : replyDigest(ledgerText));
  const moved = await fencedTransition(pool, {
    runId,
    state: 'resolved',
    costMicros: row.cost_micros as number,
    stepsUsed: row.steps_used as number,
    fromState: 'awaiting_approval',
    // DEC-46: the reply the reviewer was shown, against the reply the ledger
    // holds now — read here, inside the transaction that takes the row lock,
    // and before anything is written. Read outside it, the guard has a window
    // between the check and the write, which is the change it exists to catch.
    refuseIf: async (client: PoolClient): Promise<boolean> => {
      // DEC-49: the turn's lock first, whatever else this approval checks. A
      // send-back raises the turn's attempt under the same lock, so an
      // attempt a reviewer rejected cannot be approved by a second reviewer
      // who read it a moment before — the two writes are ordered here.
      if (conversationId !== null && park.turnNumber !== undefined) {
        const turnAttempt = await lockTurnAttempt(client, {
          conversationId, turnNumber: park.turnNumber,
        });
        if (turnAttempt !== null && turnAttempt > (park.attempt ?? 1)) {
          attemptRejected = true;
          return true;
        }
        // DEC-49: and a reply on a turn that already holds a reply that went
        // out, may have, or will. Read under the same lock, so a second
        // approval on the turn cannot add its record between this read and that
        // one's. A reply is a park that names a draft, or the reply's action
        // class parked in the ledger alone; a compensation is not one (DEC-34),
        // so it is not asked.
        if ((park.draftExternalId !== undefined || park.actionClass === CUSTOMER_REPLY_ACTION_CLASS)
          && await turnIsClosed(
            client, { conversationId, turnNumber: park.turnNumber }, { replies: true },
          )) {
          turnClosed = true;
          return true;
        }
      }
      if (guardDigest === undefined) return false;
      const held = await client.query(
        "SELECT result->>'body' AS body FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
        [runId],
      );
      // A row that is gone, or a body that is not text, refuses: the
      // approval cannot show what the reviewer read, so it does not send.
      const body = held.rows[0]?.body as unknown;
      if (typeof body !== 'string') return true;
      // DEC-44: on a path where the ledger holds the reply, what the
      // reviewer read is the text that sends — the saved reply when a
      // person saved one, the parked body otherwise — so that is what the
      // digest is recomputed against.
      const saved = ledgerReply
        ? await readSavedReply(client, { conversationId, turnNumber: park.turnNumber })
        : null;
      const current = saved ?? body;
      if (replyDigest(current) !== guardDigest) return true;
      // And the text about to be sent is the text this read returned. It
      // was resolved outside the lock, so a save that landed between that
      // read and this one would otherwise be sent while the case records
      // the text this guard just approved.
      if (ledgerText !== undefined && replyDigest(current) !== replyDigest(ledgerText)) {
        return true;
      }
      // DEC-48: and its author, which the text cannot vouch for — a rewrite
      // that repeats the text it replaced leaves every digest unchanged, and
      // the act is what decides who wrote it. Read under the lock and
      // compared with what the payload was built from.
      if (!ledgerReply) return false;
      const author = await client.query<{ provenance: unknown }>(
        'SELECT saved_reply_provenance AS provenance FROM turn'
          + ' WHERE conversation_id = $1 AND turn_number = $2',
        [conversationId, park.turnNumber ?? null],
      );
      return authorKey(author.rows[0]?.provenance) !== authorKey(ledgerAuthor);
    },
    outbox: {
      stepId: 'approve',
      idemKey,
      actionClass: park.actionClass,
      delivery: park.delivery,
      payload: outboxPayload,
      ...(outboxReply === undefined ? {} : { reply: outboxReply }),
      ...(holdMs === undefined ? {} : { holdMs }),
    },
    afterWrite,
  });

  switch (moved.outcome) {
    case 'accepted':
      return {
        outcome: 'approved',
        idemKey,
        ...(copyAcknowledged ? { copyAcknowledged: true as const } : {}),
      };
    case 'wrong_state':
      // Lost a race with another approve call; it re-checked under the lock.
      return { outcome: 'not_awaiting_approval', state: moved.currentState };
    case 'superseded':
      // Another run already holds this semantic key, so this run's send did
      // not happen: it records no approver and nothing left the ledger for
      // it. A hold left on the case ends by its period, which is the one
      // record that is true of it — a `send` here would name somebody who
      // sent nothing. The design record states the rule.
      return { outcome: 'superseded' };
    case 'stale_epoch':
      return { outcome: 'stale_epoch', highestAcceptedEpoch: moved.highestAcceptedEpoch };
    case 'refused':
      // Three preconditions, and the flags say which refused: the turn moved
      // to a later attempt, the turn already holds a reply, or the reply
      // changed under the reviewer.
      if (attemptRejected) return { outcome: 'sent_back' };
      if (turnClosed) return { outcome: 'turn_closed' };
      return { outcome: 'shown_changed' };
    case 'unknown_run':
      // The row existed above; runs are never deleted.
      throw new Error(`run vanished between read and transition: ${runId}`);
  }
}
