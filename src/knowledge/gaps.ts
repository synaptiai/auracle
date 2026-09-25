// Cases blocked by a gap, and the knowledge screen's figures (issue #111).
//
// DEC-50, as the ratified proposal words it: the case page and the
// knowledge screen count the cases a gap blocked the same way.
// So both read through `casesSql` and `gapOf` here, and neither keeps a
// definition of its own.
//
// A case is a turn, or a run that recorded no turn. Its attempt of record is
// its latest run that reached a person and composed: it parked for approval
// or escalated, and it recorded a draft or an abstention. A run that composed
// nothing says nothing about the knowledge base, so it cannot hide an earlier
// gap. That run's journal decides whether the case is blocked: the composer
// abstained, or the gate refused a claim.
//
// "Reached a person" here counts an escalation. The queue header's count does
// not, because it counts what reached the queue, and an escalation does not.
import type { Pool } from 'pg';

import { boundedRead, type BoundedQuery } from '../db/bounded-read.js';
import {
  gateVerdictsOf,
  isObject,
  snapshotOf,
  toComposeRecord,
  verdictAt,
  type ClaimVerdict,
  type ComposeRecord,
  type DocumentSnapshot,
} from '../journal/query.js';

/** The window the gap ranking and the two team cards count over. */
export const GAP_WINDOW_DAYS = 14;

/** A page read, so it should not wait on the ledger. */
export const KNOWLEDGE_TIMEOUT_MS = 2_000;

/** The most documents the screen lists as needing a person. */
export const NEEDS_A_PERSON_LIMIT = 50;

const DAY_MS = 86_400_000;

/** A run id the ledger can be asked about. The column is `uuid`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why a case is blocked by a gap. */
export type Gap =
  /** No document could support an answer, so the composer drafted none. */
  | { readonly kind: 'abstained' }
  /**
   * The gate refused a claim, because its cited document does not say it.
   * `docIds` are the refused claims' documents, once each, in claim order.
   * Never empty: a refusal counts only on a claim the journal holds.
   */
  | { readonly kind: 'unsupported'; readonly docIds: readonly string[] };

/** One journal row, as the case query returns it. */
interface RowIn {
  readonly status: string;
  readonly result: unknown;
}

/** What the journal of one attempt of record says, read as the run page reads it. */
export interface CaseReading {
  /** The classifier's intent, or null when no finished classify row names one. */
  readonly intentId: string | null;
  /** The compose outcome, or null when no row recorded a readable one. */
  readonly compose: ComposeRecord | null;
  /** The gate's per-claim verdicts, or null when they are unread. */
  readonly verdicts: readonly ClaimVerdict[] | null;
  /** What the retrieve row recorded about each document, or null when nothing. */
  readonly snapshot: Readonly<Record<string, DocumentSnapshot>> | null;
  /**
   * The journal does not say whether a gap blocks the case: the compose row
   * could not be read, or the reply drafted and its claims, or the verdict of
   * one of them, could not be. A case with a readable refusal is blocked
   * whatever else is unread; this matters for the ones that are not.
   */
  readonly unread: boolean;
}

/**
 * Reads the rows of one attempt through the run page's own parsers.
 *
 * A row only counts when it finished, as `readRunJournal` reads it. The
 * compose row is the exception there too: an abstain is a determination.
 */
export function caseFromRows(rows: {
  readonly compose?: RowIn | null;
  readonly gate?: RowIn | null;
  readonly classify?: { readonly status: string; readonly intent: unknown } | null;
  readonly retrieve?: {
    readonly status: string;
    readonly docIds: unknown;
    readonly documents: unknown;
  } | null;
}): CaseReading {
  const object = (value: unknown): Record<string, unknown> | null => (isObject(value) ? value : null);
  const compose = rows.compose ? toComposeRecord(rows.compose.status, object(rows.compose.result)) : null;
  const verdicts = rows.gate?.status === 'done' ? gateVerdictsOf(object(rows.gate.result)) : null;
  const intent = rows.classify?.status === 'done' ? rows.classify.intent : null;
  // As `readRunJournal` reads it: a retrieval whose id list is not all
  // strings is malformed there, and its snapshot is not read.
  const ids = rows.retrieve?.docIds;
  const snapshot =
    rows.retrieve?.status === 'done' && Array.isArray(ids) && ids.every((id) => typeof id === 'string')
      ? snapshotOf({ documents: rows.retrieve.documents })
      : null;
  return {
    intentId: typeof intent === 'string' ? intent : null,
    compose,
    verdicts,
    snapshot,
    unread: compose === null
      || (!compose.abstained
        && (compose.claims === null || compose.claims.some((_, index) => verdictAt(verdicts, index) === null))),
  };
}

