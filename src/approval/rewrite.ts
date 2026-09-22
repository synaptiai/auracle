/**
 * The reply a reviewer writes from scratch (DEC-48).
 *
 * The case screen's fourth write, and the one that changes who wrote the
 * reply. A save (DEC-44) edits the draft: the model wrote it, a person
 * changed part of it, and the approval records the edit distance between the
 * two. A rewrite replaces it: the words are the reviewer's, so the reply the
 * customer receives carries a provenance that names a person and no model or
 * prompt, and no reader reports the gate's coverage for it.
 *
 * The distinction cannot be read off the text. A reviewer who deletes every
 * sentence and writes their own has rewritten the reply, and so has one who
 * replaces the whole body after reading it. Only the reviewer knows, so the
 * act declares itself here rather than being inferred from a distance.
 *
 * The ledger keeps the drafted body. It is the record of what the model
 * wrote, it is what the approval measures its edit distance against, and the
 * gate's verdict stays attached to it. What changes is the reply: the turn
 * holds the person's text, so the draft can no longer be sent, and the
 * journal carries a `rewrite` row naming who wrote it and which reply it
 * replaced.
 *
 * No state moves. Like a save, a rewrite is not an outcome: the run stays
 * where it is, the hold stays with whoever took it, and the case stays in the
 * queue until somebody approves it.
 */
import type { Pool } from 'pg';

import { UNATTRIBUTED, approverFrom } from '../approval/approver.js';
import { errorMessage } from '../errors.js';
import { lockTurnAttempt, readSavedReply, recordSavedReply } from '../ledger/conversation.js';
import { journalStep } from '../ledger/journal-write.js';
import { isStorableText } from '../ledger/storable-text.js';
import { logLine } from '../log/line.js';

import { replyDigest } from './shown.js';

/** What one rewrite did, or why it did nothing. */
export type RewriteOutcome =
  | { readonly outcome: 'rewritten' }
  | { readonly outcome: 'unknown_run' }
  | { readonly outcome: 'not_awaiting_approval'; readonly state: string }
  /** DEC-46: the reply the caller was shown is not the reply the ledger holds. */
  | { readonly outcome: 'shown_changed' }
  /** A reply with nothing in it is not a reply (DEC-12). */
  | { readonly outcome: 'empty_reply' }
  /**
   * The text holds a character no ledger stores: a NUL, or an unpaired
   * surrogate. The driver would raise on the first and quietly replace the
   * second, so a customer would receive different text from the reviewer's.
   */
  | { readonly outcome: 'unprintable_reply' }
  /** The run serves no conversation turn, so there is no turn row to write on. */
  | { readonly outcome: 'no_turn' }
  /**
   * DEC-49: a reviewer sent this attempt back, so the turn is on a later one.
   * A reply written here would shadow the new attempt's: the approval prefers
   * the saved text. Nothing is written.
   */
  | { readonly outcome: 'sent_back' }
  /**
   * The park holds an action rather than a reply (DEC-34). Its approval runs
   * `performAction` and sends nothing, so a reply written here would reach
   * nobody and the case would read as one a person had answered.
   */
  | { readonly outcome: 'no_reply' }
  /**
   * DEC-44: this adapter sends the copy it parks, so the ledger's reply is
   * not the one that reaches the customer. Writing one here would record a
   * reply nobody sends: the reviewer edits the copy in the target system.
   */
  | { readonly outcome: 'not_ledger_reply' };

export interface RewriteOptions {
  /**
   * DEC-46: the digest of the reply the page the reviewer read drew.
   *
   * The same guard the save and the approval apply. A rewrite from a page
   * that showed other text would replace text its reviewer never read.
   */
  readonly shown?: string;
  /** DEC-42, DEC-45: who wrote it, recorded in the run's journal. */
  readonly rewrittenBy?: string;
  /** DEC-45: how the name was established. `header` is DEC-42's default. */
  readonly rewrittenBySource?: 'roster' | 'header' | 'none';
  /**
   * DEC-44: whether this adapter's ledger holds the reply, so a person's
   * text is the text the customer receives. False is the draft path, where
   * the rewrite is refused rather than recorded.
   */
  readonly ledgerReply?: boolean;
}

/**
 * Write one reviewer's text as this turn's reply, in place of the draft.
 *
 * `text` is the whole reply. Text that is only whitespace is refused rather
 * than trimmed to nothing, as the save refuses it.
 */
