// The new attempt a published document asks for (DEC-50, DEC-49).
//
// A reviewer writes the document a case needed and publishes it. The case
// that exposed the gap should then be attempted again, with the document in
// reach, and that cannot happen before a consumer embeds it: retrieval
// ignores a document until it has a vector (DEC-21), so an attempt started
// sooner would miss the document it was started for.
//
// So publishing records a request, and a consumer's scan starts the attempt
// once the document is embedded. Between the two the case may change. A
// reviewer may approve, close or snooze it, a reply may close the turn, or
// another reviewer may send it back. Any of those drops the request, because
// a new attempt would then answer a case somebody already dealt with. A
// failed embedding never starts it.
//
// This module holds the one answer to "does it start", as a pure function of
// facts the ledger holds, and the read that gathers those facts. The scan
// acts on the answer and the case page draws it, from the same function, so
// the page never says a case waits when the scan would drop it.
import type { Pool, PoolClient } from 'pg';

import { replyDigest } from '../approval/shown.js';
import { boundedRead } from '../db/bounded-read.js';
import { runStateClass } from '../ledger/run-state.js';
import { TURN_CLOSING_STATUSES } from '../ledger/conversation.js';

/** Why a request never started. The ledger's CHECK holds the same list. */
export const RERUN_REASONS = [
  'approved',
  'closed',
  'snoozed',
  'answered',
  'another_attempt',
  'newer_turn',
  'reply_changed',
  'ended',
  'no_turn',
  'copy_could_send',
] as const;
export type RerunReason = (typeof RERUN_REASONS)[number];

/** What the ledger holds about one request's case, at one moment. */
export interface RerunFacts {
  /** The run has a conversation and a turn: a new attempt has a turn to run on. */
  readonly hasTurn: boolean;
  /** The state of the run the reviewer read when they published. */
  readonly runState: string;
  /** An approval wrote the run: `resolved` then means a person approved it. */
  readonly approved: boolean;
  readonly runAttempt: number;
  /** The attempt the turn is on, or null for a run with no turn. */
  readonly turnAttempt: number | null;
  /** A reply reached the customer on this turn, may have, or will. */
  readonly turnAnswered: boolean;
  /** The run was snoozed at or after the moment of the request. */
  readonly snoozedSinceRequest: boolean;
  /** The customer wrote again: the conversation holds a later turn. */
  readonly laterTurn: boolean;
  /**
   * DEC-46: the reply the case holds is not the reply the reviewer read when
   * they published. A person saved or rewrote it since, so a new attempt would
   * throw their work away.
   */
  readonly replyChanged: boolean;
  /**
   * The run started more than `RERUN_STALE_HOURS` ago. A run still in flight
   * that long died on its walk: nothing will move it to a person, so its
   * request cannot wait for it.
   */
  readonly stale: boolean;
  /**
   * DEC-49: a park of this attempt left a helpdesk copy a person could send:
   * a draft, where the adapter's ledger does not hold the reply. Any run of
   * the turn at the attempt counts, because a redelivered message can park a
   * twin beside the run the reviewer read.
   */
  readonly copyCouldSend: boolean;
  readonly documentStatus: 'pending' | 'embedded' | 'failed';
  /**
   * Another document published from the same run still waits for its
   * embedding. The attempt waits for it too, so one attempt reads every
   * document a reviewer wrote for the case.
   */
  readonly siblingPending: boolean;
}

export type RerunVerdict =
  /**
   * `document`: the document waits for its embedding. `case`: the run is
   * still in the system's hands, and the request waits for it to reach a
   * person.
   */
  | { readonly kind: 'waiting'; readonly on: 'document' | 'case' }
  | { readonly kind: 'start' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'dropped'; readonly reason: RerunReason };

/**
 * How long a run may stay in the system's hands before its request stops
 * waiting for it.
 *
 * Not the run's deadline: the daemon's walk reads a clock that moves with
 * it, so a live walk runs past that. What bounds a walk is its model calls,
 * each at most 120 seconds: nine classifier samples, the query embedding,
 * the composer, and one groundedness call per claim. A walk of eighty
 * claims still ends inside three hours.
 *
 * A run in flight that long died on its walk. If a later walk of its ticket
 * does move it on, the request is already dropped. The same post from the
 * case asks for it again, and the rule judges it afresh.
 */
export const RERUN_STALE_HOURS = 3;