/**
 * Whether a case is blocked by a gap, and why. Null when it is not.
 *
 * A refusal counts only on a claim the case page draws as refused on the
 * draft: a claim the journal holds readably, with one verdict, and that
 * verdict false. So an unread verdict list, an unread claim list, a verdict
 * for no claim and two verdicts for one claim block nothing, as the page
 * shows none of them as a refusal.
 *
 * A reply a person rewrote is the exception the page makes (DEC-48): it draws
 * no verdict on a reply the customer will not receive. The gap still counts,
 * because a person had to write the answer the documents could not support.
 */
export function gapOf(reading: CaseReading): Gap | null {
  if (reading.compose?.abstained === true) return { kind: 'abstained' };
  const claims = reading.compose?.claims ?? [];
  const docIds: string[] = [];
  claims.forEach((claim, index) => {
    if (verdictAt(reading.verdicts, index) === false && !docIds.includes(claim.docId)) {
      docIds.push(claim.docId);
    }
  });
  return docIds.length === 0 ? null : { kind: 'unsupported', docIds };
}

/** The documents the case's claims cite, once each. Empty when the claims are unread. */
function citedBy(reading: CaseReading): string[] {
  const cited: string[] = [];
  for (const claim of reading.compose?.claims ?? []) {
    if (!cited.includes(claim.docId)) cited.push(claim.docId);
  }
  return cited;
}

/** The documents the case's supported claims cite. Empty when the verdicts are unread. */
function supportedBy(reading: CaseReading): string[] {
  const supported: string[] = [];
  (reading.compose?.claims ?? []).forEach((claim, index) => {
    if (verdictAt(reading.verdicts, index) === true && !supported.includes(claim.docId)) {
      supported.push(claim.docId);
    }
  });
  return supported;
}

/**
 * Whether a document changed since the cases that cite it read it.
 *
 * Four answers. `not_compared` is its own answer: a case that recorded no hash
 * says nothing about the body, and reading it as unchanged would be the
 * flattering guess. One case that recorded another body is enough for
 * `changed`, since that comparison did answer.
 */
export type ChangeFlag = 'not_cited' | 'unchanged' | 'changed' | 'not_compared';

export function changeFlag(digest: string, recorded: readonly (string | undefined)[]): ChangeFlag {
  if (recorded.length === 0) return 'not_cited';
  if (recorded.some((hash) => hash !== undefined && hash !== digest)) return 'changed';
  if (recorded.every((hash) => hash === digest)) return 'unchanged';
  return 'not_compared';
}

/**
 * The runs of the cases `scope` selects that reached a person and composed,
 * each ranked within its case, with the rows that decide them.
 *
 * `scope` is a condition on the run `r`. It must select every run of each
 * case it selects, so the attempt of record is chosen over the whole case.
 * `rank` 1 is the attempt of record. `rowFilter`, a condition on the ranked
 * run `rec`, keeps the rows the caller wants. Ranking before filtering is
 * what lets the case page and the screen agree: a window that filtered first
 * would pick an earlier attempt than the case page does.
 *
 * The order decides the attempt of record: the highest attempt, then the
 * latest start, then the run id, so two runs that share an attempt still
 * give one answer. The compose row drops its cited bodies, which the gap
 * does not read and which carry whole documents.
 */
