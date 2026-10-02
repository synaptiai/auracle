/**
 * Read-only document queries (DEC-22, DEC-23).
 *
 * A citation is worth showing only if a person can check it. `document` holds
 * what the retriever searches, and this reads one row of it so a claim's
 * source can be opened rather than merely named.
 *
 * The row is today's. `indexDocument` upserts in place on reindex, so a
 * document's title, owner, review date and body are the current ones and not
 * the ones a run retrieved. That is a fact about the ledger rather than a
 * shortcoming here, and the question it raises is answered elsewhere:
 * `readRunJournal` compares the run's recorded digest against the stored body
 * and returns `bodyUnchanged`.
 *
 * Deliberately not answered a second time here. A version of this module
 * carried its own comparison in TypeScript, called from nothing but its own
 * test, while the shipping path compared in SQL. The two disagreed, and the
 * test of the unused one is where that hid.
 *
 * Every statement is a SELECT, and each read runs in one READ ONLY
 * transaction through `boundedRead`. The module never writes, and the
 * database refuses a write if one is ever added, so it is safe to run
 * against a live database. The console runs these reads on page loads, so
 * each statement runs under a timeout and each read under a client deadline.
 */
import type { Pool } from 'pg';

import { boundedRead } from '../db/bounded-read.js';

/** The bound on each statement of a read, in milliseconds. */
export const DOCUMENT_TIMEOUT_MS = 2_000;

/** One document of the index, as it stands now (DEC-22, DEC-23). */
export interface IndexedDocument {
  readonly docId: string;
  /** DEC-22: `document` or `canonical_resolution`. Nothing else is indexed. */
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  /** DEC-23: who answers for this content. */
  readonly owner: string;
  /** DEC-23: past this date the document leaves the automatic path. */
  readonly reviewBy: string;
  /**
   * DEC-47: the products this document serves. Empty means every product.
   * read as the fact it is rather than as a gap: nobody scoped it.
   */
  readonly products: readonly string[];
  /**
   * Whether the review date has passed.
   *
   * Computed in the database against its own clock, so a console in another
   * timezone cannot disagree with the retriever about what is fresh. The
   * retriever filters on `review_by >= CURRENT_DATE`, and this is that same
   * comparison.
   */
  readonly fresh: boolean;
}

const SELECT_DOCUMENT = `
  SELECT doc_id,
         kind,
         title,
         body,
         owner,
         to_char(review_by, 'YYYY-MM-DD') AS review_by,
         review_by >= CURRENT_DATE        AS fresh,
         products
    FROM document
   WHERE doc_id = $1`;

/**
 * One document, or null when the index holds no such id.
 *
 * Null is ordinary rather than an error. A run journals the ids it retrieved,
 * and a document can be removed from the index afterwards — so a citation
 * pointing at nothing is a state an operator will meet, and the surface says
 * the document is gone rather than that the run was wrong.
 */
export async function readDocument(
  pool: Pool,
  docId: string,
  timeoutMs: number = DOCUMENT_TIMEOUT_MS,
  clientTimeoutMs: number = timeoutMs + 1_000,
): Promise<IndexedDocument | null> {
  const rows = await boundedRead(pool, 'readDocument', timeoutMs, clientTimeoutMs, (query) =>
    query(SELECT_DOCUMENT, [docId]));
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    docId: String(row['doc_id']),
    kind: String(row['kind']),
    title: String(row['title']),
    body: String(row['body']),
    owner: String(row['owner']),
    reviewBy: String(row['review_by']),
    products: (row['products'] as string[] | null) ?? [],
    fresh: row['fresh'] === true,
  };
}