/** The states a new attempt may replace: a case parked for a person, or escalated to one. */
const REPLACEABLE = new Set(['awaiting_approval', 'escalated']);

/**
 * Whether the request starts now, waits, failed, or is dropped, and why.
 *
 * The case is read first: a case that changed drops the request whatever the
 * embedding is doing, so the page says so at once. The order among the
 * changes puts the most specific first. An approval also closes the turn, and
 * it is named as the approval.
 */
export function rerunVerdict(facts: RerunFacts): RerunVerdict {
  const dropped = (reason: RerunReason): RerunVerdict => ({ kind: 'dropped', reason });
  if (!facts.hasTurn) return dropped('no_turn');
  // An automatic write also resolves a run, and nobody approved that.
  if (facts.runState === 'resolved') return dropped(facts.approved ? 'approved' : 'ended');
  if (facts.runState === 'closed') return dropped('closed');
  if (facts.runState === 'snoozed' || facts.snoozedSinceRequest) return dropped('snoozed');
  if (facts.turnAnswered) return dropped('answered');
  if (facts.turnAttempt !== facts.runAttempt) return dropped('another_attempt');
  // The customer wrote again, so this turn's question may no longer be the
  // one that needs an answer, and a person may be answering it now.
  if (facts.laterTurn) return dropped('newer_turn');
  if (facts.replyChanged) return dropped('reply_changed');
  if (facts.copyCouldSend) return dropped('copy_could_send');
  // A failed embedding never starts the attempt, whatever the run is doing.
  if (facts.documentStatus === 'failed') return { kind: 'failed' };
  // A run the system is still walking has not reached a person yet. It ends
  // parked, escalated or finished, and the verdict is read again then. After
  // `RERUN_STALE_HOURS` it will not, and the request ends with it.
  if (runStateClass(facts.runState) === 'in_flight') {
    return facts.stale ? dropped('ended') : { kind: 'waiting', on: 'case' };
  }
  if (!REPLACEABLE.has(facts.runState)) return dropped('ended');
  if (facts.documentStatus === 'pending' || facts.siblingPending) return { kind: 'waiting', on: 'document' };
  return { kind: 'start' };
}

/** One request, as the ledger holds it, with the facts its verdict reads. */
export interface RerunRow {
  readonly docId: string;
  readonly runId: string;
  readonly conversationId: string | null;
  readonly turnNumber: number | null;
  readonly attempt: number;
  readonly status: 'waiting' | 'started' | 'dropped' | 'failed';
  readonly reason: RerunReason | null;
  readonly requestedAt: Date;
  readonly endedAt: Date | null;
  readonly startedAttempt: number | null;
  /** The run that took the started attempt, once one did. */
  readonly startedRunId: string | null;
  /** Scans that faulted on this request. */
  readonly faults: number;
  readonly title: string;
  /** The document's own embedding error, bounded by the consumer that recorded it. */
  readonly embeddingError: string | null;
  readonly facts: RerunFacts;
}

type Db = Pool | PoolClient;

interface RerunDbRow {
  doc_id: string;
  run_id: string;
  conversation_id: string | null;
  turn_number: number | null;
  attempt: number;
  status: RerunRow['status'];
  reason: RerunReason | null;
  requested_at: Date;
  ended_at: Date | null;
  started_attempt: number | null;
  title: string;
  embedding_status: RerunFacts['documentStatus'];
  embedding_error: string | null;
  run_state: string;
  run_attempt: number;
  turn_attempt: number | null;
  answered: boolean;
  snoozed_since: boolean;
  later_turn: boolean;
  has_draft: boolean;
  shown: string | null;
  saved_digest: string | null;
  park_body: string | null;
  saved_reply: string | null;
  stale: boolean;
  approved: boolean;
  sibling_pending: boolean;
  started_run_id: string | null;
  faults: number;
}