function casesSql(scope: string, rowFilter: string): string {
  return `
    WITH reached AS (
      SELECT r.run_id, r.attempt, r.created_at, r.product,
             CASE WHEN r.conversation_id IS NULL OR r.turn_number IS NULL
                  THEN 'run:' || r.run_id::text
                  ELSE r.conversation_id::text || ':' || r.turn_number::text
             END AS case_key
        FROM run r
       WHERE (${scope})
         AND (r.state = 'escalated'
              OR EXISTS (SELECT 1 FROM step_journal p
                          WHERE p.run_id = r.run_id AND p.step_id = 'park'
                            AND p.status = 'done'))
         AND EXISTS (SELECT 1 FROM step_journal d
                      WHERE d.run_id = r.run_id AND d.step_id = 'compose'
                        AND d.status IN ('done', 'abstained'))
    ),
    ranked AS (
      SELECT reached.*,
             row_number() OVER (PARTITION BY case_key
                                ORDER BY attempt DESC, created_at DESC, run_id DESC) AS rank
        FROM reached
    )
    SELECT rec.case_key, rec.run_id::text AS run_id, rec.attempt, rec.product,
           rec.rank = 1 AS is_record,
           rec.created_at >= $1::timestamptz AND rec.created_at < $2::timestamptz AS counted,
           c.status AS compose_status,
           CASE WHEN jsonb_typeof(c.result) = 'object' THEN c.result - 'citedBodies'
                ELSE c.result END AS compose_result,
           g.status AS gate_status, g.result AS gate_result,
           k.status AS classify_status, k.result -> 'intentId' AS intent,
           t.status AS retrieve_status, t.result -> 'docIds' AS retrieved_ids,
           t.result -> 'documents' AS retrieved
      FROM ranked rec
      LEFT JOIN step_journal c ON c.run_id = rec.run_id AND c.step_id = 'compose'
      LEFT JOIN step_journal g ON g.run_id = rec.run_id AND g.step_id = 'gate'
      LEFT JOIN step_journal k ON k.run_id = rec.run_id AND k.step_id = 'classify'
      LEFT JOIN step_journal t ON t.run_id = rec.run_id AND t.step_id = 'retrieve'
     WHERE ${rowFilter}
     ORDER BY rec.created_at DESC, rec.run_id DESC`;
}

interface CaseRow {
  readonly case_key: string;
  readonly run_id: string;
  readonly attempt: number;
  readonly product: string | null;
  readonly is_record: boolean;
  readonly counted: boolean;
  readonly compose_status: string | null;
  readonly compose_result: unknown;
  readonly gate_status: string | null;
  readonly gate_result: unknown;
  readonly classify_status: string | null;
  readonly intent: unknown;
  readonly retrieve_status: string | null;
  readonly retrieved_ids: unknown;
  readonly retrieved: unknown;
}

function readingOf(row: CaseRow): CaseReading {
  return caseFromRows({
    compose: row.compose_status === null ? null : { status: row.compose_status, result: row.compose_result },
    gate: row.gate_status === null ? null : { status: row.gate_status, result: row.gate_result },
    classify: row.classify_status === null ? null : { status: row.classify_status, intent: row.intent },
    retrieve:
      row.retrieve_status === null
        ? null
        : { status: row.retrieve_status, docIds: row.retrieved_ids, documents: row.retrieved },
  });
}

/** The gap of one case, as the case page shows it. */
export interface CaseGap {
  /** The attempt of record: the case's latest run that reached a person and composed. */
  readonly runId: string;
  readonly attempt: number;
  /** Why the case is blocked, or null when it is not. */
  readonly gap: Gap | null;
  /**
   * Whether the knowledge screen counts the case now: its attempt of record
   * started inside the gap window before `now`.
   */
  readonly counted: boolean;
  /**
   * The journal does not say whether a gap blocks the case. Within the gap
   * window, the screen leaves it out of its count and names it among the
   * cases it cannot read. Never true beside a gap: a readable refusal blocks
   * the case.
   */
  readonly unread: boolean;
}

/**
 * The gap of the case that `runId` belongs to, or null when no run of that
 * case reached a person and composed (or no run has that id).
 *
 * The case, not the run. A page for an earlier attempt answers for the
 * attempt of record, so it never contradicts the knowledge screen. The
 * window does not decide what a case is. It decides only `counted`, which
 * says whether the screen's count holds the case now.
 *
 * The match is written as two conditions the run indexes answer, the primary
 * key and the turn index, so a case page reads the runs of one case and not
 * the table.
 *
 * Read-only. Safe against a live database.
 */
export async function readCaseGap(
  pool: Pool,
  runId: string,
  now: Date = new Date(),
  timeoutMs: number = KNOWLEDGE_TIMEOUT_MS,
  clientTimeoutMs: number = timeoutMs + 1_000,
): Promise<CaseGap | null> {
  if (!UUID.test(runId)) return null;
  const [from, to] = windowOf(now);
  const rows = await boundedRead(pool, 'readCaseGap', timeoutMs, clientTimeoutMs, (query) =>
    query<CaseRow>(
      casesSql(
        `(r.run_id = $3::uuid AND (r.conversation_id IS NULL OR r.turn_number IS NULL))
         OR (r.conversation_id, r.turn_number) =
            (SELECT target.conversation_id, target.turn_number
               FROM run target WHERE target.run_id = $3::uuid)`,
        'rec.rank = 1',
      ),
      [from.toISOString(), to.toISOString(), runId],
    ));
  const row = rows[0];
  if (row === undefined) return null;
  const reading = readingOf(row);
  const gap = gapOf(reading);
  return { runId: row.run_id, attempt: row.attempt, gap, counted: row.counted, unread: gap === null && reading.unread };
}

