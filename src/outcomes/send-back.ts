/**
 * A case a reviewer sends back for a new attempt (DEC-49).
 *
 * Some replies are wrong in a way only a person can name: the draft answered
 * the wrong question, missed the second request, or settled for a policy the
 * customer does not fall under. Editing it is one answer, and a reviewer who
 * would rather have the run try again has no way to ask. The case is approved
 * as it stands or it waits.
 *
 * DEC-49 gives them the ask. The reviewer's note starts a new run on the same
 * turn, and that run composes again with the note as an instruction.
 *
 * Two things block that today, and this module answers the first.
 *
 * A new run derives the old park key, and an adapter that finds drafts by key
 * returns the draft the reviewer rejected. So the attempt is part of every
 * key of a turn (`src/ledger/keys.ts`), and this write records the attempt
 * the rejected run was.
 *
 * A console cannot walk the state machine. `coordinateTicket` is not in the
 * barrel a second interface may import, and its guard refuses every ledger
 * write the console does not name, so the console cannot start the new run
 * itself. So this writes the request, and the consumer that owns the
 * conversation's partition picks it up on its next scan and starts the
 * attempt (`startSentBackAttempts` in `src/coordinator/consumer.ts`). The
 * shape is the snooze's: a durable marker on the run row, read by a scan.
 *
 * What it refuses, and why each refusal is its own answer
 * ------------------------------------------------------
 *
 * A helpdesk copy a person could send (DEC-40's draft path). The reviewer may
 * have sent it by hand already, and nothing here can see that. A new attempt
 * would then answer a turn the customer has an answer to. Where the ledger
 * holds the reply (DEC-44) there is no such copy, and where the park created
 * no draft at all there is nothing to send.
 *
 * A turn with a record that has reached the customer, may have (fact 14: a
 * `fenced` row may have), or will — an approved reply still `pending`.
 * Starting a new attempt would send a second reply for one turn. Only a
 * record the relay will never send leaves the turn open — `malformed` or
 * `not_sent` — and DEC-30 still governs the unknown.
 *
 * The DEC-46 guard, as every other console outcome on a case carries it: a
 * reviewer who read one reply does not reject a case holding another.
 *
 * What it writes
 * --------------
 *
 * The run ends `superseded`, which is terminal, so the same commit stamps
 * `finished_at`. The moment, the note and the reviewer are recorded with it:
 * `sent_back_at` is what the scan reads, `send_back_note` is the instruction
 * the next attempt composes with, and the journal row names who asked.
 *
 * No outbox record commits. A send-back sends nothing, and the reply the
 * rejected run composed stays where it was — the draft in the helpdesk, or
 * the text on the turn. It is not deleted, because nothing here can prove the
 * customer never saw it.
 *
 * The attempt count has no ceiling. A turn may be sent back as often as
 * reviewers ask, and each attempt ends the one before it. A cap would be a
 * policy about who may ask how many times, and DEC-49 states none: what
 * bounds the work is the reviewer's own time and the fact that every attempt
 * leaves a record a team reads.
 */
import type { Pool, PoolClient } from 'pg';

import { approverFrom, type NameSource, sourceOf } from '../approval/approver.js';
import { replyDigest } from '../approval/shown.js';
import { releaseHoldIn } from '../holds/hold.js';
import { lockTurnAttempt, readSavedReply, turnIsClosed } from '../ledger/conversation.js';
import { fencedTransition } from '../ledger/insert.js';
import type { FencedTransitionResult } from '../ledger/insert.js';
import { journalStep } from '../ledger/journal-write.js';
import { isStorableText } from '../ledger/storable-text.js';

/**
 * The longest note a send-back records.
 *
 * The note becomes an instruction the next attempt reads, and a note longer
 * than this is not something a reviewer wrote. The bound exists for the same
 * reason the close's does: the value comes from a form field and lands in the
 * ledger, so an unbounded one lets a request put an arbitrary text there.
 */
export const MAX_SEND_BACK_NOTE_CHARS = 1000;



