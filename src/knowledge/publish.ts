// A document a reviewer writes from a case, and publishes (DEC-50).
//
// An unsupported claim is the system naming the document it needed, and an
// abstention says no document could answer. Either way a person has to write
// the answer, and the answer belongs in the knowledge base rather than in one
// reply. So a reviewer writes it from inside the case, and it is published
// there.
//
// What DEC-50 asks of the document, and where each part is held:
//
//   an owner and a review date (DEC-23)   the form's fields, both required
//   at least one product (DEC-47)         the case's own product, and any other
//                                         product of the catalogue
//   no identifier of the case             `findIdentifier`, over title and body
//   retrieval ignores it until embedded   the row is written 'pending' with no
//                                         vector, and a consumer embeds it
//
// A case whose channel maps no product cannot publish. The document would
// have to name a product the case never had, and DEC-47 retrieves by the
// run's product, so nothing would say which product the answer is for.
//
// The case's product is required among the document's. A run retrieves the
// documents of its own product and the documents that declare none, so a
// document without it could never answer the case it was written for.
//
// Publishing also asks for a new attempt of the case (`rerun.ts`). The
// document and the request commit in one transaction, and a case that cannot
// be attempted again still publishes: its request is recorded as dropped at
// once, with the reason, so the case says why nothing starts.
//
// The console calls no model. The consumer embeds the row on its next scan.
import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { replyDigest } from '../approval/shown.js';
import { lockTurnAttempt, readSavedReply } from '../ledger/conversation.js';
import { errorMessage } from '../errors.js';
import { isStorableText } from '../ledger/storable-text.js';
import { logLine } from '../log/line.js';
import { findIdentifier } from './identifiers.js';
import type { CaseIdentifiers, IdentifierKind } from './identifiers.js';
import { readRerunRows, rerunVerdict, settleRerun } from './rerun.js';
import type { RerunReason } from './rerun.js';

export const MAX_DOCUMENT_TITLE_CHARS = 200;
/**
 * The longest body a reviewer may publish, in UTF-8 bytes.
 *
 * The embedding model refuses an input past its own limit, 8,192 tokens for
 * the default model, and a refusal after publishing fails the document. Its
 * tokenizer works on bytes and never spends more than one token on a byte,
 * so a body of 7,000 bytes and a title of at most 800 stay under the limit
 * in any script. In English that is about 7,000 characters.
 */
export const MAX_DOCUMENT_BODY_BYTES = 7_000;
/** The field's own bound, in characters: no body within it can be longer in bytes. */
export const MAX_DOCUMENT_BODY_CHARS = MAX_DOCUMENT_BODY_BYTES;
export const MAX_DOCUMENT_OWNER_CHARS = 200;

/** How long a publish may wait for a lock, and how long each statement may run. */
export const PUBLISH_TIMEOUT_MS = 5_000;

/** Postgres's codes for a lock wait and a statement that ran past their bound. */
const LOCK_NOT_AVAILABLE = '55P03';
const QUERY_CANCELED = '57014';

/** The bound a publish runs under: a whole count of milliseconds, never interpolated from input. */
function boundOf(timeoutMs: number | undefined): number {
  return Number.isInteger(timeoutMs) && timeoutMs! > 0 && timeoutMs! <= PUBLISH_TIMEOUT_MS
    ? timeoutMs!
    : PUBLISH_TIMEOUT_MS;
}

export interface PublishInput {
  /** The run the reviewer read. */
  readonly runId: string;
  readonly title: string;
  readonly body: string;
  /** Product ids, as the catalogue names them. */
  readonly products: readonly string[];
  readonly owner: string;
  /** The review date, as `YYYY-MM-DD` (DEC-23). */
  readonly reviewBy: string;
  /** DEC-45: the reviewer the console accepted. */
  readonly writtenBy: string;
  /** The product ids the catalogue declares. A product outside it is refused. */
  readonly catalogue: readonly string[];
  /** DEC-46: the digest of the reply the page drew, when it drew one. */
  readonly shown?: string;
  /** DEC-44: whether the adapter's ledger holds the reply. */
  readonly ledgerReply: boolean;
  /** The bound on a lock wait and on each statement. `PUBLISH_TIMEOUT_MS` unless a test shortens it. */
  readonly timeoutMs?: number;
}

