// The cases a gap blocked, and the knowledge screen's figures (issue #111).
//
// Every row here is synthetic (DEC-18). Each case seeds a turn, one or more
// runs of it, and the journal rows the gap reads, then asks the ledger.
import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl, readerDbUrl } from '../db/config.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { fencedInsert } from '../ledger/insert.js';
import { readRunJournal, verdictAt } from '../journal/query.js';
import { truncateLedger } from '../test-support/schema.js';
import {
  GAP_WINDOW_DAYS, NEEDS_A_PERSON_LIMIT, readCaseGap, readKnowledge, type KnowledgeReport,
} from './gaps.js';

const pool = new Pool({ connectionString: dbUrl() });
// The readers connect as the role that cannot act beyond a read (issue #153).
const readers = new Pool({ connectionString: readerDbUrl(), max: 4 });
await pool.query('SELECT 1');

const NOW = new Date('2026-09-20T12:00:00Z');
const DAY = 86_400_000;
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * DAY);

interface Turn {
  readonly conversationId: string | null;
  readonly turnNumber: number | null;
  readonly ticketId: string;
}

let epoch = 1n;

async function arrive(): Promise<Turn> {
  const ticketId = 'T-' + randomUUID().slice(0, 8);
  const result = await enqueueTicket(
    pool,
    { ticketId, messageId: randomUUID(), ticketText: 'a synthetic question' },
    4,
  );
  return { conversationId: result.conversationId, turnNumber: result.turnNumber, ticketId };
}

/** A run with no turn: its own case. */
function turnless(): Turn {
  return { conversationId: null, turnNumber: null, ticketId: 'T-' + randomUUID().slice(0, 8) };
}

interface RunSpec {
  readonly state: string;
  readonly attempt?: number;
  readonly product?: string | null;
  readonly createdAt?: Date;
  readonly parked?: boolean;
}

async function runOf(turn: Turn, spec: RunSpec): Promise<string> {
  const runId = randomUUID();
  epoch += 1n;
  const inserted = await fencedInsert(
    pool,
    {
      runId,
      ticketId: turn.ticketId,
      partition: 0,
      epoch,
      state: spec.state,
      promptVer: 'p1',
      modelVer: 'm1',
      ...(turn.conversationId === null ? {} : { conversationId: turn.conversationId }),
      ...(turn.turnNumber === null ? {} : { turnNumber: turn.turnNumber }),
      attempt: spec.attempt ?? 1,
      product: spec.product ?? null,
      deadlineAt: new Date(NOW.getTime() + 60_000),
    },
    null,
  );
  expect(inserted).toEqual({ outcome: 'accepted' });
  await pool.query('UPDATE run SET created_at = $2 WHERE run_id = $1', [runId, spec.createdAt ?? daysAgo(1)]);
  if (spec.parked === true) {
    await journal(runId, 'park', 'done', { actionClass: 'customer_reply', delivery: 'at_most_once' });
  }
  return runId;
}