export async function rewriteReply(
  pool: Pool,
  runId: string,
  text: string,
  options?: RewriteOptions,
): Promise<RewriteOutcome> {
  if (options?.ledgerReply !== true) {
    return { outcome: 'not_ledger_reply' };
  }
  const bodyText = text.trim();
  if (bodyText.length === 0) {
    return { outcome: 'empty_reply' };
  }
  // Before anything is read, so a request this ledger declines leaves no mark.
  if (!isStorableText(bodyText)) {
    return { outcome: 'unprintable_reply' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // DEC-28: a parked run is outside the fence, and the row lock is what
    // serializes two writers. The hedge on that is the same as the save's, and
    // it is taken here rather than by a fenced transition: no state moves.
    const run = await client.query(
      'SELECT state, conversation_id, attempt FROM run WHERE run_id = $1 FOR UPDATE',
      [runId],
    );
    if (run.rows.length === 0) {
      await client.query('ROLLBACK');
      return { outcome: 'unknown_run' };
    }
    const state = run.rows[0]!.state as string;
    if (state !== 'awaiting_approval') {
      await client.query('ROLLBACK');
      return { outcome: 'not_awaiting_approval', state };
    }

    const parked = await client.query(
      "SELECT result->>'body' AS body, result->>'turnNumber' AS turn,"
        + " result->>'draftExternalId' AS draft"
        + " FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
      [runId],
    );
    if (parked.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(`run ${runId} awaits approval but journals no park step`);
    }
    // The handle is what makes this a reply at all. A park without one is
    // DEC-34's ledger-only park: its approval performs an action, and the
    // person's text would sit on a turn nothing sends (DEC-44's condition,
    // read from the ledger rather than trusted from the caller).
    if ((parked.rows[0]!.draft as string | null) === null) {
      await client.query('ROLLBACK');
      return { outcome: 'no_reply' };
    }
    const conversationId = run.rows[0]!.conversation_id as string | null;
    const turnNumber = parked.rows[0]!.turn as string | null;
    if (conversationId === null || turnNumber === null) {
      await client.query('ROLLBACK');
      return { outcome: 'no_turn' };
    }
    const turn = Number(turnNumber);
    // DEC-49: the turn's lock, after the run's — the order every writer of a
    // turn follows. A reviewer who sent this attempt back raised the turn's
    // attempt under it, and a reply written on the attempt they rejected
    // would shadow the new one's.
    const turnAttempt = await lockTurnAttempt(client, { conversationId, turnNumber: turn });
    if (turnAttempt !== null && turnAttempt > Number(run.rows[0]!.attempt ?? 1)) {
      await client.query('ROLLBACK');
      return { outcome: 'sent_back' };
    }

    // What the reply is now: the last save, or the parked body when nobody
    // saved one. The guard compares against the text that is about to be
    // replaced, whether that is the model's or an earlier save's.
    const current = (await readSavedReply(client, { conversationId, turnNumber: turn }))
      ?? (parked.rows[0]!.body as string);
    if (options.shown !== undefined && replyDigest(current) !== options.shown) {
      await client.query('ROLLBACK');
      return { outcome: 'shown_changed' };
    }

    const rewrittenBy = approverFrom(options.rewrittenBy);
    const rewrittenBySource =
      rewrittenBy === UNATTRIBUTED ? 'none' : (options.rewrittenBySource ?? 'header');

    // When the person wrote it, stated once and written twice: onto the turn
    // with the text, which is what the send reports, and onto the journal row
    // beside who wrote it, which is the record. A hand-written ledger could
    // make the two disagree; nothing this repository writes can.
    const at = new Date().toISOString();
    await recordSavedReply(client, {
      conversationId,
      turnNumber: turn,
      bodyText,
      provenance: { generatedBy: 'person', generatedAt: at },
    });
    // The record of the act, and the digest of the reply it replaced. The
    // digest is what lets a reader tell whether the draft it is showing is
    // the one this rewrite replaced, rather than one a later write put there.
    await journalStep(client, {
      runId,
      stepId: 'rewrite',
      status: 'done',
      result: {
        reviewer: rewrittenBy,
        reviewerSource: rewrittenBySource,
        cleared: replyDigest(current),
        at,
      },
      promptVer: 'console',
      modelVer: 'console',
      costMicros: 0,
    }, { replace: true });
    await client.query('COMMIT');
    return { outcome: 'rewritten' };
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      console.error(
        logLine({
          event: 'rollback_failed',
          at: new Date().toISOString(),
          runId,
          error: errorMessage(rollbackError),
        }),
      );
    });
    throw error;
  } finally {
    client.release();
  }
}
