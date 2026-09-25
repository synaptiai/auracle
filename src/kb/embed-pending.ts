/**
 * Embeds the documents that wait for a vector (DEC-50).
 *
 * The console writes a document and calls no model, so the document waits in
 * the ledger with no vector, and retrieval ignores it. Every consumer runs
 * this on each scan. No partition owns a document, so any consumer may claim
 * one: the claim is a short lease taken with SKIP LOCKED, so two consumers
 * never embed one document at once.
 *
 * Three steps, and only the first and last touch the ledger:
 *
 *   1. Claim a batch in one short transaction. It commits before the model
 *      is called, so no row lock is held across a network call; a
 *      consumer's pool is one connection, and a lock held there would stall
 *      every other write the consumer makes.
 *   2. Call the model with no transaction open.
 *   3. Write each vector only while this consumer's claim holds and the text
 *      is the text it embedded. Each write compares the lease this consumer
 *      took and the clock, so a slow call never overwrites the work of the
 *      consumer that claimed the document next.
 *
 * A failed call is recorded against each document with its reason, and a
 * later scan retries it after a delay. Only a refusal of the input itself
 * uses up one of the document's attempts. After three refusals the document
 * is failed, and it stays out of retrieval until someone fixes it. Any other
 * fault, an outage, a timeout, a key or a model pin, is no fault of the
 * document: it waits, and the log carries the reason.
 *
 * A document that failed once goes to the model alone. The model refuses a
 * whole call for one bad input, such as a body longer than it accepts, and a
 * batch would charge that refusal to every document in it. Alone, a good
 * document loses at most one attempt to a bad one. A scan makes two model
 * calls: one retried document, and one batch of fresh ones. A refusal adds a
 * probe after its call, so a scan makes four calls at most.
 */
import type { Pool } from 'pg';

import { errorMessage } from '../errors.js';
import { ProviderHttpError, UnreadableAnswerError } from '../models/provider.js';
import type { ModelProvider } from '../models/provider.js';
import { dimensionMismatch, documentEmbeddingColumnDim } from './loader.js';

/** Fresh documents claimed per scan. A scan's real work is the queue; this is small. */
export const EMBED_PENDING_BATCH = 4;
/**
 * The deadline of one embedding call. The scan waits for its calls, and the
 * queue waits for the scan. A scan makes four calls at most, so a stalled
 * model delays customer messages by four times this at most.
 */
export const EMBED_CALL_TIMEOUT_MS = 15_000;
/**
 * How long a claim holds. A scan's four calls at the deadline above take one
 * minute at most, so the claim outlasts them and each records its outcome. A
 * provider that ignored the deadline could outlast the claim. Its outcome
 * would then read as lost and write nothing, and a later scan tries again.
 */
export const EMBED_LEASE_SECONDS = 180;
/** Refusals of its input before a document is failed and no longer claimed. */
export const MAX_EMBED_FAILURES = 3;
/**
 * How long a document waits after each refusal before a consumer claims it
 * again: a minute after the first, five after the second. The third refusal
 * makes it failed, so no third delay exists.
 */
export const EMBED_RETRY_DELAYS_SECONDS: readonly number[] = [60, 300];
/** How long a document waits after a fault that is not its own. */
export const EMBED_DEFERRED_RETRY_SECONDS = 300;
/**
 * The statuses by which a provider refuses the input itself: malformed, too
 * large, or not processable. Every other status is the service's own.
 */
export const INPUT_REFUSED_STATUSES: readonly number[] = [400, 413, 422];
/**
 * A text every embedding model accepts. The status alone cannot tell a
 * refused input from a refused call: OpenRouter answers 400 for a model pin
 * that names no model. So after a refusal the consumer embeds this, and only
 * when the model takes it was the refusal the document's own.
 */
export const EMBED_PROBE_TEXT = 'A short text that any embedding model accepts.';
/** The most of a failure's reason the ledger keeps. */
export const EMBED_ERROR_MAX_CHARS = 500;

/** The prompt pin an embedding of a document carries (DEC-26). */
const PROMPT_VER = 'embed-pending-v1';