async function journal(runId: string, stepId: string, status: string, result: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
     VALUES ($1, $2, $3, $4, 'gaps-test-prompt', 'gaps-test-model', 0)`,
    [runId, stepId, status, JSON.stringify(result)],
  );
}

async function classified(runId: string, intentId: string): Promise<void> {
  await journal(runId, 'classify', 'done', { intentId, agreement: 1 });
}

async function abstained(runId: string): Promise<void> {
  await journal(runId, 'compose', 'abstained', { abstained: true, claimCount: 0, sentences: [] });
}

/**
 * The composer cited each document once in claim order, the gate judged each
 * claim, and the retriever recorded each body's hash (or none, for `unhashed`).
 */
async function answered(
  runId: string,
  claims: readonly { readonly docId: string; readonly supported: boolean | string }[],
  hashes: Readonly<Record<string, string | undefined>> = {},
): Promise<void> {
  const ids = [...new Set(claims.map((c) => c.docId))];
  await journal(runId, 'retrieve', 'done', {
    docIds: ids,
    documents: ids.map((docId) => ({
      docId, title: docId, owner: 'kb-team', reviewBy: '2026-12-31',
      ...(hashes[docId] === undefined ? {} : { bodyHash: hashes[docId] }),
    })),
  });
  await journal(runId, 'compose', 'done', {
    abstained: false,
    claimCount: claims.length,
    sentences: [
      { text: 'Thanks for writing in.', docId: null },
      ...claims.map((c, i) => ({ text: `Claim ${i}.`, docId: c.docId })),
    ],
    citedBodies: Object.fromEntries(ids.map((id) => [id, 'a cited body'])),
  });
  await journal(runId, 'gate', 'done', {
    groundedness: 0.5,
    decision: 'gated',
    claimVerdicts: claims.map((c, claimIndex) => ({ claimIndex, supported: c.supported })),
  });
}

interface DocSpec {
  readonly body?: string;
  readonly reviewOffsetDays?: number;
  readonly source?: 'loader' | 'console';
  readonly createdAt?: Date;
  readonly failed?: string;
  readonly products?: readonly string[];
}

async function documentOf(docId: string, spec: DocSpec = {}): Promise<string> {
  const body = spec.body ?? `The synthetic body of ${docId}.`;
  await pool.query(
    `INSERT INTO document (doc_id, kind, title, body, owner, review_by, products, source,
                           embedding_status, embedding_error, created_at, written_by)
     VALUES ($1, 'document', $2, $3, 'kb-team', CURRENT_DATE + $4::integer, $5, $6, $7, $8, $9,
             CASE WHEN $6 = 'console' THEN 'synthetic-reviewer' END)`,
    [
      docId, `Title of ${docId}`, body, spec.reviewOffsetDays ?? 30, spec.products ?? ['plan-basic'],
      spec.source ?? 'loader', spec.failed === undefined ? 'pending' : 'failed', spec.failed ?? null,
      spec.createdAt ?? daysAgo(40),
    ],
  );
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

const knowledge = (): Promise<KnowledgeReport> => readKnowledge(readers, NOW);

afterAll(async () => {
  await readers.end();
  await pool.end();
});

describe('the cases a gap blocked', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  it('counts an escalated abstention as a gap with no document', async () => {
    const runId = await runOf(await arrive(), { state: 'escalated', product: 'plan-basic' });
    await classified(runId, 'refund_request');
    await abstained(runId);
    const report = await knowledge();
    expect(report.blockedCases).toBe(1);
    expect(report.gaps).toEqual([
      { intentId: 'refund_request', product: 'plan-basic', cases: 1, abstained: 1, refused: [], runIds: [runId] },
    ]);
  });

  it('names the document of the refused claim, with its title today', async () => {
    await documentOf('DOC-A');
    await documentOf('DOC-B');
    const runId = await runOf(await arrive(), { state: 'awaiting_approval', parked: true, product: 'plan-basic' });
    await classified(runId, 'billing_question');
    await answered(runId, [{ docId: 'DOC-A', supported: true }, { docId: 'DOC-B', supported: false }]);
    const report = await knowledge();
    expect(report.gaps).toEqual([{
      intentId: 'billing_question', product: 'plan-basic', cases: 1, abstained: 0,
      refused: [{ docId: 'DOC-B', title: 'Title of DOC-B', cases: 1 }], runIds: [runId],
    }]);
  });

  it('names a refused document that no row holds today with no title', async () => {
    const runId = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(runId, [{ docId: 'DOC-GONE', supported: false }]);
    const [group] = (await knowledge()).gaps;
    expect(group!.refused).toEqual([{ docId: 'DOC-GONE', title: null, cases: 1 }]);
  });

  it('does not count a malformed verdict list, whose refusal the case page does not read', async () => {
    const runId = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(runId, [{ docId: 'DOC-A', supported: false }, { docId: 'DOC-B', supported: 'no' }]);
    const report = await knowledge();
    expect(report.blockedCases).toBe(0);
    expect(report.unreadCases).toBe(1);
  });

  it('counts a case as unread when its claims or one verdict cannot be read, and never as answered', async () => {
    await documentOf('DOC-TEAM', { source: 'console', createdAt: daysAgo(2) });
    // A draft whose sentence list is not a list, with a refused verdict.
    const noClaims = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await journal(noClaims, 'compose', 'done', { abstained: false, claimCount: 1, sentences: 'not a list' });
    await journal(noClaims, 'gate', 'done', { groundedness: 0, decision: 'gated',
      claimVerdicts: [{ claimIndex: 0, supported: false }] });
    // A supported claim on the team document, and a claim with two verdicts.
    const oneUnread = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await journal(oneUnread, 'compose', 'done', { abstained: false, claimCount: 2, sentences: [
      { text: 'Claim 0.', docId: 'DOC-TEAM' }, { text: 'Claim 1.', docId: 'DOC-A' }] });
    await journal(oneUnread, 'gate', 'done', { groundedness: 0.5, decision: 'gated', claimVerdicts: [
      { claimIndex: 0, supported: true }, { claimIndex: 1, supported: true }, { claimIndex: 1, supported: false }] });
    const report = await knowledge();
    expect([report.blockedCases, report.unreadCases, report.answeredByTeam]).toEqual([0, 2, 0]);
  });

  it('never counts a blocked case as unread, whatever else its journal cannot say', async () => {
    // Claim 0 is refused; claim 1 has two verdicts, so the page reads it as not judged.
    const runId = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await journal(runId, 'compose', 'done', { abstained: false, claimCount: 2, sentences: [
      { text: 'Claim 0.', docId: 'DOC-A' }, { text: 'Claim 1.', docId: 'DOC-B' }] });
    await journal(runId, 'gate', 'done', { groundedness: 0.5, decision: 'gated', claimVerdicts: [
      { claimIndex: 0, supported: false }, { claimIndex: 1, supported: true }, { claimIndex: 1, supported: false }] });
    const report = await knowledge();
    expect([report.blockedCases, report.unreadCases]).toEqual([1, 0]);
    expect(await readCaseGap(readers, runId, NOW))
      .toEqual({ runId, attempt: 1, gap: { kind: 'unsupported', docIds: ['DOC-A'] }, counted: true, unread: false });
  });

  it('counts a case as unread when its compose row cannot be read, and never when it is judged', async () => {
    const bad = await runOf(await arrive(), { state: 'escalated' });
    await journal(bad, 'compose', 'done', { abstained: 'maybe' });
    const judged = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(judged, [{ docId: 'DOC-A', supported: true }]);
    const abstain = await runOf(await arrive(), { state: 'escalated' });
    await abstained(abstain);
    const report = await knowledge();
    expect([report.blockedCases, report.unreadCases]).toEqual([1, 1]);
  });

  it('counts a turn once, however many of its attempts were blocked', async () => {
    const turn = await arrive();
    const first = await runOf(turn, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(3) });
    await answered(first, [{ docId: 'DOC-A', supported: false }]);
    const second = await runOf(turn, { state: 'awaiting_approval', parked: true, attempt: 2, createdAt: daysAgo(2) });
    await answered(second, [{ docId: 'DOC-A', supported: false }]);
    const report = await knowledge();
    expect(report.blockedCases).toBe(1);
    expect(report.gaps[0]!.runIds).toEqual([second]);
  });

  it('reads the latest attempt that reached a person, not the first', async () => {
    const turn = await arrive();
    const first = await runOf(turn, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(3) });
    await answered(first, [{ docId: 'DOC-A', supported: false }]);
    const second = await runOf(turn, { state: 'awaiting_approval', parked: true, attempt: 2, createdAt: daysAgo(2) });
    await answered(second, [{ docId: 'DOC-A', supported: true }]);
    expect((await knowledge()).blockedCases).toBe(0);
  });

  it('keeps the earlier attempt when the latest has not reached a person yet', async () => {
    // A re-run still composing must not hide the case it came from.
    const turn = await arrive();
    const first = await runOf(turn, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(3) });
    await answered(first, [{ docId: 'DOC-A', supported: false }]);
    await runOf(turn, { state: 'retrieved', attempt: 2, createdAt: daysAgo(2) });
    const report = await knowledge();
    expect(report.blockedCases).toBe(1);
    expect(report.gaps[0]!.runIds).toEqual([first]);
  });

  it('breaks a tie between runs of one attempt by the later start', async () => {
    const turn = await arrive();
    const earlier = await runOf(turn, { state: 'superseded', parked: true, createdAt: daysAgo(3) });
    await answered(earlier, [{ docId: 'DOC-A', supported: true }]);
    const later = await runOf(turn, { state: 'escalated', createdAt: daysAgo(2) });
    await abstained(later);
    expect((await knowledge()).gaps[0]!.runIds).toEqual([later]);
  });

  it('breaks a tie of attempt and start by the higher run id', async () => {
    const turn = await arrive();
    const at = daysAgo(2);
    const a = await runOf(turn, { state: 'escalated', createdAt: at });
    const b = await runOf(turn, { state: 'escalated', createdAt: at });
    const [low, high] = [a, b].sort();
    await abstained(high!);
    await answered(low!, [{ docId: 'DOC-A', supported: true }]);
    expect((await knowledge()).gaps.flatMap((g) => g.runIds)).toEqual([high]);
    expect((await readCaseGap(readers, low!, NOW))?.runId).toBe(high);
  });

  it('ranks by attempt before start, when a higher attempt started earlier', async () => {
    // Clock skew between writers can start attempt 2 before attempt 1. The
    // attempt decides, on the screen and on the case page alike.
    const turn = await arrive();
    const first = await runOf(turn, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(2) });
    await answered(first, [{ docId: 'DOC-A', supported: true }]);
    const second = await runOf(turn, { state: 'escalated', attempt: 2, createdAt: daysAgo(3) });
    await abstained(second);
    expect((await knowledge()).gaps.flatMap((g) => g.runIds)).toEqual([second]);
    expect((await readCaseGap(readers, first, NOW))?.runId).toBe(second);
  });

  it('chooses the attempt of record before the window, so a later attempt decides', async () => {
    const turn = await arrive();
    const first = await runOf(turn, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(2) });
    await answered(first, [{ docId: 'DOC-A', supported: false }]);
    const later = await runOf(turn, {
      state: 'awaiting_approval', parked: true, attempt: 2, createdAt: new Date(NOW.getTime() + 1_000),
    });
    await answered(later, [{ docId: 'DOC-A', supported: true }]);
    expect((await knowledge()).blockedCases).toBe(0);
    expect(await readCaseGap(readers, first, NOW)).toEqual({ runId: later, attempt: 2, gap: null, counted: false, unread: false });
  });

  it('counts a case whose attempt of record is in the window when an older one is not', async () => {
    const turn = await arrive();
    const old = await runOf(turn, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(20) });
    await answered(old, [{ docId: 'DOC-A', supported: true }]);
    const recent = await runOf(turn, { state: 'escalated', attempt: 2, createdAt: daysAgo(1) });
    await abstained(recent);
    expect((await knowledge()).gaps.flatMap((g) => g.runIds)).toEqual([recent]);
  });

  it('says a case older than the window is blocked but not counted now', async () => {
    const runId = await runOf(await arrive(), { state: 'escalated', createdAt: daysAgo(GAP_WINDOW_DAYS + 1) });
    await abstained(runId);
    expect(await readCaseGap(readers, runId, NOW)).toEqual({ runId, attempt: 1, gap: { kind: 'abstained' }, counted: false, unread: false });
    expect((await knowledge()).blockedCases).toBe(0);
  });

  it('keeps an empty product with no product, as one group', async () => {
    const a = await runOf(await arrive(), { state: 'escalated', product: '' });
    await abstained(a);
    const b = await runOf(await arrive(), { state: 'escalated', product: null, createdAt: daysAgo(2) });
    await abstained(b);
    expect((await knowledge()).gaps.map((g) => [g.product, g.cases])).toEqual([[null, 2]]);
  });

  it('keeps a blocked attempt when the send-back ends with a run that drafted nothing', async () => {
    // The consumer files such a run escalated, with an escalate row and no
    // compose row, when the new attempts keep failing.
    const turn = await arrive();
    const first = await runOf(turn, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(3) });
    await answered(first, [{ docId: 'DOC-A', supported: false }]);
    const ended = await runOf(turn, { state: 'escalated', attempt: 2, createdAt: daysAgo(2) });
    await journal(ended, 'escalate', 'done', { reason: 'send_back_attempts_failed' });
    const report = await knowledge();
    expect(report.gaps.flatMap((g) => g.runIds)).toEqual([first]);
    expect((await readCaseGap(readers, ended, NOW))?.runId).toBe(first);
  });

  it('does not count a case whose runs reached a person without composing', async () => {
    const runId = await runOf(await arrive(), { state: 'escalated' });
    await classified(runId, 'refund_request');
    await journal(runId, 'escalate', 'done', { reason: 'agreement_below_threshold' });
    expect((await knowledge()).blockedCases).toBe(0);
    expect(await readCaseGap(readers, runId, NOW)).toBeNull();
  });

  it('keeps counting a gap after a person rewrote the reply', async () => {
    // DEC-48: the page draws no verdict on a rewritten reply. The gap stays,
    // because a person had to write the answer.
    const runId = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(runId, [{ docId: 'DOC-A', supported: false }]);
    await journal(runId, 'rewrite', 'done', { rewrittenBy: 'reviewer-one', cleared: 'a digest' });
    expect((await knowledge()).blockedCases).toBe(1);
    expect((await readCaseGap(readers, runId, NOW))?.gap).toEqual({ kind: 'unsupported', docIds: ['DOC-A'] });
  });

  it('does not count a case that never reached a person', async () => {
    const runId = await runOf(await arrive(), { state: 'resolved' });
    await answered(runId, [{ docId: 'DOC-A', supported: false }]);
    expect((await knowledge()).blockedCases).toBe(0);
  });

  it('does not count a park that did not finish', async () => {
    const runId = await runOf(await arrive(), { state: 'composed' });
    await journal(runId, 'park', 'parking', { parkKey: 'k' });
    await answered(runId, [{ docId: 'DOC-A', supported: false }]);
    expect((await knowledge()).blockedCases).toBe(0);
  });

  it('counts a run with no turn as its own case', async () => {
    const a = await runOf(turnless(), { state: 'escalated' });
    await abstained(a);
    const b = await runOf(turnless(), { state: 'escalated' });
    await abstained(b);
    expect((await knowledge()).blockedCases).toBe(2);
  });

  it('counts over a half-open window of fourteen days before now', async () => {
    const edge = await runOf(await arrive(), { state: 'escalated', createdAt: daysAgo(GAP_WINDOW_DAYS) });
    await abstained(edge);
    const before = await runOf(await arrive(), {
      state: 'escalated', createdAt: new Date(daysAgo(GAP_WINDOW_DAYS).getTime() - 1),
    });
    await abstained(before);
    const atNow = await runOf(await arrive(), { state: 'escalated', createdAt: NOW });
    await abstained(atNow);
    const report = await knowledge();
    expect(report.gaps.flatMap((g) => g.runIds)).toEqual([edge]);
    expect(report.from).toBe(daysAgo(14).toISOString());
    expect(report.to).toBe(NOW.toISOString());
  });

  it('keeps a case with no intent or no product as a named group, and ranks by cases', async () => {
    const named = await runOf(await arrive(), { state: 'escalated', product: 'plan-basic' });
    await classified(named, 'refund_request');
    await abstained(named);
    const bare1 = await runOf(await arrive(), { state: 'escalated', createdAt: daysAgo(2) });
    await abstained(bare1);
    const bare2 = await runOf(await arrive(), { state: 'escalated', createdAt: daysAgo(3) });
    await abstained(bare2);
    const report = await knowledge();
    expect(report.gaps.map((g) => [g.intentId, g.product, g.cases, g.runIds])).toEqual([
      [null, null, 2, [bare1, bare2]],
      ['refund_request', 'plan-basic', 1, [named]],
    ]);
  });
});

describe('the documents on the knowledge screen', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  it('counts a document past review only once its review date is before today', async () => {
    await documentOf('DOC-TODAY', { reviewOffsetDays: 0 });
    await documentOf('DOC-YESTERDAY', { reviewOffsetDays: -1 });
    await documentOf('DOC-FRESH', { reviewOffsetDays: 5 });
    const report = await knowledge();
    expect(report.pastReview).toBe(1);
    expect(report.documents.map((d) => [d.docId, d.pastReview])).toEqual([['DOC-YESTERDAY', true]]);
  });

  it('counts the team documents written in the window, and no loaded one', async () => {
    await documentOf('DOC-TEAM', { source: 'console', createdAt: daysAgo(2) });
    await documentOf('DOC-TEAM-OLD', { source: 'console', createdAt: daysAgo(20) });
    await documentOf('DOC-LOADED', { source: 'loader', createdAt: daysAgo(2) });
    expect((await knowledge()).teamDocuments).toBe(1);
  });

  it('counts a case a team document answers, and never a blocked one', async () => {
    await documentOf('DOC-TEAM', { source: 'console', createdAt: daysAgo(2) });
    await documentOf('DOC-TEAM-OLD', { source: 'console', createdAt: daysAgo(20) });
    const answers = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(answers, [{ docId: 'DOC-TEAM', supported: true }]);
    // Supported on the team document, refused elsewhere: blocked, so not answered.
    const blocked = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(blocked, [{ docId: 'DOC-TEAM', supported: true }, { docId: 'DOC-A', supported: false }]);
    // Cites the team document in a refused claim only.
    const refused = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(refused, [{ docId: 'DOC-TEAM', supported: false }]);
    // Answered by a team document written before the window.
    const old = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(old, [{ docId: 'DOC-TEAM-OLD', supported: true }]);
    const report = await knowledge();
    expect(report.answeredByTeam).toBe(1);
    expect(report.blockedCases).toBe(2);
  });

  it('lists a refused document with its citations, owner and change flag', async () => {
    const digest = await documentOf('DOC-B');
    const blocked = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(blocked, [{ docId: 'DOC-B', supported: false }], { 'DOC-B': digest });
    const supported = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(supported, [{ docId: 'DOC-B', supported: true }], { 'DOC-B': digest });
    const report = await knowledge();
    expect(report.documents).toEqual([{
      docId: 'DOC-B', title: 'Title of DOC-B', owner: 'kb-team', products: ['plan-basic'],
      reviewBy: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), pastReview: false,
      embeddingFailed: null, refusedCases: 1, citations: 2, flag: 'unchanged',
    }]);
    expect(report.documentsNeedingAPerson).toBe(1);
  });

  it('flags a document changed when its body moved since a case read it', async () => {
    const before = await documentOf('DOC-B', { body: 'The first body.' });
    await pool.query("UPDATE document SET body = 'The second body.' WHERE doc_id = 'DOC-B'");
    const runId = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(runId, [{ docId: 'DOC-B', supported: false }], { 'DOC-B': before });
    expect((await knowledge()).documents[0]!.flag).toBe('changed');
  });

  it('flags a document not compared when a citing case recorded no hash', async () => {
    const digest = await documentOf('DOC-B');
    const hashed = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(hashed, [{ docId: 'DOC-B', supported: false }], { 'DOC-B': digest });
    const unhashed = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(unhashed, [{ docId: 'DOC-B', supported: true }]);
    expect((await knowledge()).documents[0]!.flag).toBe('not_compared');
  });

  it('lists a failed embedding with its reason, and flags an uncited one not cited', async () => {
    await documentOf('DOC-FAILED', { failed: 'the provider refused the text (HTTP 413)' });
    await documentOf('DOC-FINE');
    const [doc, ...rest] = (await knowledge()).documents;
    expect(rest).toEqual([]);
    expect(doc).toMatchObject({
      docId: 'DOC-FAILED', embeddingFailed: 'the provider refused the text (HTTP 413)', flag: 'not_cited',
    });
  });

  it('lists no more than the limit, and counts every document that needs a person', async () => {
    for (let i = 0; i < NEEDS_A_PERSON_LIMIT + 3; i++) {
      await documentOf(`DOC-OLD-${String(i).padStart(3, '0')}`, { reviewOffsetDays: -1 });
    }
    const report = await knowledge();
    expect(report.documents).toHaveLength(NEEDS_A_PERSON_LIMIT);
    expect(report.documentsNeedingAPerson).toBe(NEEDS_A_PERSON_LIMIT + 3);
    expect(report.pastReview).toBe(NEEDS_A_PERSON_LIMIT + 3);
  });

  it('lists a document refused on an attempt a person saw and sent back', async () => {
    // The ruling reads "a claim a person saw in the last 14 days". Attempt 1
    // showed the refusal; attempt 2 answers the case.
    await documentOf('DOC-A');
    await documentOf('DOC-B');
    const turn = await arrive();
    const first = await runOf(turn, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(3) });
    await answered(first, [{ docId: 'DOC-A', supported: false }]);
    const second = await runOf(turn, { state: 'awaiting_approval', parked: true, attempt: 2, createdAt: daysAgo(2) });
    await answered(second, [{ docId: 'DOC-B', supported: true }]);
    const report = await knowledge();
    expect(report.blockedCases).toBe(0);
    expect(report.documents.map((d) => [d.docId, d.refusedCases, d.citations, d.flag]))
      .toEqual([['DOC-A', 1, 1, 'not_compared']]);
  });

  it('counts one refused document once per case, however many attempts refused it', async () => {
    await documentOf('DOC-A');
    const turn = await arrive();
    const first = await runOf(turn, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(3) });
    await answered(first, [{ docId: 'DOC-A', supported: false }]);
    const second = await runOf(turn, { state: 'awaiting_approval', parked: true, attempt: 2, createdAt: daysAgo(2) });
    await answered(second, [{ docId: 'DOC-A', supported: false }]);
    expect((await knowledge()).documents.map((d) => [d.docId, d.refusedCases])).toEqual([['DOC-A', 1]]);
  });

  it('never lists a refusal without its citation', async () => {
    // Refusals and citations come from the same attempts, so a refused
    // document is cited at least as often, and never reads as not cited.
    const digest = await documentOf('DOC-A');
    await documentOf('DOC-B');
    for (let i = 0; i < 3; i++) {
      const turn = await arrive();
      const first = await runOf(turn, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(4) });
      await answered(first, [{ docId: 'DOC-A', supported: false }], { 'DOC-A': digest });
      if (i > 0) {
        const second = await runOf(turn, { state: 'awaiting_approval', parked: true, attempt: 2, createdAt: daysAgo(3) });
        await answered(second, [{ docId: i === 1 ? 'DOC-A' : 'DOC-B', supported: true }], { 'DOC-A': digest });
      }
    }
    const report = await knowledge();
    for (const doc of report.documents) {
      expect(doc.refusedCases).toBeLessThanOrEqual(doc.citations);
      if (doc.refusedCases > 0) expect(doc.flag).not.toBe('not_cited');
    }
    expect(report.documents.map((d) => [d.docId, d.refusedCases, d.citations, d.flag]))
      .toEqual([['DOC-A', 3, 3, 'unchanged']]);
  });

  it('does not list a document refused only before the window', async () => {
    await documentOf('DOC-A');
    const runId = await runOf(await arrive(), {
      state: 'awaiting_approval', parked: true, createdAt: daysAgo(GAP_WINDOW_DAYS + 2),
    });
    await answered(runId, [{ docId: 'DOC-A', supported: false }]);
    expect((await knowledge()).documents).toEqual([]);
  });

  it('reads no hash from a retrieval whose id list the run page cannot read', async () => {
    const digest = await documentOf('DOC-B');
    const runId = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(runId, [{ docId: 'DOC-B', supported: false }], { 'DOC-B': digest });
    await pool.query(
      `UPDATE step_journal SET result = jsonb_set(result, '{docIds}', '["DOC-B", 7]')
        WHERE run_id = $1 AND step_id = 'retrieve'`,
      [runId],
    );
    expect((await knowledge()).documents[0]!.flag).toBe('not_compared');
  });

  it('orders refused documents by how many cases refused them, in the list and in a gap', async () => {
    await documentOf('DOC-ONCE');
    await documentOf('DOC-TWICE');
    for (const refused of [['DOC-TWICE', 'DOC-ONCE'], ['DOC-TWICE']]) {
      const runId = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
      await classified(runId, 'refund_request');
      await answered(runId, refused.map((docId) => ({ docId, supported: false })));
    }
    const report = await knowledge();
    expect(report.documents.map((d) => [d.docId, d.refusedCases])).toEqual([['DOC-TWICE', 2], ['DOC-ONCE', 1]]);
    expect(report.gaps[0]!.refused.map((d) => [d.docId, d.cases])).toEqual([['DOC-TWICE', 2], ['DOC-ONCE', 1]]);
  });

  it('lists refusals first, then failed embeddings, then the oldest review', async () => {
    await documentOf('DOC-OLD', { reviewOffsetDays: -9 });
    await documentOf('DOC-NEWER', { reviewOffsetDays: -2 });
    await documentOf('DOC-FAILED', { failed: 'refused' });
    await documentOf('DOC-B');
    const runId = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
    await answered(runId, [{ docId: 'DOC-B', supported: false }]);
    expect((await knowledge()).documents.map((d) => d.docId))
      .toEqual(['DOC-B', 'DOC-FAILED', 'DOC-OLD', 'DOC-NEWER']);
  });
});

describe('the gap of one case', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  it('answers for the attempt of record from the page of an earlier attempt', async () => {
    const turn = await arrive();
    const first = await runOf(turn, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(3) });
    await answered(first, [{ docId: 'DOC-A', supported: true }]);
    const second = await runOf(turn, { state: 'escalated', attempt: 2, createdAt: daysAgo(2) });
    await abstained(second);
    expect(await readCaseGap(readers, first, NOW))
      .toEqual({ runId: second, attempt: 2, gap: { kind: 'abstained' }, counted: true, unread: false });
  });

  it('answers null for a case that never reached a person, and for an id that is not one', async () => {
    const runId = await runOf(await arrive(), { state: 'resolved' });
    await abstained(runId);
    expect(await readCaseGap(readers, runId, NOW)).toBeNull();
    expect(await readCaseGap(readers, randomUUID(), NOW)).toBeNull();
    expect(await readCaseGap(readers, 'not-a-uuid', NOW)).toBeNull();
  });

  it('agrees with the knowledge screen about every case', async () => {
    // One case of each shape, each on an intent of its own so the groups
    // name them. The case page's answer for any run of a case must match
    // whether the screen counts that case.
    const shapes: { intent: string; seed: (turn: Turn) => Promise<string[]> }[] = [
      { intent: 'abstain', seed: async (t) => { const r = await runOf(t, { state: 'escalated' }); await abstained(r); return [r]; } },
      { intent: 'refused', seed: async (t) => { const r = await runOf(t, { state: 'awaiting_approval', parked: true }); await answered(r, [{ docId: 'DOC-A', supported: false }]); return [r]; } },
      { intent: 'supported', seed: async (t) => { const r = await runOf(t, { state: 'awaiting_approval', parked: true }); await answered(r, [{ docId: 'DOC-A', supported: true }]); return [r]; } },
      { intent: 'malformed', seed: async (t) => { const r = await runOf(t, { state: 'awaiting_approval', parked: true }); await answered(r, [{ docId: 'DOC-A', supported: 'no' }]); return [r]; } },
      { intent: 'resent', seed: async (t) => {
        const a = await runOf(t, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(3) });
        await answered(a, [{ docId: 'DOC-A', supported: false }]);
        const b = await runOf(t, { state: 'awaiting_approval', parked: true, attempt: 2, createdAt: daysAgo(2) });
        await answered(b, [{ docId: 'DOC-A', supported: true }]);
        return [a, b];
      } },
      // Blocked in the window, and answered by a later attempt that started
      // after it: the case page reads the later attempt, so the screen must.
      { intent: 'later', seed: async (t) => {
        const a = await runOf(t, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(2) });
        await answered(a, [{ docId: 'DOC-A', supported: false }]);
        const b = await runOf(t, { state: 'escalated', attempt: 2, createdAt: new Date(NOW.getTime() + 1_000) });
        await abstained(b);
        return [a, b];
      } },
      // Blocked, and older than the window.
      { intent: 'old', seed: async (t) => {
        const r = await runOf(t, { state: 'escalated', createdAt: daysAgo(GAP_WINDOW_DAYS + 1) });
        await abstained(r);
        return [r];
      } },
      // A run with no turn is its own case, found by its own id.
      { intent: 'turnless', seed: async () => {
        const r = await runOf(turnless(), { state: 'escalated' });
        await abstained(r);
        return [r];
      } },
      // A draft whose claims cannot be read: neither blocked nor answered.
      { intent: 'unreadable', seed: async (t) => {
        const r = await runOf(t, { state: 'awaiting_approval', parked: true });
        await journal(r, 'compose', 'done', { abstained: false, claimCount: 1, sentences: 'not a list' });
        await journal(r, 'gate', 'done', { groundedness: 0, decision: 'gated', claimVerdicts: [{ claimIndex: 0, supported: false }] });
        return [r];
      } },
      // DEC-48: a person rewrote the refused reply; the gap still counts.
      { intent: 'rewritten', seed: async (t) => {
        const r = await runOf(t, { state: 'awaiting_approval', parked: true });
        await answered(r, [{ docId: 'DOC-B', supported: false }]);
        await journal(r, 'rewrite', 'done', { rewrittenBy: 'reviewer-one', cleared: 'a digest' });
        return [r];
      } },
      // A send-back that ended with no draft does not hide the refusal.
      { intent: 'ended', seed: async (t) => {
        const a = await runOf(t, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(3) });
        await answered(a, [{ docId: 'DOC-C', supported: false }]);
        const b = await runOf(t, { state: 'escalated', attempt: 2, createdAt: daysAgo(2) });
        await journal(b, 'escalate', 'done', { reason: 'send_back_attempts_failed' });
        return [a, b];
      } },
      { intent: 'rerunning', seed: async (t) => {
        const a = await runOf(t, { state: 'superseded', parked: true, attempt: 1, createdAt: daysAgo(3) });
        await answered(a, [{ docId: 'DOC-A', supported: false }]);
        const b = await runOf(t, { state: 'retrieved', attempt: 2, createdAt: daysAgo(2) });
        return [a, b];
      } },
    ];
    const runsByIntent = new Map<string, string[]>();
    for (const shape of shapes) {
      const runs = await shape.seed(await arrive());
      for (const runId of runs) await classified(runId, shape.intent);
      runsByIntent.set(shape.intent, runs);
    }
    const report = await knowledge();
    const groups = new Map(report.gaps.map((g) => [g.intentId, g]));
    for (const [intent, runs] of runsByIntent) {
      for (const runId of runs) {
        const gap = await readCaseGap(readers, runId, NOW);
        const onScreen = gap !== null && gap.gap !== null && gap.counted;
        // The same documents on both, not only the same answer.
        const namedOnPage = gap?.gap?.kind === 'unsupported' ? gap.gap.docIds : [];
        const namedOnScreen = groups.get(intent)?.refused.map((doc) => doc.docId) ?? [];
        expect({ intent, runId, onScreen, named: namedOnPage })
          .toEqual({ intent, runId, onScreen: groups.has(intent), named: onScreen ? namedOnScreen : namedOnPage });
      }
    }
    expect([...groups.keys()].sort()).toEqual(['abstain', 'ended', 'refused', 'rerunning', 'rewritten', 'turnless']);
    // The unreadable claims and the malformed verdict list.
    expect(report.unreadCases).toBe(2);
    for (const intent of ['unreadable', 'malformed']) {
      expect((await readCaseGap(readers, runsByIntent.get(intent)![0]!, NOW))?.unread).toBe(true);
    }
    expect(await readCaseGap(readers, runsByIntent.get('turnless')![0]!, NOW))
      .toEqual({ runId: runsByIntent.get('turnless')![0], attempt: 1, gap: { kind: 'abstained' }, counted: true, unread: false });
  });

  it('names the refused claims the run page reads as refused, for every case', async () => {
    // The run page reads a run through readRunJournal and verdictAt. Each
    // seeded shape is compared against that path, not against this module.
    const two = [{ docId: 'DOC-A', supported: true }, { docId: 'DOC-B', supported: false }];
    const shapes: {
      claims: { docId: string; supported: boolean | string }[];
      gate?: { status: string; result: Record<string, unknown> };
    }[] = [
      { claims: two },
      { claims: [{ docId: 'DOC-A', supported: false }, { docId: 'DOC-A', supported: false }] },
      { claims: [{ docId: 'DOC-A', supported: true }] },
      { claims: [{ docId: 'DOC-A', supported: 'no' }] },
      // Two verdicts for claim 1, the refusal first.
      { claims: two, gate: { status: 'done', result: { groundedness: 0.5, decision: 'gated', claimVerdicts: [
        { claimIndex: 0, supported: true }, { claimIndex: 1, supported: false }, { claimIndex: 1, supported: true }] } } },
      // A refusal at a position that names no claim.
      { claims: two, gate: { status: 'done', result: { groundedness: 0.5, decision: 'gated', claimVerdicts: [
        { claimIndex: 0, supported: true }, { claimIndex: 1, supported: true }, { claimIndex: 4, supported: false }] } } },
      // A gate row with no groundedness, and one that did not finish.
      { claims: two, gate: { status: 'done', result: { decision: 'gated', claimVerdicts: [
        { claimIndex: 0, supported: true }, { claimIndex: 1, supported: false }] } } },
      { claims: two, gate: { status: 'failed', result: { groundedness: 0.5, decision: 'gated', claimVerdicts: [
        { claimIndex: 0, supported: true }, { claimIndex: 1, supported: false }] } } },
    ];
    for (const shape of shapes) {
      await truncateLedger(pool);
      const runId = await runOf(await arrive(), { state: 'awaiting_approval', parked: true });
      await answered(runId, shape.claims);
      if (shape.gate !== undefined) {
        await pool.query(
          "UPDATE step_journal SET status = $2, result = $3 WHERE run_id = $1 AND step_id = 'gate'",
          [runId, shape.gate.status, JSON.stringify(shape.gate.result)],
        );
      }
      const journalRead = (await readRunJournal(readers, runId))!;
      const compose = journalRead.steps.find((step) => step.compose !== null)!.compose!;
      const refusedOnPage = [...new Set((compose.claims ?? [])
        .filter((_, i) => verdictAt(journalRead.coverage?.claimVerdicts ?? null, i) === false)
        .map((claim) => claim.docId))];
      const gap = (await readCaseGap(readers, runId, NOW))!.gap;
      expect({ shape, docIds: gap?.kind === 'unsupported' ? gap.docIds : [] })
        .toEqual({ shape, docIds: refusedOnPage });
    }
  });

  it('refuses a bound outside what both ends honour, before taking a connection', async () => {
    await expect(readCaseGap(readers, randomUUID(), NOW, 0)).rejects.toThrow(/readCaseGap: timeoutMs/);
    await expect(readKnowledge(readers, NOW, 1_000, Number.POSITIVE_INFINITY))
      .rejects.toThrow(/readKnowledge: clientTimeoutMs/);
  });
});
