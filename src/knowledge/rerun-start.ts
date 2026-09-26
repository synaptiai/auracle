// The consumer's side of a published document's re-run (DEC-50, DEC-49).
//
// Every scan, a consumer reads the waiting requests of its own partitions and
// asks `rerunVerdict` about each, under the locks a writer of the case takes:
// the run's row first, then its turn's, then the request's. The approval, the
// close, the snooze and the send-back take the first two in that order, so a
// verdict read here is about a case none of them is moving.
//
// A verdict that ends the request is recorded. A verdict to start raises the
// turn to its next attempt, and the consumer's send-back scan then walks it,
// as it walks an attempt a reviewer asked for. How the attempt is raised
// depends on the case:
//
//   parked     The run waits for a person with a reply nobody sent. It ends
//              `superseded` through the send-back's own writes, with no note:
//              the durable marker, the saved reply cleared, the turn raised,
//              the hold released. The approval then refuses the old reply.
//   escalated  The run already ended, and its service time was the system's
//              work. It is not stamped: stamping it sent back would move it
//              into latency's `rejected` class after the fact. The send-back's
//              other writes run as they do for a parked case, and the request,
//              now `started` at that attempt, is the marker the send-back scan
//              reads instead.
//
// Either way the raise and the marker commit together, so a crash between
// them cannot leave a turn whose raised attempt nobody will start: the queue
// holds such a turn's messages until a run lands at the new attempt.
import type { Pool, PoolClient } from 'pg';

import { errorMessage } from '../errors.js';
import { fencedTransition } from '../ledger/insert.js';
import { logLine } from '../log/line.js';
import type { FencedTransitionResult } from '../ledger/insert.js';
import { lockTurnAttempt } from '../ledger/conversation.js';
import { recordSendBackIn } from '../outcomes/send-back.js';
import { readRerunRows, rerunVerdict, settleRerun } from './rerun.js';
import type { RerunReason, RerunRow, RerunVerdict } from './rerun.js';

/** How many waiting requests one scan reads, so a backlog cannot hold up the queue. */
export const RERUN_BATCH = 10;

export interface RerunScanReport {
  /** The documents whose request raised a turn to a new attempt. */
  readonly started: readonly string[];
  readonly dropped: readonly { readonly docId: string; readonly reason: RerunReason }[];
  /** The documents whose embedding failed, so their attempt never starts. */
  readonly failed: readonly string[];
  /** The requests a scan could not settle, with the fault, left waiting for the next. */
  readonly faults: readonly { readonly docId: string; readonly error: string }[];
}

type Settled =
  /** The siblings the start settled with it, which the report lists too. */
  | { readonly kind: 'started'; readonly siblings: Siblings }
  | { readonly kind: 'dropped'; readonly reason: RerunReason }
  | { readonly kind: 'failed' }
  | { readonly kind: 'waiting' }
  /** Another consumer settled the request first. */
  | { readonly kind: 'gone' };

/** A verdict other than a start, raised out of the fenced path's precondition. */
class NotStarting extends Error {
  constructor(readonly verdict: Exclude<RerunVerdict, { kind: 'start' }> | null) {
    super('the re-run does not start');
    this.name = 'NotStarting';
  }
}

/**
 * Settles the waiting requests of these partitions, oldest first, and those
 * whose document has an outcome before those still waiting for one.
 *
 * `ledgerReply` is the adapter's declaration (DEC-44). Each request is
 * settled on its own, and a fault on one is reported and leaves it waiting.
 */
export async function startPublishedReruns(
  pool: Pool,
  options: { readonly partitions: readonly number[]; readonly ledgerReply: boolean; readonly batch?: number },
): Promise<RerunScanReport> {
  const report = { started: [] as string[], dropped: [] as { docId: string; reason: RerunReason }[],
    failed: [] as string[], faults: [] as { docId: string; error: string }[] };
  if (options.partitions.length === 0) return report;
  const { rows } = await pool.query<{ doc_id: string }>(
    `SELECT q.doc_id
       FROM document_rerun q
       JOIN run r ON r.run_id = q.run_id
       JOIN document d ON d.doc_id = q.doc_id
      WHERE q.status = 'waiting' AND r.partition = ANY ($1::int[])
        AND (q.retry_after IS NULL OR q.retry_after <= clock_timestamp())
      ORDER BY q.checked_at NULLS FIRST, d.embedding_status = 'pending', q.requested_at, q.doc_id
      LIMIT $2`,
    [options.partitions, options.batch ?? RERUN_BATCH],
  );
  for (const { doc_id: docId } of rows) {
    try {
      const settled = await settleOne(pool, docId, options.ledgerReply);
      if (settled.kind === 'started') {
        report.started.push(docId, ...settled.siblings.starting);
        for (const { docId: ended, verdict } of settled.siblings.ending) {
          if (verdict.kind === 'failed') report.failed.push(ended);
          else report.dropped.push({ docId: ended, reason: verdict.reason });
        }
      }
      else if (settled.kind === 'dropped') report.dropped.push({ docId, reason: settled.reason });
      else if (settled.kind === 'failed') report.failed.push(docId);
    } catch (error) {
      report.faults.push({ docId, error: error instanceof Error ? error.message : String(error) });
      // Counted, read after the requests a scan has not read yet, and
      // delayed, a minute for each fault to ten at most, so a request that
      // keeps faulting is not retried and logged on every pass. A fault here
      // too is reported beside the first and changes nothing else.
      try {
        await pool.query(
          `UPDATE document_rerun
              SET faults = faults + 1, checked_at = clock_timestamp(),
                  retry_after = clock_timestamp() + least(faults + 1, 10) * interval '1 minute'
            WHERE doc_id = $1`,
          [docId],
        );
      } catch (counting) {
        report.faults.push({ docId, error: counting instanceof Error ? counting.message : String(counting) });
      }
    }
  }
  return report;
}