/** The requests named, and every fact their verdict reads, in one statement. */
const RERUN_ROWS = `
    SELECT q.doc_id, q.run_id, q.conversation_id, q.turn_number, q.attempt, q.status, q.reason,
           q.requested_at, q.ended_at, q.started_attempt, q.shown, q.saved_digest, q.faults,
           r.created_at < clock_timestamp() - interval '${String(RERUN_STALE_HOURS)} hours' AS stale,
           (SELECT pb.result->>'body' FROM step_journal pb
             WHERE pb.run_id = q.run_id AND pb.step_id = 'park') AS park_body,
           NULLIF(t.saved_reply_text, '') AS saved_reply,
           d.title, d.embedding_status, d.embedding_error,
           r.state AS run_state, r.attempt AS run_attempt, r.approved_by IS NOT NULL AS approved,
           EXISTS (
             SELECT 1 FROM document_rerun sq JOIN document sd ON sd.doc_id = sq.doc_id
              WHERE sq.run_id = q.run_id AND sq.doc_id <> q.doc_id
                AND sq.status = 'waiting' AND sd.embedding_status = 'pending') AS sibling_pending,
           t.attempt AS turn_attempt,
           EXISTS (
             SELECT 1 FROM outbox o JOIN run tr ON tr.run_id = o.run_id
              WHERE tr.conversation_id = q.conversation_id
                AND tr.turn_number = q.turn_number
                AND o.status = ANY ($3::text[])) AS answered,
           -- A snooze replaces its journal row, and the row holds when it
           -- ends and for how long, so the moment it began is the one it
           -- names less its period. The row holds milliseconds, so the
           -- request's moment is read at the same precision.
           EXISTS (
             SELECT 1 FROM step_journal s
              WHERE s.run_id = q.run_id AND s.step_id = 'snooze'
                AND (s.result->>'until')::timestamptz
                    - ((s.result->>'periodMs')::bigint * interval '1 millisecond')
                    >= date_trunc('milliseconds', q.requested_at)) AS snoozed_since,
           EXISTS (
             SELECT 1 FROM turn lt
              WHERE lt.conversation_id = q.conversation_id
                AND lt.turn_number > q.turn_number) AS later_turn,
           EXISTS (
             SELECT 1 FROM step_journal p JOIN run pr ON pr.run_id = p.run_id
              WHERE p.step_id = 'park'
                AND p.result->>'draftExternalId' IS NOT NULL
                AND (pr.run_id = q.run_id
                     OR (pr.conversation_id = q.conversation_id
                         AND pr.turn_number = q.turn_number
                         AND pr.attempt = q.attempt))) AS has_draft,
           -- The run that took the attempt this request started, once one did.
           (SELECT n.run_id FROM run n
             WHERE q.status = 'started'
               AND n.conversation_id = q.conversation_id
               AND n.turn_number = q.turn_number
               AND n.attempt = q.started_attempt
             ORDER BY n.created_at, n.run_id LIMIT 1) AS started_run_id
      FROM document_rerun q
      JOIN document d ON d.doc_id = q.doc_id
      JOIN run r ON r.run_id = q.run_id
      LEFT JOIN turn t
             ON t.conversation_id = q.conversation_id AND t.turn_number = q.turn_number
     WHERE ($1::text[] IS NULL OR q.doc_id = ANY ($1::text[]))
       AND ($2::uuid IS NULL OR q.run_id = $2::uuid)
     ORDER BY q.requested_at, q.doc_id`;

function rerunParams(where: { readonly docIds?: readonly string[]; readonly runId?: string }): unknown[] {
  return [where.docIds ?? null, where.runId ?? null, [...TURN_CLOSING_STATUSES]];
}

function toRerunRow(row: RerunDbRow, ledgerReply: boolean): RerunRow {
  return {
    docId: row.doc_id,
    runId: row.run_id,
    conversationId: row.conversation_id,
    turnNumber: row.turn_number,
    attempt: row.attempt,
    status: row.status,
    reason: row.reason,
    requestedAt: row.requested_at,
    endedAt: row.ended_at,
    startedAttempt: row.started_attempt,
    startedRunId: row.started_run_id,
    faults: row.faults,
    title: row.title,
    embeddingError: row.embedding_error,
    facts: {
      hasTurn: row.conversation_id !== null && row.turn_number !== null,
      runState: row.run_state,
      approved: row.approved,
      runAttempt: row.run_attempt,
      turnAttempt: row.turn_attempt,
      turnAnswered: row.answered,
      snoozedSinceRequest: row.snoozed_since,
      laterTurn: row.later_turn,
      // Two readings, because a reply can change two ways. The page drew the
      // saved reply where the ledger holds it and the parked body otherwise,
      // as the DEC-46 guard of every other outcome reads it; only a parked
      // run carries that reply. And the turn's saved reply, whatever the run
      // is doing: a twin's reply a person saved after the publish is on the
      // turn, and a start would clear it.
      replyChanged: (row.shown !== null && row.run_state === 'awaiting_approval'
        && replyDigest((ledgerReply ? row.saved_reply : null) ?? row.park_body ?? '') !== row.shown)
        || (row.saved_reply === null ? null : replyDigest(row.saved_reply)) !== row.saved_digest,
      stale: row.stale,
      copyCouldSend: row.has_draft && !ledgerReply,
      documentStatus: row.embedding_status,
      siblingPending: row.sibling_pending,
    },
  };
}