export type PublishOutcome =
  | {
    readonly outcome: 'published';
    readonly docId: string;
    /** The same post arrived again, and this is the document the first one wrote. */
    readonly repeated?: true;
    /**
     * The request's state now: waiting, dropped with the reason, or, for a
     * repeat of an earlier post, started or failed since.
     */
    readonly rerun:
      | { readonly status: 'waiting' | 'started' | 'failed' }
      | { readonly status: 'dropped'; readonly reason: RerunReason };
  }
  /**
   * This case already published a document with this title and answer, and
   * the post differs from it. A second copy would be a duplicate in the
   * knowledge base.
   */
  | { readonly outcome: 'already_published'; readonly docId: string }
  | { readonly outcome: 'unknown_run' }
  /**
   * This post repeats a document that a person removes by hand while the post
   * runs. The removal stands, so the post publishes nothing.
   */
  | { readonly outcome: 'removed' }
  /**
   * Another write held the case past the publish's bound, or a statement
   * ran past it. The transaction rolled back, so nothing was published.
   */
  | { readonly outcome: 'busy' }
  /** The case's channel maps no product: the channel must be mapped first. */
  | { readonly outcome: 'no_product' }
  | { readonly outcome: 'no_products' }
  /** The case's own product is not among the document's. */
  | { readonly outcome: 'product_missing'; readonly product: string }
  | { readonly outcome: 'unknown_product'; readonly product: string }
  | { readonly outcome: 'title_empty' }
  | { readonly outcome: 'title_too_long' }
  | { readonly outcome: 'body_empty' }
  | { readonly outcome: 'body_too_long' }
  | { readonly outcome: 'owner_empty' }
  | { readonly outcome: 'owner_too_long' }
  | { readonly outcome: 'no_author' }
  /** A field carries a NUL or a lone surrogate, which the ledger cannot store. */
  | { readonly outcome: 'unprintable'; readonly field: 'title' | 'body' | 'owner' }
  | { readonly outcome: 'review_date_invalid' }
  /** The review date is today or earlier, so retrieval would ignore the document. */
  | { readonly outcome: 'review_date_not_ahead' }
  | { readonly outcome: 'identifier'; readonly field: 'title' | 'body' | 'owner'; readonly kind: IdentifierKind }
  /** DEC-46: the reply the page drew is not the reply the ledger holds now. */
  | { readonly outcome: 'shown_changed' };

type Refusal = Exclude<PublishOutcome, { outcome: 'published' }>;

/** True when the text has no visible character: trimmed, and without format characters. */
function blank(text: string): boolean {
  return text.replace(/\p{Cf}/gu, '').trim().length === 0;
}