async function settleOne(pool: Pool, docId: string, ledgerReply: boolean): Promise<Settled> {
  const [seen] = await readRerunRows(pool, { docIds: [docId] }, ledgerReply);
  if (seen === undefined || seen.status !== 'waiting') return { kind: 'gone' };
  if (seen.facts.runState === 'awaiting_approval' && rerunVerdict(seen.facts).kind === 'start') {
    const parked = await startParked(pool, seen, ledgerReply);
    if (parked !== null) return parked;
  }
  return settleUnderLocks(pool, docId, ledgerReply);
}

/** Locks the request's row, and reads it and its facts again. */
async function lockedRow(client: PoolClient, docId: string, ledgerReply: boolean): Promise<RerunRow | null> {
  await client.query("SELECT 1 FROM document_rerun WHERE doc_id = $1 AND status = 'waiting' FOR UPDATE", [docId]);
  const [row] = await readRerunRows(client, { docIds: [docId] }, ledgerReply);
  return row === undefined || row.status !== 'waiting' ? null : row;
}

/** DEC-45: the reviewer who published the document, whose request this is. */
async function authorOf(client: PoolClient, docId: string): Promise<string> {
  const { rows } = await client.query<{ written_by: string }>(
    'SELECT written_by FROM document WHERE doc_id = $1',
    [docId],
  );
  return rows[0]!.written_by;
}

/** The other waiting requests of the same run, each with its own verdict. */
interface Siblings {
  /** The ones that start with this attempt. */
  readonly starting: readonly string[];
  /** The ones that end, each by its own reason. */
  readonly ending: readonly { readonly docId: string; readonly verdict: Extract<RerunVerdict, { kind: 'failed' | 'dropped' }> }[];
}

/**
 * The other waiting requests of the same run, read under the locks and
 * judged on their own facts before the turn moves. Once it moves, every one
 * of them would read as another attempt, so each is settled here by its own
 * verdict: it starts with this attempt, or it ends by its own reason, such
 * as a failed embedding or a reply saved after its publish.
 */
async function readSiblings(client: PoolClient, row: RerunRow, ledgerReply: boolean): Promise<Siblings> {
  await client.query(
    "SELECT 1 FROM document_rerun WHERE run_id = $1 AND doc_id <> $2 AND status = 'waiting' FOR UPDATE",
    [row.runId, row.docId],
  );
  const rows = (await readRerunRows(client, { runId: row.runId }, ledgerReply))
    .filter((sibling) => sibling.docId !== row.docId && sibling.status === 'waiting');
  const starting: string[] = [];
  const ending: { docId: string; verdict: Extract<RerunVerdict, { kind: 'failed' | 'dropped' }> }[] = [];
  for (const sibling of rows) {
    const verdict = rerunVerdict(sibling.facts);
    if (verdict.kind === 'start') starting.push(sibling.docId);
    else if (verdict.kind === 'failed' || verdict.kind === 'dropped') ending.push({ docId: sibling.docId, verdict });
  }
  return { starting, ending };
}

/** Settles the siblings that end, in the transaction that starts the attempt. */
async function settleSiblings(client: PoolClient, siblings: Siblings): Promise<void> {
  for (const { docId, verdict } of siblings.ending) await settleRerun(client, docId, verdict);
}

/** Marks the requests started at the attempt the turn was raised to. */
async function markStarted(client: PoolClient, docIds: readonly string[], attempt: number): Promise<void> {
  await client.query(
    `UPDATE document_rerun
        SET status = 'started', started_attempt = $2, ended_at = clock_timestamp()
      WHERE doc_id = ANY ($1::text[]) AND status = 'waiting'`,
    [docIds, attempt],
  );
}

/**
 * A parked case: the run ends `superseded` through the fenced path, and the
 * send-back's own writes raise the turn. Null when the run is no longer
 * parked, so the caller settles it under its own locks.
 */