/** What one send-back did, or why it did nothing. */
export type SendBackOutcome =
  | { readonly outcome: 'sent_back' }
  | { readonly outcome: 'unknown_run' }
  /** The run is not waiting for a person, so there is nothing to send back. */
  | { readonly outcome: 'not_awaiting_approval'; readonly state: string }
  /** DEC-46: the reply the caller was shown is not the reply the ledger holds. */
  | { readonly outcome: 'shown_changed' }
  /**
   * The run has no conversation or no turn, so there is nothing to attempt
   * again. The save and the rewrite refuse the same shape by the same name.
   */
  | { readonly outcome: 'no_turn' }
  /**
   * A copy of the reply is in the helpdesk, and a person could send it. A new
   * attempt would answer a turn the customer may already have an answer to.
   */
  | { readonly outcome: 'copy_could_send' }
  /**
   * The turn has an outbox record that has reached the customer, may have,
   * or will: it is not open for a second reply.
   */
  | { readonly outcome: 'turn_may_have_reached' }
  /**
   * The turn is already on a later attempt than this run: another reviewer
   * sent it back. A second request would start a second attempt for one turn,
   * and only one of the two would read a note.
   */
  | { readonly outcome: 'attempt_pending' }
  /** DEC-49: the note is the whole of what a reviewer asked for. */
  | { readonly outcome: 'note_empty' }
  | { readonly outcome: 'note_too_long' }
  /**
   * The note carries a character the ledger cannot store: a NUL, or a lone
   * surrogate. Refused here rather than at the insert, so the answer is a
   * refusal with words rather than a fault about a write that never happened.
   */
  | { readonly outcome: 'unprintable_note' }
  /**
   * The fence refused the write. No console caller reaches this: a run parked
   * in `awaiting_approval` is outside the fence's reach (src/ledger/insert.ts).
   * It stays in the union because the console maps every outcome by name.
   */
  | { readonly outcome: 'stale_epoch'; readonly highestAcceptedEpoch: bigint };

export interface SendBackOptions {
  /**
   * DEC-49: what the reviewer wants the next attempt to do differently.
   *
   * Required, and trimmed. A send-back with no note asks the run to compose
   * the same reply again from the same documents, which is the one outcome
   * this cannot be for.
   */
  readonly note: string;
  /** DEC-42, DEC-45: who asked, and how the name was established. */
  readonly sentBackBy?: string;
  readonly sentBackBySource?: NameSource;
  /** DEC-46: the digest of the reply the page drew, when a page drew one. */
  readonly shown?: string;
  /**
   * DEC-44: whether the adapter's ledger holds the reply, so the saved text
   * is what a page drew. Read only where `shown` is supplied, and absent is
   * the draft path, as on the approval, the close and the snooze — on that
   * path the gate refuses anyway.
   */
  readonly ledgerReply?: boolean;
}

/**
 * The precondition standing the write down, as a throw.
 *
 * The ledger's `refuseIf` answers yes or no, so a boolean would fold three
 * different refusals into one `refused` outcome — and the reviewer's remedy
 * differs: a reply that moved under them is fixed by opening the case again,
 * and a helpdesk copy a person could send is not. Throwing the reason keeps
 * the ledger's seam unchanged and hands the caller the refusal that happened.
 */
class StoodDown extends Error {
  constructor(
    readonly reason: 'copy_could_send' | 'turn_may_have_reached' | 'attempt_pending' | 'shown_changed',
  ) {
    super(`the send-back precondition refused: ${reason}`);
    this.name = 'StoodDown';
  }
}

/** The park journal row's two fields this write reads. */
interface ParkFacts {
  readonly hasDraft: boolean;
  readonly body: unknown;
  readonly turn: string | null;
}

