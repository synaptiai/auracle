/**
 * A case a reviewer closed with no reply (DEC-48).
 *
 * Some cases end without an answer. They are duplicates, they are spam, or
 * somebody settled them on the telephone. Today the only way out of the
 * approval queue is an approval, so such a case either sends a reply nobody
 * wants or sits in the queue until somebody sends one.
 *
 * DEC-48 gives them a state of their own. `closed` is terminal, nothing sends
 * for it, and the run carries a record naming the reviewer and the reason.
 * The conversation view says the case was closed without a reply, in its own
 * words: the existing labels say the system answered, or that a person
 * approved an action, and neither is true of this.
 *
 * What a close must not do is decide anything about the reply on the way out.
 * It sends none, it keeps none, and it never fabricates one.
 *
 * The move commits through `fencedTransition`, which is where a terminal
 * state stamps `finished_at` and where the run's row lock is taken. No outbox
 * record travels with it: DEC-04's record is the effect a run committed, and
 * this run commits none.
 *
 * DEC-46 governs the guard. A close is a console outcome on a case whose
 * reply a person may have edited since the page was drawn, so the caller
 * carries the digest of the text it drew and the ledger's reply is compared
 * against it under the row lock. A close that cannot prove its reviewer read
 * the case as it stands refuses, and names the refusal for what it is.
 */
import type { Pool, PoolClient } from 'pg';

import { UNATTRIBUTED, approverFrom } from '../approval/approver.js';
import { replyDigest } from '../approval/shown.js';
import { releaseHoldIn } from '../holds/hold.js';
import { readSavedReply } from '../ledger/conversation.js';
import { fencedTransition } from '../ledger/insert.js';
import { journalStep } from '../ledger/journal-write.js';

/**
 * The longest reason a close records.
 *
 * DEC-48 asks the record to name the reason, and a reason is a sentence a
 * colleague reads. The bound exists because the value lands in a journal row
 * and comes from a form field: an unbounded one lets a request put an
 * arbitrary text in the ledger, and a text longer than this is not a reason
 * anybody wrote.
 */
export const MAX_CLOSE_REASON_CHARS = 1000;

/**
 * Whether the ledger can store this text at all.
 *
 * Postgres `text` and `jsonb` both refuse a NUL, and a lone surrogate is not a
 * character any encoder can write. Either one raises inside the journal
 * insert, and the console then answers a fault about a close that wrote
 * nothing — when what arrived was a request this ledger declines. A paired
 * surrogate is one code point above the range, so it passes.
 */
function isStorableText(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point === 0 || (point >= 0xd800 && point <= 0xdfff)) return false;
  }
  return true;
}

/** What one close did, or why it did nothing. */
export type CloseOutcome =
  | { readonly outcome: 'closed' }
  | { readonly outcome: 'unknown_run' }
  /**
   * The run is not waiting for a person, so there is nothing to close. The
   * state travels with the answer, and it reads the same whether the case was
   * approved a moment ago or closed by somebody else.
   */
  | { readonly outcome: 'not_awaiting_approval'; readonly state: string }
  /**
   * DEC-46: the reply the caller was shown is not the reply the ledger holds.
   * The reviewer is closing a case they did not read, so nothing is written
   * and the console says to open the case again.
   */
  | { readonly outcome: 'shown_changed' }
  /** DEC-48: the record names a reason, and an empty one names nothing. */
  | { readonly outcome: 'empty_reason' }
  | { readonly outcome: 'reason_too_long' }
  /**
   * The reason carries a character the ledger cannot store: a NUL, or a lone
   * surrogate. Refused here rather than at the insert, so the answer is a
   * refusal with words rather than a fault about a write that never happened.
   */
  | { readonly outcome: 'unprintable_reason' }
  /**
   * The fence refused the write. As on the approval path, no console caller
   * reaches this: a run parked in `awaiting_approval` is outside the fence's
   * reach (src/ledger/insert.ts), so a person's close commits whatever the
   * ticket's fence says. It stays in the union because the console maps every
   * outcome by name, and a later parked state would reach it.
   */
  | { readonly outcome: 'stale_epoch'; readonly highestAcceptedEpoch: bigint };

export interface CloseOptions {
  /**
   * DEC-48: why the case is being closed, in the reviewer's own words.
   *
   * Required, and trimmed. A close that records no reason leaves the team
   * asking the one question the record exists to answer, and a whitespace
   * string is a field somebody tabbed through rather than wrote in.
   */
  readonly reason: string;
  /**
   * DEC-42: who closed it, as a claim rather than an authentication.
   *
   * Absent records `unattributed`, exactly as an approval does: a statement
   * that nobody was named, and never a guess at who was standing there.
   */
  readonly closedBy?: string;
  /**
   * DEC-45: how the name was established, recorded beside it. `roster` means
   * a console checked the identity against the reviewer roster; `header` is
   * DEC-42's claim and the default. A caller that names nobody records
   * `none`, whatever it passes here.
   */
  readonly closedBySource?: 'roster' | 'header' | 'none';
  /**
   * DEC-46: the digest of the reply the page drew, when a page drew one.
   *
   * Supplied, it is recomputed under the run's row lock against the text that
   * page drew, and a mismatch refuses. Absent means no page: a command-line
   * close read the case itself, and there is nothing to compare it against.
   */
  readonly shown?: string;
  /**
   * DEC-44: whether the adapter's ledger holds the reply, so the saved text
   * is what a page drew and what sends.
   *
   * The console reads this off the adapter and passes it, exactly as it does
   * on the approval path, because the two pages draw different text: on this
   * path the case shows the reply a person saved, and on the draft path it
   * shows the body the park journaled. A guard that always read the saved
   * reply would refuse every close of a draft-path case whose turn carries
   * one, and its refusal would send the reviewer back to a page that draws
   * the same text again.
   *
   * Absent is the draft path, as it is on the approval. It is read only where
   * `shown` is supplied.
   */
  readonly ledgerReply?: boolean;
}