/** One document this consumer holds the lease on. */
export interface PendingClaim {
  readonly docId: string;
  readonly title: string;
  readonly body: string;
  /** The lease, read back from the ledger: the write compares against it. */
  readonly claimedUntil: Date;
  /**
   * The document failed or was deferred before, so it goes to the model
   * alone: whatever made its call fail cannot fail another document's.
   */
  readonly alone: boolean;
}

/** One failed attempt: the document, and why it failed. */
export interface EmbedFailure {
  readonly docId: string;
  readonly reason: string;
}

/** What one pass did, by document id. */
export interface EmbedPendingReport {
  /** Now embedded, and retrievable. */
  readonly embedded: string[];
  /** The model refused the input: one attempt used, tried again after a delay. */
  readonly retrying: EmbedFailure[];
  /** Failed for a cause that is not the document's: no attempt used. */
  readonly deferred: EmbedFailure[];
  /** Failed for the last time: out of retrieval until someone fixes it. */
  readonly failed: EmbedFailure[];
  /**
   * Nothing written: the claim ran out or passed to another consumer, another
   * writer held the row, or the text changed during the call. The reason
   * names which. A later scan claims it again once the claim runs out.
   */
  readonly lost: EmbedFailure[];
  /**
   * The ledger refused to record the outcome. The claim runs out, and a later
   * scan tries again. The reason names both faults.
   */
  readonly unrecorded: EmbedFailure[];
  /** What the scan's model calls cost, in integer micro-dollars (DEC-25). */
  costMicros: number;
  /** A call the provider answered without a cost it could read (DEC-25). */
  costUnknown: boolean;
}

/**
 * Claims waiting documents, oldest first, and commits the claim.
 *
 * A document is claimable while it waits, no lease holds it and its retry
 * delay has passed. The claim takes one document that goes alone, having
 * failed or been deferred before, and up to `batch` others. Of those that go
 * alone, the one whose delay ended first goes first. A fresh document
 * so never waits behind a queue of retried ones. One statement takes both,
 * so a claim never commits half. SKIP LOCKED hands a row another consumer is
 * claiming at the same moment to nobody here, so two claims at once never
 * return one document twice.
 */