async function parkFactsOf(client: PoolClient, runId: string): Promise<ParkFacts> {
  const held = await client.query(
    "SELECT result->>'draftExternalId' AS draft, result->>'body' AS body,"
      + " result->>'turnNumber' AS turn"
      + " FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
    [runId],
  );
  if (held.rows.length === 0) {
    // A run waiting for a person journals the park that parked it, so this is
    // a ledger nobody can explain rather than a case to reject.
    throw new Error(`run ${runId} awaits approval but journals no park step`);
  }
  const row = held.rows[0]!;
  return {
    hasDraft: row.draft !== null && row.draft !== undefined,
    body: row.body,
    turn: (row.turn as string | null) ?? null,
  };
}


/**
 * Send one case back, or refuse and say why.
 *
 * The run ends `superseded` in one transaction, with the moment, the note and
 * the reviewer recorded on the row the next attempt reads, and with the hold
 * on the case released. Nothing else changes: no outbox record commits, and
 * the reply the rejected run composed stays where it is.
 */
export async function sendBackRun(
  pool: Pool,
  runId: string,
  options: SendBackOptions,
): Promise<SendBackOutcome> {
  const note = options.note.trim();
  // An instruction with no visible character is not an instruction. Trim
  // removes whitespace, and a `Cf` character — a zero-width space, a
  // byte-order mark — is not whitespace and survives it, so a note made of
  // those would be stored, read by the composer, and carry nothing. That is
  // the case `note_empty` exists for.
  if (note.replace(/[\p{Cf}]/gu, '').trim().length === 0) return { outcome: 'note_empty' };
  if (note.length > MAX_SEND_BACK_NOTE_CHARS) return { outcome: 'note_too_long' };
  if (!isStorableText(note)) return { outcome: 'unprintable_note' };

  const rows = await pool.query(
    'SELECT state, cost_micros, steps_used, conversation_id, turn_number, attempt'
      + ' FROM run WHERE run_id = $1',
    [runId],
  );
  if (rows.rows.length === 0) return { outcome: 'unknown_run' };
  const row = rows.rows[0]!;
  const state = row.state as string;
  if (state !== 'awaiting_approval') {
    return { outcome: 'not_awaiting_approval', state };
  }
  const conversationId = row.conversation_id as string | null;
  const turnNumber = row.turn_number === null || row.turn_number === undefined
    ? null
    : Number(row.turn_number);
  // DEC-49: a new attempt is a run on the same turn, so a run with no turn
  // has nothing to start. Refused here rather than written, because the scan
  // that starts attempts reads the turn and would never serve this request:
  // the reviewer would be told a new attempt is coming and nothing would
  // come. The save and the rewrite refuse the same shape by the same name.
  if (conversationId === null || turnNumber === null) return { outcome: 'no_turn' };
  const runAttempt = Number.isInteger(row.attempt) ? Number(row.attempt) : 1;

  const sentBackBy = approverFrom(options.sentBackBy);
  const sentBackBySource = sourceOf(sentBackBy, options.sentBackBySource);

  const shown = options.shown;
  // Typed from the ledger's own union rather than through a `typeof` of the
  // function: `clock-reachability.test.ts` holds every shipped module to
  // calling the fenced path and never naming it otherwise.
  let moved: FencedTransitionResult;
  try {
    moved = await fencedTransition(pool, {
      runId,
      state: 'superseded',
      costMicros: row.cost_micros as number,
      stepsUsed: row.steps_used as number,
      fromState: 'awaiting_approval',
      // Every precondition, under the run's row lock and before anything is
      // written. Read outside the transaction, each of them has a window
      // between the read and the write, and the write is what a reviewer asked
      // for.
      refuseIf: async (client: PoolClient): Promise<boolean> => {
        // The turn's lock first, so every check below is ordered against the
        // approval, the save, the rewrite and any other send-back of this
        // turn. A reviewer whose check ran before another reviewer's commit
        // would otherwise act on an attempt that was already rejected.
        const turnAttempt = await lockTurnAttempt(client, { conversationId, turnNumber });
        // DEC-49: a turn waits for one attempt at a time. The turn is on a
        // later attempt than this run, so another reviewer already sent it
        // back, and a second request would ask for a second attempt whose
        // note nobody reads.
        if (turnAttempt !== null && turnAttempt !== runAttempt) {
          throw new StoodDown('attempt_pending');
        }
        const park = await parkFactsOf(client, runId);
        // DEC-49: a copy a person could send blocks a new attempt. The draft
        // path keeps one; where the adapter declares its helpdesk cannot send
        // the copy it parks, the ledger holds the reply and there is none; and
        // a park that created no draft has nothing to send either way.
        if (park.hasDraft && options.ledgerReply !== true) throw new StoodDown('copy_could_send');
        if (await turnIsClosed(client, { conversationId, turnNumber })) {
          throw new StoodDown('turn_may_have_reached');
        }
        // DEC-46: the reply the caller drew, against the reply the ledger holds
        // now. The same guard the close, the snooze and the rewrite carry, read
        // the same way (DEC-44 decides which text is compared).
        if (shown === undefined) return false;
        if (typeof park.body !== 'string') throw new StoodDown('shown_changed');
        const saved = options.ledgerReply === true
          ? await readSavedReply(client, {
            conversationId,
            turnNumber: park.turn === null ? null : Number(park.turn),
          })
          : null;
        if (replyDigest(saved ?? park.body) === shown) return false;
        throw new StoodDown('shown_changed');
      },
      afterWrite: (client: PoolClient): Promise<void> => recordSendBackIn(client, {
        runId, conversationId, turnNumber, runAttempt, note,
        reviewer: sentBackBy, reviewerSource: sentBackBySource,
      }),
    });
  } catch (error) {
    // The precondition stands the write down by throwing, so the reason is
    // the caller's own and not a boolean the ledger would report as one
    // anonymous `refused`. The transaction is already rolled back: the ledger
    // rolls back before it rethrows.
    if (error instanceof StoodDown) return { outcome: error.reason };
    throw error;
  }

  switch (moved.outcome) {
    case 'accepted':
      return { outcome: 'sent_back' };
    case 'wrong_state':
      return { outcome: 'not_awaiting_approval', state: moved.currentState };
    case 'refused':
      // Unreachable through this module: its only precondition throws the
      // reason instead of answering "no", so the ledger's own `refused` arm
      // has no caller here. It is answered rather than thrown, because the
      // ledger's outcome set is what this switch is exhaustive over.
      throw new Error(`run ${runId} was refused without a reason recorded`);
    case 'stale_epoch':
      return { outcome: 'stale_epoch', highestAcceptedEpoch: moved.highestAcceptedEpoch };
    case 'superseded':
      // No outbox record travels with a send-back, so no key can be lost.
      throw new Error(`run ${runId} reported a lost idempotency key on a send-back`);
    case 'unknown_run':
      throw new Error(`run vanished between read and transition: ${runId}`);
  }
}