/**
 * Close one case, or refuse and say why.
 *
 * The run moves to `closed` in one transaction, with the record of who closed
 * it and why, and with the hold on the case released. Nothing else changes:
 * no outbox record commits, no reply text reaches the turn, and the edit
 * distance stays null — so the run counts as not reached in the control
 * bands, which is what DEC-48 asks of a case nobody answered.
 */
export async function closeRun(
  pool: Pool,
  runId: string,
  options: CloseOptions,
): Promise<CloseOutcome> {
  const reason = options.reason.trim();
  if (reason.length === 0) return { outcome: 'empty_reason' };
  if (reason.length > MAX_CLOSE_REASON_CHARS) return { outcome: 'reason_too_long' };
  if (!isStorableText(reason)) return { outcome: 'unprintable_reason' };

  const rows = await pool.query(
    'SELECT state, cost_micros, steps_used, conversation_id FROM run WHERE run_id = $1',
    [runId],
  );
  if (rows.rows.length === 0) return { outcome: 'unknown_run' };
  const row = rows.rows[0]!;
  const state = row.state as string;
  if (state !== 'awaiting_approval') {
    return { outcome: 'not_awaiting_approval', state };
  }
  const conversationId = row.conversation_id as string | null;

  // DEC-42, DEC-45: the two values commit together in the journal row, and a
  // name nobody holds has no source to record.
  const closedBy = approverFrom(options.closedBy);
  const closedBySource =
    closedBy === UNATTRIBUTED ? 'none' : (options.closedBySource ?? 'header');

  const shown = options.shown;
  const moved = await fencedTransition(pool, {
    runId,
    state: 'closed',
    costMicros: row.cost_micros as number,
    stepsUsed: row.steps_used as number,
    fromState: 'awaiting_approval',
    // DEC-46: the reply the reviewer was shown, against the reply the ledger
    // holds now — read here, inside the transaction that takes the row lock,
    // and before anything is written. Read outside it, the guard has a window
    // between the check and the write, which is the change it exists to catch.
    ...(shown === undefined ? {} : {
      refuseIf: async (client: PoolClient): Promise<boolean> => {
        const held = await client.query(
          "SELECT result->>'body' AS body, result->>'turnNumber' AS turn"
            + " FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
          [runId],
        );
        if (held.rows.length === 0) {
          // A run waiting for a person journals the park that parked it, so
          // this is a ledger nobody can explain rather than a case to close.
          throw new Error(`run ${runId} awaits approval but journals no park step`);
        }
        const body = held.rows[0]!.body as unknown;
        const turn = held.rows[0]!.turn as string | null;
        // A row that is gone, or a body that is not text, refuses: this
        // close cannot show what the reviewer read, so it does not write.
        if (typeof body !== 'string') return true;
        // DEC-44: the text the caller's page drew. Where the adapter's
        // ledger holds the reply, that is the saved reply when a person saved
        // one and the parked body otherwise; where the helpdesk sends its own
        // copy, it is the parked body alone. The approval makes the same
        // distinction for the same reason.
        const saved = options.ledgerReply === true
          ? await readSavedReply(client, {
            conversationId,
            turnNumber: turn === null ? null : Number(turn),
          })
          : null;
        return replyDigest(saved ?? body) !== shown;
      },
    }),
    afterWrite: async (client: PoolClient): Promise<void> => {
      // DEC-04: the record of what the run did, and the row that names who
      // did it and why. `console` is the pin for a write no model made, as
      // the undo's row is.
      await journalStep(client, {
        runId,
        stepId: 'close',
        status: 'done',
        result: { reason, reviewer: closedBy, reviewerSource: closedBySource },
        promptVer: 'console',
        modelVer: 'console',
        costMicros: 0,
      });
      // DEC-46: the case has left the queue, so the hold on it ends here, in
      // the transaction that finishes the case. Released outside it, a hold
      // would outlive a close that rolled back. The kind is `close` and not
      // `send`: this run sends nothing, and the history is what a team reads
      // for the time a case held a person.
      await releaseHoldIn(client, { runId, reviewer: closedBy, kind: 'close' });
    },
  });

  switch (moved.outcome) {
    case 'accepted':
      return { outcome: 'closed' };
    case 'wrong_state':
      // Lost a race with another close or an approval; it re-checked under
      // the lock.
      return { outcome: 'not_awaiting_approval', state: moved.currentState };
    case 'refused':
      // The only precondition this entrypoint passes is the reply digest, so
      // a refusal is the reply having changed under the reviewer.
      return { outcome: 'shown_changed' };
    case 'stale_epoch':
      return { outcome: 'stale_epoch', highestAcceptedEpoch: moved.highestAcceptedEpoch };
    case 'superseded':
      // No outbox record travels with a close, so no key can be lost to
      // another action and this arm is unreachable. It is answered rather
      // than thrown, because the ledger's own outcome set is what this
      // switch is exhaustive over.
      throw new Error(`run ${runId} reported a lost idempotency key on a close`);
    case 'unknown_run':
      // The row existed above; runs are never deleted.
      throw new Error(`run vanished between read and transition: ${runId}`);
  }
}