/**
 * The requests named, with every fact their verdict reads.
 *
 * `ledgerReply` is the adapter's declaration (DEC-44): where the ledger holds
 * the reply, a parked draft is a copy nobody can send.
 */
export async function readRerunRows(
  db: Db,
  where: { readonly docIds?: readonly string[]; readonly runId?: string },
  ledgerReply: boolean,
): Promise<RerunRow[]> {
  const { rows } = await db.query<RerunDbRow>(RERUN_ROWS, rerunParams(where));
  return rows.map((row) => toRerunRow(row, ledgerReply));
}

/** A request as the case page draws it. */
export interface CaseRerun {
  readonly docId: string;
  readonly title: string;
  /**
   * `starting`: the document is embedded and the case unchanged, so the next
   * consumer scan starts the attempt. The other states are the request's own,
   * or the verdict a waiting request will be settled with.
   */
  readonly state:
    | { readonly kind: 'waiting'; readonly on: 'document' | 'case' }
    | { readonly kind: 'starting'; readonly faults: number }
    | { readonly kind: 'started'; readonly attempt: number; readonly runId: string | null }
    | { readonly kind: 'failed'; readonly error: string | null }
    | { readonly kind: 'dropped'; readonly reason: RerunReason };
}

/** How long the case page's read of its requests may run. */
export const CASE_RERUN_TIMEOUT_MS = 2_000;

/**
 * The requests published from this run, as the case page draws them.
 *
 * A waiting request is drawn with the verdict `rerunVerdict` gives it now, so
 * the page says a case will not start as soon as the scan would drop it.
 */
export async function readCaseReruns(
  pool: Pool,
  runId: string,
  ledgerReply: boolean,
  timeoutMs: number = CASE_RERUN_TIMEOUT_MS,
  clientTimeoutMs: number = timeoutMs + 1_000,
): Promise<CaseRerun[]> {
  const rows = await boundedRead(pool, 'readCaseReruns', timeoutMs, clientTimeoutMs, (query) =>
    query<RerunDbRow>(RERUN_ROWS, rerunParams({ runId })));
  return rows.map((row) => caseRerunOf(toRerunRow(row, ledgerReply)));
}

export function caseRerunOf(row: RerunRow): CaseRerun {
  const base = { docId: row.docId, title: row.title };
  switch (row.status) {
    case 'started':
      return { ...base, state: { kind: 'started', attempt: row.startedAttempt ?? row.attempt + 1, runId: row.startedRunId } };
    case 'failed':
      return { ...base, state: { kind: 'failed', error: row.embeddingError } };
    case 'dropped':
      return { ...base, state: { kind: 'dropped', reason: row.reason ?? 'ended' } };
    case 'waiting': {
      const verdict = rerunVerdict(row.facts);
      if (verdict.kind === 'start') return { ...base, state: { kind: 'starting', faults: row.faults } };
      if (verdict.kind === 'failed') return { ...base, state: { kind: 'failed', error: row.embeddingError } };
      if (verdict.kind === 'dropped') return { ...base, state: { kind: 'dropped', reason: verdict.reason } };
      return { ...base, state: { kind: 'waiting', on: verdict.on } };
    }
  }
}

/**
 * Records a verdict that ends a waiting request, and answers whether it did.
 *
 * Only a waiting row moves, so a second writer that lost the race changes
 * nothing. `start` is not written here: starting an attempt raises the turn
 * and belongs to the transaction that does it.
 */
export async function settleRerun(
  client: PoolClient,
  docId: string,
  verdict: Extract<RerunVerdict, { kind: 'failed' | 'dropped' }>,
): Promise<boolean> {
  const moved = await client.query(
    `UPDATE document_rerun
        SET status = $2, reason = $3, ended_at = clock_timestamp()
      WHERE doc_id = $1 AND status = 'waiting'`,
    [docId, verdict.kind, verdict.kind === 'dropped' ? verdict.reason : null],
  );
  return (moved.rowCount ?? 0) > 0;
}