/** The gap window before `now`: `from` inclusive, `to` exclusive. */
function windowOf(now: Date): [Date, Date] {
  return [new Date(now.getTime() - GAP_WINDOW_DAYS * DAY_MS), now];
}

/** One document the gate refused a claim on, within one gap group. */
export interface RefusedDocument {
  readonly docId: string;
  /** Today's title, or null when no document has the id today. */
  readonly title: string | null;
  /** Blocked cases of the group that refused a claim on it. */
  readonly cases: number;
}

/** The blocked cases of one intent and one product. */
export interface GapGroup {
  /** Null when the attempt recorded no intent. */
  readonly intentId: string | null;
  /** Null when the case's channel maps no product. */
  readonly product: string | null;
  readonly cases: number;
  /** Of `cases`, those where the composer abstained. */
  readonly abstained: number;
  /** The documents the gate refused claims on, most cases first. */
  readonly refused: readonly RefusedDocument[];
  /** The attempts of record, latest first. */
  readonly runIds: readonly string[];
}

/** A document that needs a person, and why. */
export interface DocumentNeed {
  readonly docId: string;
  readonly title: string;
  readonly owner: string;
  readonly products: readonly string[];
  /** DEC-23: the review date, as `YYYY-MM-DD`. */
  readonly reviewBy: string;
  /** The review date has passed, so retrieval no longer reads it. */
  readonly pastReview: boolean;
  /** Why its embedding failed, or null when it did not fail. */
  readonly embeddingFailed: string | null;
  /** Cases in the window where a person saw a claim on it refused, in any attempt. */
  readonly refusedCases: number;
  /** Cases in the window where an attempt a person saw cites it in a claim. */
  readonly citations: number;
  readonly flag: ChangeFlag;
}

/** Everything the knowledge screen shows, from one snapshot of the ledger. */
export interface KnowledgeReport {
  /** The window, as ISO instants: `from` inclusive, `to` exclusive. */
  readonly from: string;
  readonly to: string;
  /** Card 1: cases in the window blocked by a gap. */
  readonly blockedCases: number;
  /**
   * Cases in the window whose journal does not say whether a gap blocks
   * them. Card 1 does not count them, so it is a floor when this is above 0.
   */
  readonly unreadCases: number;
  /** Card 2: documents past their review date, today. */
  readonly pastReview: number;
  /** Card 3: documents the team wrote in the console within the window. */
  readonly teamDocuments: number;
  /** Card 4: cases in the window a card-3 document answers. */
  readonly answeredByTeam: number;
  /** The gaps, most blocked cases first. */
  readonly gaps: readonly GapGroup[];
  /** The documents that need a person, at most `NEEDS_A_PERSON_LIMIT`. */
  readonly documents: readonly DocumentNeed[];
  /** How many documents need a person, before the limit. */
  readonly documentsNeedingAPerson: number;
}

interface DocumentRow {
  readonly doc_id: string;
  readonly title: string;
  readonly owner: string;
  readonly products: string[];
  readonly review_by: string;
  readonly past_review: boolean;
  readonly embedding_status: string;
  readonly embedding_error: string | null;
}

/**
 * The knowledge screen's figures, over the `GAP_WINDOW_DAYS` before `now`.
 *
 * One read-only transaction, so the cards and the lists describe one
 * snapshot. The window is half-open on the start of the attempt of record.
 * "Past review" is `review_by < CURRENT_DATE`, the exact complement of the
 * filter the retriever reads, so a document is on one side of it and never
 * both. That date is the database's, as the retriever's is.
 *
 * Read-only. Safe against a live database.
 */
export async function readKnowledge(
  pool: Pool,
  now: Date = new Date(),
  timeoutMs: number = KNOWLEDGE_TIMEOUT_MS,
  clientTimeoutMs: number = timeoutMs + 1_000,
): Promise<KnowledgeReport> {
  const [from, to] = windowOf(now);
  return boundedRead(pool, 'readKnowledge', timeoutMs, clientTimeoutMs, (query) =>
    knowledgeIn(query, from, to));
}

