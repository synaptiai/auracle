// The reviewer roster (DEC-45).
//
// DEC-45: "The console serves nothing to a request with no roster identity,
// and a trusted proxy authenticates that identity." This module is the list
// that decides. A maintainer changes it from the command line; the console
// reads it on every request, and never writes it.
//
// An identity is kept exactly as it is compared: the console asks whether
// THIS value is on the roster and active, so a prefix, a different case or a
// deactivated row all answer no. The name rules are the ledger's own
// (`approverFrom`), because a value the ledger would record as `unattributed`
// can never be a reviewer: no approval could name it.
import type { Pool } from 'pg';

import { UNATTRIBUTED, approverFrom } from '../approval/approver.js';

/** One row of the roster, as the command line lists it. */
export interface ReviewerRow {
  readonly identity: string;
  readonly active: boolean;
  readonly addedAt: Date;
  readonly deactivatedAt: Date | null;
}

export type AddReviewerOutcome =
  | { readonly outcome: 'added' }
  /** The identity was deactivated, and adding it again makes it active. */
  | { readonly outcome: 'reactivated' }
  /** The identity is already listed and active. Nothing changed. */
  | { readonly outcome: 'already_listed' }
  /**
   * The ledger would not keep this name (DEC-42's rules): it is empty, too
   * long, carries a character that draws nothing, or is the literal
   * `unattributed`. Such a value can never be recorded on an approval as a
   * person, so it cannot be a reviewer.
   */
  | { readonly outcome: 'refused_name' };

export type DeactivateOutcome =
  | { readonly outcome: 'deactivated' }
  | { readonly outcome: 'not_active' }
  /**
   * The ledger would not keep this name, so no row can hold it. Its own
   * outcome rather than `not_active`, which reads to an operator as "that
   * reviewer was already off" — while the reviewer they meant stays active.
   */
  | { readonly outcome: 'refused_name' };

/**
 * Adds an identity to the roster, or reports why it is not there.
 *
 * The value stored is the name the ledger would record, which is the name the
 * console asks about: `approverFrom` trims it and refuses the characters no
 * name holds, and the console runs the same function on what a proxy sends.
 * Storing what arrived instead would list a reviewer under a name nobody can
 * send — a pasted identity with a trailing space would match nothing.
 */
export async function addReviewer(
  pool: Pool,
  identity: string,
): Promise<AddReviewerOutcome> {
  const name = approverFrom(identity);
  if (name === UNATTRIBUTED) {
    return { outcome: 'refused_name' };
  }
  // Adding an identity that was deactivated makes it active again, because a
  // mistaken deactivation has to be reversible with the tool that shipped.
  // `xmax = 0` is the row Postgres wrote rather than updated: one statement
  // answers both whether it was listed and which of the two ways.
  const written = await pool.query(
    `INSERT INTO reviewer (identity) VALUES ($1)
     ON CONFLICT (identity) DO UPDATE
       SET active = true, deactivated_at = NULL
       WHERE reviewer.active = false
     RETURNING (xmax = 0) AS inserted`,
    [name],
  );
  const row = written.rows[0];
  if (row === undefined) return { outcome: 'already_listed' };
  return row.inserted === true ? { outcome: 'added' } : { outcome: 'reactivated' };
}

/**
 * Deactivates a reviewer. A row that was never active is not a change, and
 * the caller hears that rather than a silent success: the command line
 * prints one line per argument.
 *
 * The argument goes through the same rules as `addReviewer`, so the name this
 * looks for is the name the add stored. Comparing what was typed instead left
 * a padded identity active: the command printed a change that did not happen.
 * A value the rules refuse is its own outcome, because no row could hold it
 * and an operator reading `not_active` would think that reviewer was already
 * off.
 */
export async function deactivateReviewer(
  pool: Pool,
  identity: string,
): Promise<DeactivateOutcome> {
  const name = approverFrom(identity);
  // No row can hold this name, so nothing was deactivated and the caller has
  // to hear which of the two happened. `addReviewer` refuses the same value
  // the same way.
  if (name === UNATTRIBUTED) return { outcome: 'refused_name' };
  const updated = await pool.query(
    `UPDATE reviewer SET active = false, deactivated_at = now()
      WHERE identity = $1 AND active`,
    [name],
  );
  return (updated.rowCount ?? 0) === 1
    ? { outcome: 'deactivated' }
    : { outcome: 'not_active' };
}

/** Every reviewer, newest first, active ones included either way. */
export async function listReviewers(pool: Pool): Promise<ReviewerRow[]> {
  const rows = await pool.query(
    `SELECT identity, active, added_at, deactivated_at
       FROM reviewer
      ORDER BY added_at DESC, identity`,
  );
  return rows.rows.map((row) => ({
    identity: row.identity as string,
    active: row.active as boolean,
    addedAt: row.added_at as Date,
    deactivatedAt: (row.deactivated_at as Date | null) ?? null,
  }));
}

/**
 * Whether this exact identity may review: it is on the roster and active.
 *
 * The console asks this before it builds any page, so the answer has to be
 * the strict one. A deactivated reviewer answers false exactly like a value
 * that was never listed.
 */
export async function activeReviewer(pool: Pool, identity: string): Promise<boolean> {
  if (identity === '') return false;
  const rows = await pool.query(
    'SELECT 1 FROM reviewer WHERE identity = $1 AND active LIMIT 1',
    [identity],
  );
  return rows.rows.length > 0;
}
