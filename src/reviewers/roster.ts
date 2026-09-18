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
  /**
   * DEC-47: the products this reviewer covers, for the queue's own order.
   * Empty means no declared focus. It grants nothing: the console serves
   * every case to every reviewer.
   */
  readonly products: readonly string[];
}

export type AddReviewerOutcome =
  | { readonly outcome: 'added' }
  /** The identity was deactivated, and adding it again makes it active. */
  | { readonly outcome: 'reactivated' }
  /**
   * The identity is listed and active, and the products it covers changed.
   * Its own outcome rather than a reactivation: this reviewer was already
   * working, and the sentence an operator reads has to say what moved.
   */
  | { readonly outcome: 'products_set' }
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
  products?: readonly string[],
): Promise<AddReviewerOutcome> {
  const name = approverFrom(identity);
  if (name === UNATTRIBUTED) {
    return { outcome: 'refused_name' };
  }
  // Adding an identity that was deactivated makes it active again, because a
  // mistaken deactivation has to be reversible with the tool that shipped.
  // `xmax = 0` is the row Postgres wrote rather than updated: one statement
  // answers both whether it was listed and which of the two ways.
  //
  // DEC-47: `products` absent is not `products` empty. Absent leaves what the
  // row holds, so an operator adding a colleague who is already covered does
  // not clear a focus they never mentioned. The two `COALESCE`s say that in
  // SQL: the insert takes an empty list for a reviewer added with none, and
  // the update keeps the stored one.
  //
  // The outcome needs the row as it was, and a `RETURNING` clause sees the
  // row as it now is. So the statement reads the old one into a CTE first,
  // in the same snapshot as the conflict check.
  const written = await pool.query<{
    inserted: boolean | null;
    touched: string;
    was_active: boolean | null;
  }>(
    `WITH before AS (
       SELECT active FROM reviewer WHERE identity = $1
     ), written AS (
       INSERT INTO reviewer (identity, products)
       VALUES ($1, COALESCE($2::text[], '{}'))
       ON CONFLICT (identity) DO UPDATE
         SET active = true,
             deactivated_at = NULL,
             products = COALESCE($2::text[], reviewer.products)
         WHERE reviewer.active = false
            OR ($2::text[] IS NOT NULL AND reviewer.products IS DISTINCT FROM $2::text[])
       RETURNING (xmax = 0) AS inserted
     )
     SELECT (SELECT inserted FROM written) AS inserted,
            (SELECT count(*) FROM written) AS touched,
            (SELECT active FROM before)    AS was_active`,
    [name, products === undefined ? null : [...products]],
  );
  const row = written.rows[0];
  if (row === undefined || Number(row.touched) === 0) return { outcome: 'already_listed' };
  if (row.inserted === true) return { outcome: 'added' };
  return row.was_active === false ? { outcome: 'reactivated' } : { outcome: 'products_set' };
}

/**
 * The products one reviewer covers, for the queue's own order (DEC-47).
 *
 * Empty for a reviewer this ledger does not hold, which is the same answer
 * as a reviewer who declared no focus: nothing is reordered. The console
 * reads it for the reviewer the request already resolved to, so an unknown
 * identity here is a race with a deactivation rather than a stranger.
 */
export async function reviewerProducts(
  pool: Pool,
  identity: string,
): Promise<readonly string[]> {
  const rows = await pool.query<{ products: string[] }>(
    'SELECT products FROM reviewer WHERE identity = $1',
    [identity],
  );
  return rows.rows[0]?.products ?? [];
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
    `SELECT identity, active, added_at, deactivated_at, products
       FROM reviewer
      ORDER BY added_at DESC, identity`,
  );
  return rows.rows.map((row) => ({
    identity: row.identity as string,
    active: row.active as boolean,
    addedAt: row.added_at as Date,
    deactivatedAt: (row.deactivated_at as Date | null) ?? null,
    products: (row.products as string[] | null) ?? [],
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