async function knowledgeIn(query: BoundedQuery, from: Date, to: Date): Promise<KnowledgeReport> {
  const window = [from.toISOString(), to.toISOString()];
  // Every run of each case that has a run in the window, so the attempt of
  // record is chosen over the whole case. Then only the records that started
  // inside the window count.
  //
  // Written as a union of two index reads, the window on `created_at` and the
  // cases' turns on `(conversation_id, turn_number)`, so the page reads the
  // runs of the window's cases and not the whole table. Every row returned
  // started in the window. The attempts of record among them are the cases;
  // the others are earlier attempts a person saw, which the document list
  // reads for refusals.
  const rows = await query<CaseRow>(
    casesSql(
      `r.run_id IN (
         SELECT w.run_id FROM run w
          WHERE w.created_at >= $1::timestamptz AND w.created_at < $2::timestamptz
            AND (w.conversation_id IS NULL OR w.turn_number IS NULL)
         UNION ALL
         SELECT o.run_id FROM run o
           JOIN (SELECT DISTINCT w.conversation_id, w.turn_number FROM run w
                  WHERE w.created_at >= $1::timestamptz AND w.created_at < $2::timestamptz
                    AND w.conversation_id IS NOT NULL AND w.turn_number IS NOT NULL) k
             ON o.conversation_id = k.conversation_id AND o.turn_number = k.turn_number)`,
      'rec.created_at >= $1::timestamptz AND rec.created_at < $2::timestamptz',
    ),
    window,
  );
  const seen = rows.map((row) => ({ row, reading: readingOf(row) }));
  const cases = seen
    .filter(({ row }) => row.is_record)
    .map(({ row, reading }) => ({ row, reading, gap: gapOf(reading) }));

  const teamIds = new Set(
    (await query<{ doc_id: string }>(
      `SELECT doc_id FROM document
        WHERE source = 'console'
          AND created_at >= $1::timestamptz AND created_at < $2::timestamptz`,
      window,
    )).map((row) => row.doc_id),
  );
  const pastReview = Number((await query<{ n: string }>(
    'SELECT count(*) AS n FROM document WHERE review_by < CURRENT_DATE',
  ))[0]!.n);

  // Card 4 reads only cases that are not blocked and fully read, so no case
  // counts as answered and as blocked or unread.
  const answeredByTeam = cases.filter(
    ({ reading, gap }) => gap === null && !reading.unread
      && supportedBy(reading).some((docId) => teamIds.has(docId)),
  ).length;

  // Refusals a person saw in the window, from every attempt that reached
  // one, counted once per case. An attempt a reviewer sent back still showed
  // its refusal, so its document still needs a person.
  const refusedIn = new Map<string, Set<string>>();
  for (const { row, reading } of seen) {
    const gap = gapOf(reading);
    if (gap?.kind !== 'unsupported') continue;
    for (const docId of gap.docIds) {
      const cases = refusedIn.get(docId);
      if (cases === undefined) refusedIn.set(docId, new Set([row.case_key]));
      else cases.add(row.case_key);
    }
  }
  const refusedCount = new Map([...refusedIn].map(([docId, keys]) => [docId, keys.size]));

  const documentRows = await query<DocumentRow>(
    `SELECT doc_id, title, owner, products,
            to_char(review_by, 'YYYY-MM-DD') AS review_by,
            review_by < CURRENT_DATE AS past_review,
            embedding_status, embedding_error
       FROM document
      WHERE review_by < CURRENT_DATE
         OR embedding_status = 'failed'
         OR doc_id = ANY($1::text[])`,
    [[...refusedCount.keys()]],
  );
  const titles = new Map(documentRows.map((row) => [row.doc_id, row.title]));

  // Each document's citations, over the attempts the refusals come from:
  // every attempt a person saw in the window. A case counts once, and each of
  // its citing attempts gives the flag the hash it recorded. A refusal is a
  // citation too, so a refused document is never "not cited".
  const citingOf = new Map<string, { cases: Set<string>; readings: CaseReading[] }>();
  for (const { row, reading } of seen) {
    for (const docId of citedBy(reading)) {
      const entry = citingOf.get(docId);
      if (entry === undefined) citingOf.set(docId, { cases: new Set([row.case_key]), readings: [reading] });
      else {
        entry.cases.add(row.case_key);
        entry.readings.push(reading);
      }
    }
  }

  const ranked = documentRows.map((row) => ({ row, refused: refusedCount.get(row.doc_id) ?? 0 }));
  // Refusals first, since a person reading them clears cases. Then failed
  // embeddings, which retrieval cannot read at all. Then the oldest review.
  ranked.sort((a, b) =>
    b.refused - a.refused
    || Number(b.row.embedding_status === 'failed') - Number(a.row.embedding_status === 'failed')
    || a.row.review_by.localeCompare(b.row.review_by)
    || a.row.doc_id.localeCompare(b.row.doc_id));
  const listed = ranked.slice(0, NEEDS_A_PERSON_LIMIT);

  // Digested for the listed documents alone, so a large backlog past review
  // costs no hash of each body. The same digest `readRunJournal` compares.
  const digests = new Map((await query<{ doc_id: string; body_digest: string }>(
    `SELECT doc_id, encode(sha256(convert_to(body, 'UTF8')), 'hex') AS body_digest
       FROM document WHERE doc_id = ANY($1::text[])`,
    [listed.map(({ row }) => row.doc_id)],
  )).map((row) => [row.doc_id, row.body_digest]));

  const needs = listed.map(({ row, refused }): DocumentNeed => {
    const citing = citingOf.get(row.doc_id)?.readings ?? [];
    // One transaction's snapshot holds every listed row, so each has a
    // digest. A row without one would be not compared, never unchanged.
    const digest = digests.get(row.doc_id);
    return {
      docId: row.doc_id,
      title: row.title,
      owner: row.owner,
      products: row.products,
      reviewBy: row.review_by,
      pastReview: row.past_review,
      embeddingFailed: row.embedding_status === 'failed' ? (row.embedding_error ?? '') : null,
      refusedCases: refused,
      citations: citingOf.get(row.doc_id)?.cases.size ?? 0,
      flag: changeFlag(
        digest ?? '',
        citing.map((reading) => (digest === undefined ? undefined : reading.snapshot?.[row.doc_id]?.bodyHash)),
      ),
    };
  });

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    blockedCases: cases.filter(({ gap }) => gap !== null).length,
    unreadCases: cases.filter(({ gap, reading }) => gap === null && reading.unread).length,
    pastReview,
    teamDocuments: teamIds.size,
    answeredByTeam,
    gaps: groupGaps(cases, titles),
    documents: needs,
    documentsNeedingAPerson: documentRows.length,
  };
}