/** What one send-back records, in the transaction that ends the attempt. */
export interface SendBackRecordInput {
  readonly runId: string;
  readonly conversationId: string;
  readonly turnNumber: number;
  /** The attempt this ends. The turn moves to the next one. */
  readonly runAttempt: number;
  /**
   * The reviewer's instruction, or null when the attempt was asked for by a
   * published document (DEC-50): the document is what changed, and the next
   * attempt composes with it rather than with a note.
   */
  readonly note: string | null;
  readonly reviewer: string;
  readonly reviewerSource: NameSource;
  /** The document whose publishing asked for the attempt, when one did. */
  readonly document?: { readonly docId: string; readonly title: string };
  /**
   * Whether the run is stamped sent back. True for a run that waited for a
   * person, which this commit ends. False for an escalated run a published
   * document asks to attempt again: it ended before, and its service time
   * was the system's work, so latency must not read it as rejected.
   */
  readonly stampRun?: boolean;
}

/**
 * The writes of a send-back, inside the caller's transaction, after the run
 * has moved to `superseded` under its own lock and the turn's.
 *
 * Shared by the reviewer's send-back and the attempt a published document
 * asks for (`src/knowledge/rerun-start.ts`), so a case rejected either way
 * leaves the same record: the durable marker the consumer's scan reads, the
 * saved reply cleared and journalled, the turn on the next attempt, and the
 * hold released.
 */
