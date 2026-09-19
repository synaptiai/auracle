/**
 * The reply a reviewer saves on the case screen (DEC-44).
 *
 * The console's second write. A reviewer edits the reply the ledger holds,
 * saves it, reloads the case and edits again; the approval then sends what
 * the ledger holds. This is the entrypoint that writes it, and it is the
 * approval's own guard applied one step earlier: a save from a page that
 * showed other text is refused exactly as an approval from one is (DEC-46).
 *
 * The move and the write happen in one transaction, under the run's row
 * lock, for the reason the approval states: a guard checked outside the lock
 * has a window between the check and the write, and the text the reviewer
 * read changing inside that window is the thing the guard exists to catch.
 *
 * No state moves. A save is not an outcome: the run stays where it is, the
 * hold stays with whoever took it, and the case stays in the queue.
 */
import type { Pool } from 'pg';

import { errorMessage } from '../errors.js';
import { readSavedReply, recordSavedReply } from '../ledger/conversation.js';
import { replyDigest } from './shown.js';

/** What one save did, or why it did nothing. */
export type SaveOutcome =
  | { readonly outcome: 'saved' }
  | { readonly outcome: 'unknown_run' }
  | { readonly outcome: 'not_awaiting_approval'; readonly state: string }
  /**
   * DEC-46: the reply the caller was shown is not the reply the ledger holds.
   * A save from that page would overwrite text its reviewer never read, so it
   * is refused and the console says to open the case again.
   */
  | { readonly outcome: 'shown_changed' }
  /** A reply with nothing in it is not a reply (DEC-12). */
  | { readonly outcome: 'empty_reply' }
  /**
   * The run serves no conversation turn, so there is no turn row to save on.
   * A V1-era run and a park journalled before DEC-38 are the two shapes that
   * reach this; neither can hold a reply the ledger would send.
   */
  | { readonly outcome: 'no_turn' };

export interface SaveReplyOptions {
  /**
   * DEC-46: the digest of the reply the page the reviewer read drew.
   *
   * Supplied by the console, which draws the case from the text the ledger
   * holds and carries `replyDigest` of exactly that text in its form. Absent
   * means no page: `saveReply` is then the caller's own statement of the text
   * it means to replace, and the guard is not applied.
   */
  readonly shown?: string;
}

/**
 * Save one reviewer's text as the reply this turn holds.
 *
 * `text` is the whole reply, not a sentence of it: the console assembles the
 * text from what the reviewer wrote and what a callout did to it, and this
 * writes what it is given. Text that is only whitespace is refused rather
 * than trimmed to nothing.
 */
export async function saveReply(
  pool: Pool,
  runId: string,
  text: string,
  options?: SaveReplyOptions,
): Promise<SaveOutcome> {
  const bodyText = text.trim();
  if (bodyText.length === 0) {
    return { outcome: 'empty_reply' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query(
      'SELECT state, conversation_id FROM run WHERE run_id = $1 FOR UPDATE',
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

    // The parked body is where the reply starts: it is what a page shows
    // before anybody saves, and it is what the approval would send.
    const parked = await client.query(
      "SELECT result->>'body' AS body, result->>'turnNumber' AS turn"
        + " FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
      [runId],
    );
    if (parked.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(`run ${runId} awaits approval but journals no park step`);
    }
    const conversationId = run.rows[0]!.conversation_id as string | null;
    const turnNumber = parked.rows[0]!.turn as string | null;
    if (conversationId === null || turnNumber === null) {
      await client.query('ROLLBACK');
      return { outcome: 'no_turn' };
    }
    const turn = Number(turnNumber);

    const current = (await readSavedReply(client, { conversationId, turnNumber: turn }))
      ?? (parked.rows[0]!.body as string);
    if (options?.shown !== undefined && replyDigest(current) !== options.shown) {
      await client.query('ROLLBACK');
      return { outcome: 'shown_changed' };
    }

    await recordSavedReply(client, { conversationId, turnNumber: turn, bodyText });
    await client.query('COMMIT');
    return { outcome: 'saved' };
  } catch (error) {
    // As elsewhere in this codebase: a rollback that throws must not replace
    // the cause, and is reported rather than dropped. This transaction wrote
    // under the run's row lock, so a rollback that failed leaves a connection
    // in a state nobody read — the line is what says so.
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      console.error(
        JSON.stringify({
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