/** The blocked cases, grouped by intent and product, most cases first. */
function groupGaps(
  cases: readonly { readonly row: CaseRow; readonly reading: CaseReading; readonly gap: Gap | null }[],
  titles: ReadonlyMap<string, string>,
): GapGroup[] {
  const groups = new Map<string, {
    intentId: string | null; product: string | null; abstained: number;
    refused: Map<string, number>; runIds: string[];
  }>();
  for (const { row, reading, gap } of cases) {
    if (gap === null) continue;
    // An empty product is no product. The column has no CHECK, and the page
    // draws both as "no product", so two groups would carry one label.
    const product = row.product === '' ? null : row.product;
    const key = JSON.stringify([reading.intentId, product]);
    let group = groups.get(key);
    if (group === undefined) {
      group = { intentId: reading.intentId, product, abstained: 0, refused: new Map(), runIds: [] };
      groups.set(key, group);
    }
    // The rows arrive latest first, so the list keeps that order.
    group.runIds.push(row.run_id);
    if (gap.kind === 'abstained') group.abstained += 1;
    else for (const docId of gap.docIds) group.refused.set(docId, (group.refused.get(docId) ?? 0) + 1);
  }
  // A named value sorts before an absent one, so "no intent recorded" ends a tie.
  const named = (a: string | null, b: string | null): number =>
    a === null ? (b === null ? 0 : 1) : b === null ? -1 : a.localeCompare(b);
  return [...groups.values()]
    .map((group): GapGroup => ({
      intentId: group.intentId,
      product: group.product,
      cases: group.runIds.length,
      abstained: group.abstained,
      refused: [...group.refused.entries()]
        .map(([docId, n]) => ({ docId, title: titles.get(docId) ?? null, cases: n }))
        .sort((a, b) => b.cases - a.cases || a.docId.localeCompare(b.docId)),
      runIds: group.runIds,
    }))
    .sort((a, b) =>
      b.cases - a.cases
      || named(a.intentId, b.intentId)
      || named(a.product, b.product));
}
