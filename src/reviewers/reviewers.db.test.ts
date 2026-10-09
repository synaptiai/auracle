// The roster the console checks a request against (DEC-45).
//
// DEC-45: "The console serves nothing to a request with no roster identity,
// and a trusted proxy authenticates that identity." The roster is the list
// that decides; this suite proves what it accepts, what it refuses, and what
// a deactivation does.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { truncateLedger } from '../test-support/schema.js';
import { dbUrl } from '../db/config.js';
import {
  activeReviewer,
  addReviewer,
  deactivateReviewer,
  listReviewers,
  reviewerProducts,
} from './roster.js';

const pool = new Pool({ connectionString: dbUrl(), max: 4 });

await pool.query('SELECT 1');

describe('the reviewer roster (DEC-45)', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  afterEach(async () => {
    await truncateLedger(pool);
  });

  it('adds a reviewer, lists it active, and deactivates it', async () => {
    const identity = `reviewer-${randomUUID().slice(0, 8)}@example.test`;
    expect(await addReviewer(pool, identity)).toEqual({ outcome: 'added' });

    const listed = await listReviewers(pool);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ identity, active: true, deactivatedAt: null });
    expect(await activeReviewer(pool, identity)).toBe(true);

    expect(await deactivateReviewer(pool, identity)).toEqual({ outcome: 'deactivated' });
    expect(await activeReviewer(pool, identity)).toBe(false);
    const after = await listReviewers(pool);
    expect(after[0]).toMatchObject({ identity, active: false });
    expect(after[0]!.deactivatedAt).toBeInstanceOf(Date);

    // Deactivating again changes nothing and says so.
    expect(await deactivateReviewer(pool, identity)).toEqual({ outcome: 'not_active' });
  });

  // DEC-47: the products a reviewer covers. Empty means the reviewer covers
  // everything, which is what a reviewer with no declared focus covers — so
  // an add that names no products leaves the order of the queue alone.
  it('records the products a reviewer covers, and reports when they change', async () => {
    const identity = `reviewer-${randomUUID().slice(0, 8)}@example.test`;

    expect(await addReviewer(pool, identity, ['aurora'])).toEqual({ outcome: 'added' });
    expect((await listReviewers(pool))[0]?.products).toEqual(['aurora']);

    // The same list again changes nothing, and says so.
    expect(await addReviewer(pool, identity, ['aurora'])).toEqual({ outcome: 'already_listed' });

    // A different list is a change to a row that stays active, and it is not
    // a reactivation: the reviewer was already working.
    expect(await addReviewer(pool, identity, ['ledger', 'aurora']))
      .toEqual({ outcome: 'products_set' });
    expect((await listReviewers(pool))[0]?.products).toEqual(['ledger', 'aurora']);

    // Naming no products leaves what the row holds: an operator adding an
    // identity who is already covered must not silently narrow them to
    // nothing, which is what a written empty list would mean.
    expect(await addReviewer(pool, identity)).toEqual({ outcome: 'already_listed' });
    expect((await listReviewers(pool))[0]?.products).toEqual(['ledger', 'aurora']);

    // A reviewer added with no products covers everything.
    const plain = `reviewer-${randomUUID().slice(0, 8)}@example.test`;
    await addReviewer(pool, plain);
    expect((await listReviewers(pool)).find((row) => row.identity === plain)?.products)
      .toEqual([]);
  });

  it('answers the products one reviewer covers, for the queue order', async () => {
    const identity = `reviewer-${randomUUID().slice(0, 8)}@example.test`;
    await addReviewer(pool, identity, ['aurora']);
    // The console reads this on every request, so it is one statement and it
    // answers a stranger the same way it answers an unscoped reviewer.
    expect(await reviewerProducts(pool, identity)).toEqual(['aurora']);
    expect(await reviewerProducts(pool, 'nobody@example.test')).toEqual([]);
  });

  it('adds an identity once, and says so rather than raising', async () => {
    const identity = `reviewer-${randomUUID().slice(0, 8)}@example.test`;
    expect(await addReviewer(pool, identity)).toEqual({ outcome: 'added' });
    expect(await addReviewer(pool, identity)).toEqual({ outcome: 'already_listed' });
    expect(await listReviewers(pool)).toHaveLength(1);
  });

  it('reactivates an identity that was deactivated', async () => {
    // A mistaken deactivation has to be reversible with the tool that
    // shipped, or the roster only ever loses people.
    const identity = `reviewer-${randomUUID().slice(0, 8)}@example.test`;
    await addReviewer(pool, identity);
    await deactivateReviewer(pool, identity);

    expect(await addReviewer(pool, identity)).toEqual({ outcome: 'reactivated' });
    expect(await activeReviewer(pool, identity)).toBe(true);
    const listed = await listReviewers(pool);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ identity, active: true, deactivatedAt: null });
  });

  // The deactivate path refuses the same values the add path refuses. It
  // must not report `not_active`, which reads as "that reviewer was already
  // off". The reviewer the operator meant stays active.
  it('refuses to deactivate a name the ledger would not record', async () => {
    const identity = `reviewer-${randomUUID().slice(0, 8)}@example.test`;
    await addReviewer(pool, identity);
    expect(await deactivateReviewer(pool, '')).toEqual({ outcome: 'refused_name' });
    expect(await deactivateReviewer(pool, 'anna\u200d@example.test'))
      .toEqual({ outcome: 'refused_name' });
    // And a name that is merely absent is still just not active, which is a
    // different answer from a name no row can hold.
    expect(await deactivateReviewer(pool, 'nobody@example.test'))
      .toEqual({ outcome: 'not_active' });
    expect(await activeReviewer(pool, identity)).toBe(true);
  });

  it('refuses a name the approval path would not keep', async () => {
    // The roster takes identifiers, and the ledger keeps names under the
    // DEC-42 rules. A value the ledger would reduce to `unattributed` cannot
    // be a reviewer: no approval could ever record it.
    expect(await addReviewer(pool, '')).toEqual({ outcome: 'refused_name' });
    expect(await addReviewer(pool, 'x'.repeat(257))).toEqual({ outcome: 'refused_name' });
    expect(await addReviewer(pool, 'anna\u200d@example.test')).toEqual({
      outcome: 'refused_name',
    });
    // `unattributed` is DEC-42's recorded absence of a name. A reviewer
    // literally called that would write a row nobody can read: a name that
    // means "nobody" beside a source that means a console verified it.
    expect(await addReviewer(pool, 'unattributed')).toEqual({ outcome: 'refused_name' });
    expect(await listReviewers(pool)).toEqual([]);
  });

  // The console asks about the name a proxy sent, after `approverFrom` has
  // trimmed it. A roster that held what the maintainer pasted instead would
  // hold a value nobody can send: an identity copied out of a mail header
  // arrives with whitespace around it.
  it('stores the name the console asks about, not what was pasted', async () => {
    const identity = `reviewer-${randomUUID().slice(0, 8)}@example.test`;
    expect(await addReviewer(pool, `  ${identity}\t`)).toEqual({ outcome: 'added' });
    expect((await listReviewers(pool)).map((row) => row.identity)).toEqual([identity]);
    // Which is what the console asks, and what a proxy's value resolves to.
    expect(await activeReviewer(pool, identity)).toBe(true);
    expect(await activeReviewer(pool, `  ${identity}\t`)).toBe(false);
    // And the same value is what deactivates it, since that is what the
    // command line's own rules produce from the same argument.
    expect(await deactivateReviewer(pool, ` ${identity} `)).toEqual({ outcome: 'deactivated' });
    expect(await activeReviewer(pool, identity)).toBe(false);
  });

  // The listing's order is its own statement: a maintainer reads the newest
  // reviewer first. Every other case here inspects a one-row list, so
  // dropping the ORDER BY left them all green.
  it('lists the newest reviewer first, whatever order the rows arrived in', async () => {
    const older = `older-${randomUUID().slice(0, 6)}@example.test`;
    const newer = `newer-${randomUUID().slice(0, 6)}@example.test`;
    // Written directly, so the order in the table is the reverse of the
    // order the listing must return. `addReviewer` cannot draw this: it
    // timestamps both rows with the same clock.
    await pool.query(
      `INSERT INTO reviewer (identity, added_at) VALUES
         ($1, now() - interval '1 hour'), ($2, now())`,
      [older, newer],
    );
    expect((await listReviewers(pool)).map((row) => row.identity))
      .toEqual([newer, older]);
  });

  it('answers an exact, active identity only', async () => {
    const anna = `anna-${randomUUID().slice(0, 6)}@example.test`;
    const longer = `${anna}.secondary`;
    await addReviewer(pool, anna);
    await addReviewer(pool, longer);

    // A prefix is not the person, and neither is a different case.
    const prefix = anna.slice(0, anna.indexOf('@'));
    expect(await activeReviewer(pool, prefix)).toBe(false);
    expect(await activeReviewer(pool, anna.toUpperCase())).toBe(false);
    expect(await activeReviewer(pool, anna)).toBe(true);
    // Somebody who was never listed is refused, and so is an empty value.
    expect(await activeReviewer(pool, 'nobody@example.test')).toBe(false);
    expect(await activeReviewer(pool, '')).toBe(false);

    // A deactivated identity is refused exactly like an absent one.
    await deactivateReviewer(pool, anna);
    expect(await activeReviewer(pool, anna)).toBe(false);
    expect(await activeReviewer(pool, longer)).toBe(true);
  });

  afterAll(async () => {
    await pool.end();
  });
});