async function startParked(pool: Pool, seen: RerunRow, ledgerReply: boolean): Promise<Settled | null> {
  const run = await pool.query<{ cost_micros: number; steps_used: number }>(
    'SELECT cost_micros, steps_used FROM run WHERE run_id = $1',
    [seen.runId],
  );
  const totals = run.rows[0];
  if (totals === undefined) return null;
  const author = await pool.query<{ written_by: string; title: string }>(
    'SELECT written_by, title FROM document WHERE doc_id = $1',
    [seen.docId],
  );
  const document = author.rows[0];
  if (document === undefined) return null;
  let started: RerunRow | null = null;
  let siblings: Siblings = { starting: [], ending: [] };
  let moved: FencedTransitionResult;
  try {
    moved = await fencedTransition(pool, {
      runId: seen.runId,
      state: 'superseded',
      costMicros: totals.cost_micros,
      stepsUsed: totals.steps_used,
      fromState: 'awaiting_approval',
      refuseIf: async (client: PoolClient): Promise<boolean> => {
        if (seen.conversationId === null || seen.turnNumber === null) throw new NotStarting(null);
        await lockTurnAttempt(client, { conversationId: seen.conversationId, turnNumber: seen.turnNumber });
        const row = await lockedRow(client, seen.docId, ledgerReply);
        if (row === null) throw new NotStarting(null);
        const verdict = rerunVerdict(row.facts);
        if (verdict.kind !== 'start') throw new NotStarting(verdict);
        started = row;
        siblings = await readSiblings(client, row, ledgerReply);
        return false;
      },
      afterWrite: async (client: PoolClient): Promise<void> => {
        const row = started!;
        await recordSendBackIn(client, {
          runId: row.runId,
          conversationId: row.conversationId!,
          turnNumber: row.turnNumber!,
          runAttempt: row.attempt,
          note: null,
          // DEC-45: the console publishes under an identity from the roster.
          reviewer: document.written_by,
          reviewerSource: 'roster',
          document: { docId: row.docId, title: document.title },
        });
        await markStarted(client, [row.docId, ...siblings.starting], row.attempt + 1);
        await settleSiblings(client, siblings);
      },
    });
  } catch (error) {
    if (error instanceof NotStarting) return null;
    throw error;
  }
  if (moved.outcome === 'accepted') return { kind: 'started', siblings };
  return null;
}

/**
 * Every other verdict, and the start of an escalated case, in a transaction
 * of its own that takes the locks in the writers' order.
 */
async function settleUnderLocks(pool: Pool, docId: string, ledgerReply: boolean): Promise<Settled> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    try {
      const settled = await settleIn(client, docId, ledgerReply);
      await client.query('COMMIT');
      return settled;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollback) {
        broken = rollback instanceof Error ? rollback : new Error(String(rollback));
        console.error(logLine({
          event: 'rollback_failed', at: new Date().toISOString(), write: 'startPublishedReruns',
          error: errorMessage(broken),
        }));
      }
      throw error;
    }
  } finally {
    client.release(broken);
  }
}

async function settleIn(client: PoolClient, docId: string, ledgerReply: boolean): Promise<Settled> {
  const ref = await client.query<{ run_id: string; conversation_id: string | null; turn_number: number | null }>(
    "SELECT run_id, conversation_id, turn_number FROM document_rerun WHERE doc_id = $1 AND status = 'waiting'",
    [docId],
  );
  const request = ref.rows[0];
  if (request === undefined) return { kind: 'gone' };
  await client.query('SELECT 1 FROM run WHERE run_id = $1 FOR UPDATE', [request.run_id]);
  if (request.conversation_id !== null && request.turn_number !== null) {
    await lockTurnAttempt(client, { conversationId: request.conversation_id, turnNumber: request.turn_number });
  }
  const row = await lockedRow(client, docId, ledgerReply);
  if (row === null) return { kind: 'gone' };
  const verdict = rerunVerdict(row.facts);
  switch (verdict.kind) {
    case 'waiting':
      await client.query('UPDATE document_rerun SET checked_at = clock_timestamp() WHERE doc_id = $1', [docId]);
      return { kind: 'waiting' };
    case 'failed':
    case 'dropped':
      await settleRerun(client, docId, verdict);
      return verdict.kind === 'failed' ? { kind: 'failed' } : { kind: 'dropped', reason: verdict.reason };
    case 'start':
      if (row.facts.runState !== 'escalated') {
        // A parked run is started through the fenced path, and it became
        // parked since this scan first read it. The next scan takes it there.
        return { kind: 'waiting' };
      }
      // The send-back's own writes, with the run left unstamped: a saved
      // reply on the turn is cleared and journalled, the turn is raised, and
      // any hold ends. A saved reply left behind would be what the approval
      // of the new attempt sends.
      const siblings = await readSiblings(client, row, ledgerReply);
      await recordSendBackIn(client, {
        runId: row.runId,
        conversationId: row.conversationId!,
        turnNumber: row.turnNumber!,
        runAttempt: row.attempt,
        note: null,
        reviewer: await authorOf(client, docId),
        reviewerSource: 'roster',
        document: { docId, title: row.title },
        stampRun: false,
      });
      await markStarted(client, [docId, ...siblings.starting], row.attempt + 1);
      await settleSiblings(client, siblings);
      return { kind: 'started', siblings };
  }
}