export async function recordSendBackIn(client: PoolClient, input: SendBackRecordInput): Promise<void> {
  const { runId, conversationId, turnNumber, runAttempt, note } = input;
  // The same chokepoint as every other writer of a name (DEC-42, DEC-45),
  // because a document's author reaches this record too.
  const reviewer = approverFrom(input.reviewer);
  const reviewerSource = sourceOf(reviewer, input.reviewerSource);
  // DEC-49: the durable marker the consumer's scan reads, and the note it
  // hands the next attempt. One statement, so neither can be recorded without
  // the other. An escalated run is not stamped: its request is the
  // document's row, which the scan reads instead.
  if (input.stampRun !== false) {
    await client.query(
      'UPDATE run SET sent_back_at = clock_timestamp(), send_back_note = $2'
        + ' WHERE run_id = $1',
      [runId, note],
    );
  }
  // DEC-48, DEC-49: the reply a person saved on this turn belongs to the
  // attempt being rejected. The approval prefers the saved text over the park
  // body, so leaving it would make the new attempt inert: the reviewer would
  // approve the new reply and the customer would receive the older, saved
  // one. Cleared here, in the transaction that ends the attempt, and what was
  // cleared is journalled — a person's words do not disappear without a
  // record of them.
  // Who saved the words is cleared with them, so the journal keeps that too
  // (DEC-45): the record of what this removed names whose words they were.
  const cleared = await client.query<{
    text: string | null;
    by: string | null;
    source: string | null;
  }>(
    `WITH cleared AS (
       SELECT saved_reply_text AS text, saved_reply_by AS by, saved_reply_by_source AS source
         FROM turn
        WHERE conversation_id = $1 AND turn_number = $2
          AND saved_reply_text IS NOT NULL)
     UPDATE turn
        SET saved_reply_text = NULL, saved_reply_provenance = NULL,
            saved_reply_by = NULL, saved_reply_by_source = NULL
      WHERE conversation_id = $1 AND turn_number = $2
        AND saved_reply_text IS NOT NULL
    RETURNING (SELECT text FROM cleared) AS text,
              (SELECT by FROM cleared) AS by,
              (SELECT source FROM cleared) AS source`,
    [conversationId, turnNumber],
  );
  const clearedReply = cleared.rows[0]?.text ?? null;
  const clearedBy = cleared.rows[0]?.by ?? null;
  const clearedBySource = cleared.rows[0]?.source ?? null;
  // DEC-49: the turn is on the next attempt from this commit on. The queue
  // files a redelivered message at it, the scan starts it, and an approval, a
  // save or a rewrite of the attempt this ended is refused.
  await client.query(
    'UPDATE turn SET attempt = $3 WHERE conversation_id = $1 AND turn_number = $2',
    [conversationId, turnNumber, runAttempt + 1],
  );
  await journalStep(client, {
    runId,
    stepId: 'send_back',
    status: 'done',
    result: {
      note,
      reviewer,
      reviewerSource,
      // The reply the rejected attempt held, when it held a person's. With
      // the note, the whole of what this write removed.
      ...(clearedReply === null ? {} : { clearedReply }),
      // A reply saved before migration 039 has no recorded saver, and the row
      // then says nothing rather than naming somebody.
      ...(clearedBy === null ? {} : { clearedBy, clearedBySource }),
      // The attempt this ended, so the record reads as the history of a turn
      // rather than as one event on one run.
      attempt: runAttempt,
      ...(input.document === undefined
        ? {}
        : { document: input.document.docId, documentTitle: input.document.title }),
    },
    promptVer: 'console',
    modelVer: 'console',
    costMicros: 0,
  });
  // DEC-46: the case leaves the queue for good — a later attempt is a new run
  // — so the reservation ends here, in the transaction that ends it. Its own
  // kind, because the team's history is what a reader uses to tell a case
  // that was closed from one that was sent back.
  await releaseHoldIn(client, { runId, reviewer, kind: 'send_back' });
}