export async function claimPendingDocuments(
  pool: Pool,
  batch: number = EMBED_PENDING_BATCH,
  leaseSeconds: number = EMBED_LEASE_SECONDS,
): Promise<PendingClaim[]> {
  // A lease of no length is one already run out: every write would read as
  // lost, and another consumer could claim the document during the call.
  if (!Number.isFinite(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error(`a claim needs a lease of more than zero seconds, got ${leaseSeconds}`);
  }
  const claimable = `embedding_status = 'pending'
                 AND (embedding_claimed_until IS NULL OR embedding_claimed_until <= clock_timestamp())
                 AND (embedding_retry_after IS NULL OR embedding_retry_after <= clock_timestamp())`;
  const claimed = await pool.query<{
    doc_id: string;
    title: string;
    body: string;
    embedding_claimed_until: Date;
    alone: boolean;
    created_at: Date;
  }>(
    `WITH alone AS (
            SELECT doc_id FROM document
             WHERE ${claimable} AND (embedding_failures > 0 OR embedding_deferrals > 0)
             -- The one whose delay ended first, so a document that keeps
             -- failing takes its turn and no more.
             ORDER BY embedding_retry_after NULLS FIRST, created_at, doc_id
             LIMIT 1
             FOR UPDATE SKIP LOCKED),
          together AS (
            SELECT doc_id FROM document
             WHERE ${claimable} AND embedding_failures = 0 AND embedding_deferrals = 0
             ORDER BY created_at, doc_id
             LIMIT $1
             FOR UPDATE SKIP LOCKED)
     UPDATE document d
        -- Whole milliseconds: the write compares the lease it read back, and
        -- a JavaScript Date keeps no microseconds, so a lease that had them
        -- would never match and every write would read as a lost claim.
        SET embedding_claimed_until = date_trunc('milliseconds', clock_timestamp() + make_interval(secs => $2))
      WHERE d.doc_id IN (SELECT doc_id FROM alone UNION ALL SELECT doc_id FROM together)
      RETURNING d.doc_id, d.title, d.body, d.embedding_claimed_until,
                (d.embedding_failures > 0 OR d.embedding_deferrals > 0) AS alone, d.created_at`,
    [batch, leaseSeconds],
  );
  // RETURNING keeps no order: the document going alone first, then oldest
  // first, as the claim chose them.
  return [...claimed.rows]
    .sort((a, b) => Number(b.alone) - Number(a.alone)
      || a.created_at.getTime() - b.created_at.getTime() || a.doc_id.localeCompare(b.doc_id))
    .map((row) => ({
      docId: row.doc_id,
      title: row.title,
      body: row.body,
      claimedUntil: row.embedding_claimed_until,
      alone: row.alone,
    }));
}

/**
 * A failure's reason, cut to what the ledger keeps. Cut by characters, not
 * UTF-16 units, so a character outside the basic plane is never split.
 */
function boundedReason(reason: string): string {
  // Postgres refuses a NUL in text, and a reason it refuses records nothing.
  return Array.from(reason.split(String.fromCharCode(0)).join('')).slice(0, EMBED_ERROR_MAX_CHARS).join('');
}

/**
 * The row a guarded write may change: still waiting, still under this
 * consumer's lease, the lease not yet run out, and not locked by another
 * writer. A lease that ran out is lost even when nobody claimed it since: the
 * write is no longer this consumer's to make. SKIP LOCKED rather than a wait:
 * a consumer's pool is one connection, and a write waiting on a lock would
 * stall the queue behind it. A row it skips reads as lost, and the next scan
 * claims it once the lease has run out.
 */
const GUARDED_ROW = `doc_id = (
          SELECT doc_id FROM document
           WHERE doc_id = $1 AND embedding_status = 'pending' AND embedding_claimed_until = $2
             AND embedding_claimed_until > clock_timestamp()
             FOR UPDATE SKIP LOCKED)`;

/**
 * Writes the vector while this consumer's claim holds (the guarded row), and
 * only when the text is unchanged: a vector of the old text would rank the
 * new one (DEC-21).
 *
 * `embedded_with` takes the pin, not the id the provider served. The
 * retrieval step and the loader record the pin, so the three compare. The
 * served id need not: OpenRouter serves `openai/text-embedding-3-small` as
 * `text-embedding-3-small`.
 */
async function writeVector(
  pool: Pool,
  claim: PendingClaim,
  vector: number[],
  modelVer: string,
): Promise<boolean> {
  const written = await pool.query(
    `UPDATE document
        SET embedding = $3::vector, embedding_status = 'embedded', embedded_with = $4,
            embedding_error = NULL, embedding_claimed_until = NULL, embedding_retry_after = NULL
      WHERE ${GUARDED_ROW} AND title = $5 AND body = $6`,
    [claim.docId, claim.claimedUntil, `[${vector.join(',')}]`, modelVer, claim.title, claim.body],
  );
  return written.rowCount === 1;
}

/**
 * Whether a failure is the model refusing this input, which uses an attempt:
 * a refusal status, and a model that still embeds the probe text. The probe
 * is one short call, made only after a refusal. When the probe fails too, its
 * own error joins the reason, so the log shows why the refusal did not count.
 */
async function judgeRefusal(
  error: unknown,
  provider: ModelProvider,
  modelVer: string,
  report: EmbedPendingReport,
): Promise<{ counts: boolean; reason: string }> {
  const reason = errorMessage(error);
  if (!(error instanceof ProviderHttpError) || !INPUT_REFUSED_STATUSES.includes(error.status)) {
    return { counts: false, reason };
  }
  try {
    const probe = await provider.embed({
      input: [EMBED_PROBE_TEXT],
      promptVer: PROMPT_VER,
      modelVer,
      timeoutMs: EMBED_CALL_TIMEOUT_MS,
    });
    report.costMicros += probe.costMicros;
    return { counts: true, reason };
  } catch (probeError) {
    chargeUnreadable(probeError, report);
    // The model refuses any text, so the fault is the call's, not the input's.
    return { counts: false, reason: `${reason}; the probe failed too: ${errorMessage(probeError)}` };
  }
}

/**
 * Records a failed attempt, releases the claim and sets the delay before the
 * next attempt, while this consumer's claim holds (the guarded row). A refusal
 * (`counts`) uses one of the document's attempts. Any other fault uses none,
 * and marks the document to go alone next time: a fault that one input causes
 * would otherwise fail the same batch every time. Returns what became of the
 * document, or null when nothing was written.
 */
async function recordFailure(
  pool: Pool,
  claim: PendingClaim,
  reason: string,
  counts: boolean,
): Promise<'retrying' | 'deferred' | 'failed' | null> {
  const recorded = await pool.query<{ embedding_status: string }>(
    `UPDATE document
        SET embedding_failures = embedding_failures + CASE WHEN $6 THEN 1 ELSE 0 END,
            embedding_deferrals = embedding_deferrals + CASE WHEN $6 THEN 0 ELSE 1 END,
            embedding_error = $3,
            embedding_claimed_until = NULL,
            embedding_status = CASE WHEN $6 AND embedding_failures + 1 >= $4 THEN 'failed' ELSE 'pending' END,
            -- The delay that follows this failure. The array is 1-based, and
            -- embedding_failures still holds the count before this one.
            embedding_retry_after = CASE
              WHEN $6 AND embedding_failures + 1 >= $4 THEN NULL
              WHEN $6 THEN date_trunc('milliseconds', clock_timestamp()
                     + make_interval(secs => ($5::int[])[embedding_failures + 1]))
              ELSE date_trunc('milliseconds', clock_timestamp() + make_interval(secs => $7)) END
      WHERE ${GUARDED_ROW}
      RETURNING embedding_status`,
    [
      claim.docId,
      claim.claimedUntil,
      boundedReason(reason),
      MAX_EMBED_FAILURES,
      EMBED_RETRY_DELAYS_SECONDS,
      counts,
      EMBED_DEFERRED_RETRY_SECONDS,
    ],
  );
  const status = recorded.rows[0]?.embedding_status;
  if (status === undefined) return null;
  if (status === 'failed') return 'failed';
  return counts ? 'retrying' : 'deferred';
}

/**
 * Claims waiting documents, embeds them, and writes each vector while its
 * claim holds. Calls no model when nothing waits.
 *
 * A retried document goes to the model alone, and the fresh ones in one
 * batch. A refusal adds one probe call, so a scan makes four calls at most.
 *
 * `modelVer` is the embedding model the consumer retrieves with, so a query
 * vector and a document vector come from one model. `leaseSeconds` is the
 * claim's length: the consumer keeps the default, and a test shortens it to
 * watch a claim run out.
 */
export async function embedPendingDocuments(
  pool: Pool,
  provider: ModelProvider,
  modelVer: string,
  leaseSeconds: number = EMBED_LEASE_SECONDS,
): Promise<EmbedPendingReport> {
  const report: EmbedPendingReport = {
    embedded: [], retrying: [], deferred: [], failed: [], lost: [], unrecorded: [],
    costMicros: 0, costUnknown: false,
  };
  const claims = await claimPendingDocuments(pool, EMBED_PENDING_BATCH, leaseSeconds);
  if (claims.length === 0) return report;
  // Outside the attempt's own guard: a ledger that cannot answer is no fault
  // of these documents, so it costs none of them an attempt. The error
  // reaches the scan's guard, and the claims lapse with their lease.
  const columnDim = await documentEmbeddingColumnDim(pool);

  const alone = claims.filter((claim) => claim.alone);
  const together = claims.filter((claim) => !claim.alone);
  for (const group of [...alone.map((claim) => [claim]), together]) {
    if (group.length > 0) await embedGroup(pool, provider, modelVer, columnDim, group, report);
  }
  return report;
}

/**
 * An answer the provider could not read was still paid for (DEC-25): its
 * cost, or the fact that the cost is unknown, joins the scan's report.
 */
function chargeUnreadable(error: unknown, report: EmbedPendingReport): void {
  if (!(error instanceof UnreadableAnswerError)) return;
  report.costMicros += error.costMicros;
  if (error.costUnknown) report.costUnknown = true;
}

/**
 * Why a guarded write found no row it may change, read once without a lock,
 * so the log names the one cause that applies. A read that fails names all.
 */
async function lostCause(pool: Pool, claim: PendingClaim): Promise<string> {
  let row: { embedding_status: string; claimed_until: Date | null; live: boolean; same_text: boolean } | undefined;
  try {
    const read = await pool.query<{ embedding_status: string; claimed_until: Date | null; live: boolean; same_text: boolean }>(
      `SELECT embedding_status, embedding_claimed_until AS claimed_until,
              coalesce(embedding_claimed_until > clock_timestamp(), false) AS live,
              (title = $2 AND body = $3) AS same_text
         FROM document WHERE doc_id = $1`,
      [claim.docId, claim.title, claim.body],
    );
    row = read.rows[0];
  } catch {
    return 'its claim ran out or passed to another consumer, another writer holds it, or its text changed';
  }
  if (row === undefined) return 'it no longer exists';
  if (row.embedding_status !== 'pending') return 'it is no longer waiting for an embedding';
  if (row.claimed_until?.getTime() !== claim.claimedUntil.getTime()) return 'its claim passed to another consumer';
  if (!row.live) return 'its claim ran out during the call';
  if (!row.same_text) return 'its text changed during the call';
  return 'another writer holds its row';
}

/** A Postgres data exception (SQLSTATE class 22): the value, not the ledger. */
function isDataException(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('22');
}

/** One model call for `claims`, and one guarded write for each of them. */
async function embedGroup(
  pool: Pool,
  provider: ModelProvider,
  modelVer: string,
  columnDim: number,
  claims: readonly PendingClaim[],
  report: EmbedPendingReport,
): Promise<void> {
  // A fault while recording the first is caught here, per document, so the
  // report of what the scan already did and paid for survives it.
  const fail = async (claim: PendingClaim, reason: string, counts: boolean): Promise<void> => {
    let outcome: Awaited<ReturnType<typeof recordFailure>>;
    try {
      outcome = await recordFailure(pool, claim, reason, counts);
    } catch (ledgerError) {
      report.unrecorded.push({
        docId: claim.docId,
        reason: boundedReason(`the ledger refused the record (${errorMessage(ledgerError)}): ${reason}`),
      });
      return;
    }
    if (outcome === null) {
      report.lost.push({ docId: claim.docId, reason: boundedReason(`${await lostCause(pool, claim)}: ${reason}`) });
    } else {
      report[outcome].push({ docId: claim.docId, reason: boundedReason(reason) });
    }
  };

  let vectors: number[][];
  try {
    const result = await provider.embed({
      // The loader's text, so a document embeds the same way from either door.
      input: claims.map((claim) => `${claim.title}\n\n${claim.body}`),
      promptVer: PROMPT_VER,
      modelVer,
      timeoutMs: EMBED_CALL_TIMEOUT_MS,
    });
    report.costMicros += result.costMicros;
    if (result.vectors.length !== claims.length) {
      throw new Error(`the model returned ${result.vectors.length} vectors for ${claims.length} documents`);
    }
    vectors = result.vectors;
  } catch (error) {
    chargeUnreadable(error, report);
    const { counts, reason } = await judgeRefusal(error, provider, modelVer, report);
    for (const claim of claims) await fail(claim, reason, counts);
    return;
  }

  for (const [index, claim] of claims.entries()) {
    const vector = vectors[index]!;
    if (vector.length !== columnDim) {
      // The model pin's fault, not the document's.
      await fail(claim, dimensionMismatch(columnDim, vector.length, modelVer).message, false);
      continue;
    }
    let written: boolean;
    try {
      written = await writeVector(pool, claim, vector, modelVer);
    } catch (error) {
      if (isDataException(error)) {
        // The ledger refuses this vector, which came from the model and not
        // the input: recorded, with no attempt used.
        await fail(claim, errorMessage(error), false);
      } else {
        // The ledger itself failed, and the vector may be fine. Nothing is
        // recorded against the document; its claim runs out.
        report.unrecorded.push({ docId: claim.docId, reason: boundedReason(`the ledger failed: ${errorMessage(error)}`) });
      }
      continue;
    }
    if (written) report.embedded.push(claim.docId);
    else report.lost.push({ docId: claim.docId, reason: await lostCause(pool, claim) });
  }
}