const REVIEW_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** A calendar date that exists, so "2026-02-30" is refused rather than rolled over. */
function isCalendarDate(value: string): boolean {
  const parts = REVIEW_DATE.exec(value);
  if (parts === null) return false;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The checks that need no ledger, in the order a form reads. */
function refuseFields(input: PublishInput, title: string, body: string, owner: string): Refusal | null {
  if (blank(title)) return { outcome: 'title_empty' };
  if (Array.from(title).length > MAX_DOCUMENT_TITLE_CHARS) return { outcome: 'title_too_long' };
  if (!isStorableText(title)) return { outcome: 'unprintable', field: 'title' };
  if (blank(body)) return { outcome: 'body_empty' };
  if (Buffer.byteLength(body, 'utf8') > MAX_DOCUMENT_BODY_BYTES) return { outcome: 'body_too_long' };
  if (!isStorableText(body)) return { outcome: 'unprintable', field: 'body' };
  if (blank(owner)) return { outcome: 'owner_empty' };
  if (Array.from(owner).length > MAX_DOCUMENT_OWNER_CHARS) return { outcome: 'owner_too_long' };
  if (!isStorableText(owner)) return { outcome: 'unprintable', field: 'owner' };
  if (!isCalendarDate(input.reviewBy)) return { outcome: 'review_date_invalid' };
  if (blank(input.writtenBy)) return { outcome: 'no_author' };
  const known = new Set(input.catalogue);
  for (const product of input.products) {
    if (!known.has(product)) return { outcome: 'unknown_product', product };
  }
  return null;
}

/**
 * Every identifier the ledger holds for the case: across the whole
 * conversation, or for the run alone when it has none.
 *
 * The conversation rather than the turn, because a document outlives the
 * case, and an earlier turn's ticket id identifies the customer as surely as
 * this one's.
 */
async function identifiersOf(
  client: PoolClient,
  runId: string,
  conversationId: string | null,
): Promise<CaseIdentifiers> {
  const { rows } = await client.query<{ kind: keyof CaseIdentifiers; value: string | null }>(
    `WITH runs AS (
       SELECT run_id, ticket_id FROM run
        WHERE ($2::uuid IS NOT NULL AND conversation_id = $2::uuid)
           OR run_id = $1::uuid
     )
     SELECT 'addresses' AS kind, customer_address AS value
       FROM conversation WHERE conversation_id = $2::uuid
     UNION ALL SELECT 'tickets', primary_ticket_id FROM conversation WHERE conversation_id = $2::uuid
     UNION ALL SELECT 'tickets', ticket_id FROM turn WHERE conversation_id = $2::uuid
     UNION ALL SELECT 'tickets', ticket_id FROM runs
     UNION ALL SELECT 'tickets', ticket_id FROM intake WHERE conversation_id = $2::uuid
     UNION ALL SELECT 'messages', inbound_message_id FROM turn WHERE conversation_id = $2::uuid
     UNION ALL SELECT 'messages', message_id FROM intake WHERE conversation_id = $2::uuid
     -- A run with no conversation holds its message only on its queued rows.
     UNION ALL SELECT 'messages', message_id FROM intake WHERE ticket_id IN (SELECT ticket_id FROM runs)
     UNION ALL SELECT 'drafts', s.result->>'draftExternalId'
                 FROM step_journal s JOIN runs ON runs.run_id = s.run_id
                WHERE s.step_id = 'park'
     UNION ALL SELECT 'drafts', o.payload->>'draftExternalId'
                 FROM outbox o JOIN runs ON runs.run_id = o.run_id`,
    [runId, conversationId],
  );
  const ids: Record<keyof CaseIdentifiers, string[]> = { addresses: [], tickets: [], messages: [], drafts: [] };
  for (const row of rows) {
    if (typeof row.value === 'string' && row.value.trim() !== '') ids[row.kind].push(row.value);
  }
  return ids;
}

/** DEC-46: whether the reply the page drew is the reply the ledger holds for this parked run. */
async function shownHolds(
  client: PoolClient,
  runId: string,
  conversationId: string | null,
  shown: string,
  ledgerReply: boolean,
): Promise<boolean> {
  const held = await client.query(
    "SELECT result->>'body' AS body, result->>'turnNumber' AS turn"
      + " FROM step_journal WHERE run_id = $1 AND step_id = 'park'",
    [runId],
  );
  const body = held.rows[0]?.body as unknown;
  if (typeof body !== 'string') return false;
  const turn = held.rows[0]!.turn as string | null;
  const saved = ledgerReply
    ? await readSavedReply(client, { conversationId, turnNumber: turn === null ? null : Number(turn) })
    : null;
  return replyDigest(saved ?? body) === shown;
}

/**
 * Publish one document from a case, or refuse and say why.
 *
 * One transaction writes the document and its re-run request. The run's row
 * is locked first and then its turn's, in the order the approval, the close,
 * the snooze and the send-back take them, so the request's first verdict is
 * read against a case none of them is moving.
 */
export async function publishDocument(pool: Pool, input: PublishInput): Promise<PublishOutcome> {
  const title = input.title.trim();
  const body = input.body.trim();
  const owner = input.owner.trim();
  const refused = refuseFields(input, title, body, owner);
  if (refused !== null) return refused;
  const products = [...new Set(input.products)];
  if (products.length === 0) return { outcome: 'no_products' };

  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    try {
      // A page waits on this write, so it is bounded: a lock another writer
      // holds on the run, or a statement that cannot finish, refuses the
      // publish rather than holding the reviewer's request open.
      const bound = boundOf(input.timeoutMs);
      await client.query(`SET LOCAL lock_timeout = '${String(bound)}ms'`);
      await client.query(`SET LOCAL statement_timeout = '${String(bound)}ms'`);
      const outcome = await publishIn(client, input, { title, body, owner, products });
      await client.query(outcome.outcome === 'published' ? 'COMMIT' : 'ROLLBACK');
      return outcome;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollback) {
        broken = rollback instanceof Error ? rollback : new Error(String(rollback));
        console.error(logLine({
          event: 'rollback_failed', at: new Date().toISOString(), write: 'publishDocument',
          error: errorMessage(broken),
        }));
      }
      // A lock wait or a statement past the bound rolled back whole, so the
      // reviewer is told nothing was published, not that it may have been.
      const code = (error as { code?: unknown }).code;
      if (broken === undefined && (code === LOCK_NOT_AVAILABLE || code === QUERY_CANCELED)) {
        return { outcome: 'busy' };
      }
      throw error;
    }
  } finally {
    // A connection whose rollback failed holds a transaction nobody read, so
    // it is destroyed rather than handed to the next caller.
    client.release(broken);
  }
}

async function publishIn(
  client: PoolClient,
  input: PublishInput,
  fields: { title: string; body: string; owner: string; products: readonly string[] },
): Promise<PublishOutcome> {
  const run = await client.query<{
    state: string;
    attempt: number;
    conversation_id: string | null;
    turn_number: number | null;
    product: string | null;
    ahead: boolean;
  }>(
    // Read first, and locked: the run the approval, the close and the snooze
    // lock first too.
    `SELECT state, attempt, conversation_id, turn_number, product,
            $2::date > CURRENT_DATE AS ahead
       FROM run WHERE run_id = $1 FOR UPDATE`,
    [input.runId, input.reviewBy],
  );
  const row = run.rows[0];
  if (row === undefined) return { outcome: 'unknown_run' };
  // DEC-47: an empty product is no product, as the knowledge screen reads it.
  const product = row.product === null || row.product.trim() === '' ? null : row.product;
  if (product === null) return { outcome: 'no_product' };
  if (!fields.products.includes(product)) return { outcome: 'product_missing', product };
  // The retriever reads a document whose review date is today or later, so a
  // date of today would lapse before the attempt it asks for could read it.
  if (!row.ahead) return { outcome: 'review_date_not_ahead' };

  if (row.conversation_id !== null && row.turn_number !== null) {
    await lockTurnAttempt(client, { conversationId: row.conversation_id, turnNumber: row.turn_number });
  }

  const ids = await identifiersOf(client, input.runId, row.conversation_id);
  const inTitle = findIdentifier(fields.title, ids);
  if (inTitle !== null) return { outcome: 'identifier', field: 'title', kind: inTitle };
  const inBody = findIdentifier(fields.body, ids);
  if (inBody !== null) return { outcome: 'identifier', field: 'body', kind: inBody };
  // The owner is published with the document, so it is checked as well: an
  // owner named by the customer's address would carry the case.
  const inOwner = findIdentifier(fields.owner, ids);
  if (inOwner !== null) return { outcome: 'identifier', field: 'owner', kind: inOwner };

  if (input.shown !== undefined && row.state === 'awaiting_approval'
    && !(await shownHolds(client, input.runId, row.conversation_id, input.shown, input.ledgerReply))) {
    return { outcome: 'shown_changed' };
  }

  // The same document posted twice from the same case, as a double click or
  // a resubmitted form does, is one publish. The run's lock above orders the
  // two, so the second finds the first. An exact repeat is answered with the
  // first document. A post with the same title and answer that differs
  // otherwise is refused by name: a second copy of one answer is a duplicate
  // in the knowledge base. Products compare as a set, since order is no
  // part of a document.
  const earlier = await client.query<{ doc_id: string; exact: boolean; status: string; reason: RerunReason | null }>(
    `SELECT d.doc_id, q.status, q.reason,
            (d.owner = $4 AND d.review_by = $5::date AND d.written_by = $7
             AND d.products @> $6::text[] AND d.products <@ $6::text[]) AS exact
       FROM document d JOIN document_rerun q ON q.doc_id = d.doc_id
      WHERE q.run_id = $1 AND d.title = $2 AND d.body = $3`,
    [input.runId, fields.title, fields.body, fields.owner, input.reviewBy, fields.products, input.writtenBy.trim()],
  );
  const found = earlier.rows[0];
  if (found !== undefined) {
    // A person can remove the first document by hand while this post runs,
    // with the runbook's removal block. That block locks the request before it
    // deletes, so this lock waits for it, and then reads the request as it
    // stands. A removed document stays removed: a reviewer writes the post
    // before that act, and publishing it again would undo it (DEC-50).
    const locked = await client.query<{ status: string; reason: RerunReason | null }>(
      'SELECT status, reason FROM document_rerun WHERE doc_id = $1 FOR UPDATE',
      [found.doc_id],
    );
    const request = locked.rows[0];
    if (request === undefined) return { outcome: 'removed' };
    const same = { ...found, ...request };
    if (!same.exact) return { outcome: 'already_published', docId: same.doc_id };
    // A re-run that ended, as one on a run the system held too long does,
    // is asked for again by the same post. It keeps the replies and the time
    // of the first request, so a reply a person saved since then still ends
    // it (DEC-46). A re-run that a person's act ended stays ended: the post
    // was written before that act, and asking again would undo it.
    if (same.status === 'dropped' && same.reason === 'ended') {
      await client.query(
        `UPDATE document_rerun
            SET status = 'waiting', reason = NULL, ended_at = NULL, started_attempt = NULL,
                checked_at = NULL, faults = 0, retry_after = NULL
          WHERE doc_id = $1`,
        [same.doc_id],
      );
      return { ...(await firstVerdict(client, input, same.doc_id)), repeated: true };
    }
    // The repeat answers with the first post's request as it stands now.
    return {
      outcome: 'published', docId: same.doc_id, repeated: true,
      rerun: same.status === 'dropped' && same.reason !== null
        ? { status: 'dropped', reason: same.reason }
        : { status: same.status === 'started' || same.status === 'failed' ? same.status : 'waiting' },
    };
  }

  const docId = `console-${randomUUID()}`;
  await client.query(
    `INSERT INTO document (doc_id, kind, title, body, owner, review_by, products, source,
                           embedding_status, written_by)
     VALUES ($1, 'document', $2, $3, $4, $5::date, $6::text[], 'console', 'pending', $7)`,
    [docId, fields.title, fields.body, fields.owner, input.reviewBy, fields.products, input.writtenBy.trim()],
  );
  // DEC-46: the reply the reviewer read, on a parked case, and the reply
  // saved on the turn now, whatever the run is doing. The scan drops the
  // request when a person saved or rewrote a reply after this, so a new
  // attempt never throws their work away.
  const saved = await readSavedReply(client, { conversationId: row.conversation_id, turnNumber: row.turn_number });
  await client.query(
    `INSERT INTO document_rerun (doc_id, run_id, conversation_id, turn_number, attempt, shown, saved_digest)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [docId, input.runId, row.conversation_id, row.turn_number, row.attempt,
      row.state === 'awaiting_approval' ? input.shown ?? null : null,
      saved === null ? null : replyDigest(saved)],
  );
  return firstVerdict(client, input, docId);
}

/**
 * The first verdict of a request that waits, recorded under the locks the
 * caller holds. The document is pending, or embedded or failed when a post
 * asks again. So the verdict can also be a start, which the consumer's next
 * scan performs, or a failure.
 */
async function firstVerdict(
  client: PoolClient,
  input: PublishInput,
  docId: string,
): Promise<Extract<PublishOutcome, { outcome: 'published' }>> {
  const [request] = await readRerunRows(client, { docIds: [docId] }, input.ledgerReply);
  const verdict = rerunVerdict(request!.facts);
  if (verdict.kind === 'dropped' || verdict.kind === 'failed') {
    await settleRerun(client, docId, verdict);
    return verdict.kind === 'dropped'
      ? { outcome: 'published', docId, rerun: { status: 'dropped', reason: verdict.reason } }
      : { outcome: 'published', docId, rerun: { status: 'failed' } };
  }
  return { outcome: 'published', docId, rerun: { status: 'waiting' } };
}
