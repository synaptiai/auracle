// A document a reviewer publishes from a case (DEC-50).
//
// Every row is synthetic (DEC-18), and every address is a reserved test name.
// Each case seeds a turn, runs a publish, and asks the ledger what it holds.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { replyDigest } from '../approval/shown.js';
import { dbUrl } from '../db/config.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { fencedInsert } from '../ledger/insert.js';
import { guardLedgerPool } from '../db/client-errors.js';
import { truncateLedger } from '../test-support/schema.js';
import {
  MAX_DOCUMENT_BODY_BYTES, MAX_DOCUMENT_BODY_CHARS, MAX_DOCUMENT_TITLE_CHARS, publishDocument,
} from './publish.js';
import type { PublishInput } from './publish.js';

const pool = new Pool({ connectionString: dbUrl() });
await pool.query('SELECT 1');

afterAll(async () => {
  await pool.end();
});

const ADDRESS = 'pat@customer.test';
let epoch = 1n;

interface Case {
  readonly runId: string;
  readonly ticketId: string;
  readonly messageId: string;
  readonly conversationId: string | null;
}

/** A turn and one run of it, in the state given, on the product given. */
async function caseOf(
  state: string,
  options: { product?: string | null; turn?: boolean; draft?: string; body?: string } = {},
): Promise<Case> {
  const ticketId = 'T-' + randomUUID().slice(0, 8);
  const messageId = `<m-${randomUUID().slice(0, 8)}@mail.example>`;
  const turn = options.turn === false
    ? null
    : await enqueueTicket(pool, { ticketId, messageId, ticketText: 'a synthetic question', customerAddress: ADDRESS }, 4);
  const runId = randomUUID();
  epoch += 1n;
  const inserted = await fencedInsert(pool, {
    runId, ticketId, partition: 0, epoch, state, promptVer: 'p1', modelVer: 'm1',
    ...(turn === null ? {} : { conversationId: turn.conversationId, turnNumber: turn.turnNumber }),
    attempt: 1,
    product: options.product === undefined ? 'aurora' : options.product,
    deadlineAt: new Date(Date.now() + 60_000),
  }, null);
  expect(inserted).toEqual({ outcome: 'accepted' });
  if (state === 'awaiting_approval') {
    await pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, 'park', 'done', $2, 'p1', 'm1', 0)`,
      [runId, JSON.stringify({
        actionClass: 'customer_reply', delivery: 'at_most_once', body: options.body ?? 'The parked reply.',
        ...(turn === null ? {} : { turnNumber: turn.turnNumber }),
        ...(options.draft === undefined ? {} : { draftExternalId: options.draft }),
      })],
    );
  }
  return { runId, ticketId, messageId, conversationId: turn?.conversationId ?? null };
}

const CATALOGUE = ['aurora', 'ledger'];

function input(runId: string, over: Partial<PublishInput> = {}): PublishInput {
  return {
    runId,
    title: 'Pausing a plan',
    body: 'A plan may be paused once a year, for up to 41 days.',
    products: ['aurora'],
    owner: 'kb-team',
    reviewBy: '2999-01-01',
    writtenBy: 'reviewer-a',
    catalogue: CATALOGUE,
    ledgerReply: false,
    ...over,
  };
}

async function documents(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM document');
  return rows[0]!.n;
}

describe('publishing a document from a case (DEC-50)', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  it('writes a pending console document with its author, and a waiting request', async () => {
    const c = await caseOf('escalated');
    const outcome = await publishDocument(pool, input(c.runId, { products: ['aurora', 'ledger'] }));
    expect(outcome).toMatchObject({ outcome: 'published', rerun: { status: 'waiting' } });
    const docId = (outcome as { docId: string }).docId;
    expect(docId).toMatch(/^console-[0-9a-f-]{36}$/);
    const doc = await pool.query(
      `SELECT title, body, owner, to_char(review_by, 'YYYY-MM-DD') AS review_by, products, source,
              embedding_status, embedding IS NULL AS no_vector, written_by, kind
         FROM document WHERE doc_id = $1`,
      [docId],
    );
    expect(doc.rows[0]).toEqual({
      title: 'Pausing a plan', body: 'A plan may be paused once a year, for up to 41 days.', owner: 'kb-team',
      review_by: '2999-01-01', products: ['aurora', 'ledger'], source: 'console',
      embedding_status: 'pending', no_vector: true, written_by: 'reviewer-a', kind: 'document',
    });
    const request = await pool.query(
      'SELECT run_id, conversation_id, attempt, status, reason FROM document_rerun WHERE doc_id = $1',
      [docId],
    );
    expect(request.rows[0]).toEqual({
      run_id: c.runId, conversation_id: c.conversationId, attempt: 1, status: 'waiting', reason: null,
    });
  });

  it('refuses a case whose channel maps no product, and writes nothing', async () => {
    for (const product of [null, '', '  ']) {
      const c = await caseOf('escalated', { product });
      expect(await publishDocument(pool, input(c.runId))).toEqual({ outcome: 'no_product' });
    }
    expect(await documents()).toBe(0);
  });

  it("requires the case's own product, and refuses one the catalogue does not name", async () => {
    const c = await caseOf('escalated');
    expect(await publishDocument(pool, input(c.runId, { products: ['ledger'] })))
      .toEqual({ outcome: 'product_missing', product: 'aurora' });
    expect(await publishDocument(pool, input(c.runId, { products: ['aurora', 'nova'] })))
      .toEqual({ outcome: 'unknown_product', product: 'nova' });
    expect(await publishDocument(pool, input(c.runId, { products: [] }))).toEqual({ outcome: 'no_products' });
    expect(await documents()).toBe(0);
  });

  it('refuses every empty, overlong or unstorable field by name', async () => {
    const c = await caseOf('escalated');
    const zwsp = String.fromCharCode(0x200b);
    const cases: Array<[Partial<PublishInput>, unknown]> = [
      [{ title: `  ${zwsp} ` }, { outcome: 'title_empty' }],
      [{ title: 'x'.repeat(MAX_DOCUMENT_TITLE_CHARS + 1) }, { outcome: 'title_too_long' }],
      [{ title: 'a' + String.fromCharCode(0) }, { outcome: 'unprintable', field: 'title' }],
      [{ body: '' }, { outcome: 'body_empty' }],
      [{ body: 'x'.repeat(MAX_DOCUMENT_BODY_CHARS + 1) }, { outcome: 'body_too_long' }],
      // Few characters and many bytes: the model's limit counts tokens, and a
      // token never covers less than a byte.
      [{ body: String.fromCodePoint(0x1f600).repeat(MAX_DOCUMENT_BODY_BYTES / 4 + 1) }, { outcome: 'body_too_long' }],
      [{ body: 'a' + String.fromCharCode(0xd800) }, { outcome: 'unprintable', field: 'body' }],
      [{ owner: ' ' }, { outcome: 'owner_empty' }],
      [{ reviewBy: '' }, { outcome: 'review_date_invalid' }],
      [{ reviewBy: '2999-02-30' }, { outcome: 'review_date_invalid' }],
      [{ reviewBy: '2999-1-01' }, { outcome: 'review_date_invalid' }],
      [{ writtenBy: ' ' }, { outcome: 'no_author' }],
    ];
    for (const [over, expected] of cases) {
      expect(await publishDocument(pool, input(c.runId, over)), JSON.stringify(over).slice(0, 60)).toEqual(expected);
    }
    // At the limit, a title and a body are accepted.
    expect(await publishDocument(pool, input(c.runId, {
      title: 'x'.repeat(MAX_DOCUMENT_TITLE_CHARS), body: 'y'.repeat(MAX_DOCUMENT_BODY_CHARS),
    }))).toMatchObject({ outcome: 'published' });
    expect(await documents()).toBe(1);
  });

  it('refuses a review date of today or earlier, and accepts tomorrow', async () => {
    const c = await caseOf('escalated');
    const { rows } = await pool.query<{ today: string; yesterday: string; tomorrow: string }>(
      `SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today,
              to_char(CURRENT_DATE - 1, 'YYYY-MM-DD') AS yesterday,
              to_char(CURRENT_DATE + 1, 'YYYY-MM-DD') AS tomorrow`,
    );
    const days = rows[0]!;
    expect(await publishDocument(pool, input(c.runId, { reviewBy: days.today })))
      .toEqual({ outcome: 'review_date_not_ahead' });
    expect(await publishDocument(pool, input(c.runId, { reviewBy: days.yesterday })))
      .toEqual({ outcome: 'review_date_not_ahead' });
    expect(await publishDocument(pool, input(c.runId, { reviewBy: days.tomorrow })))
      .toMatchObject({ outcome: 'published' });
  });

  it('refuses a document that carries an identifier the ledger holds for the case', async () => {
    const c = await caseOf('awaiting_approval', { draft: '5120:77' });
    const ticketNumber = await caseOf('escalated');
    await pool.query('UPDATE run SET ticket_id = $2 WHERE run_id = $1', [ticketNumber.runId, '4417']);
    const cases: Array<[string, Partial<PublishInput>, unknown]> = [
      [c.runId, { body: 'Write to PAT@CUSTOMER.TEST.' }, { outcome: 'identifier', field: 'body', kind: 'address' }],
      [c.runId, { title: `About ${c.ticketId}` }, { outcome: 'identifier', field: 'title', kind: 'ticket' }],
      [c.runId, { body: `Quoted from ${c.messageId}.` }, { outcome: 'identifier', field: 'body', kind: 'message' }],
      [c.runId, { body: 'The draft 5120:77 holds it.' }, { outcome: 'identifier', field: 'body', kind: 'draft' }],
      [c.runId, { owner: 'Pat@Customer.test' }, { outcome: 'identifier', field: 'owner', kind: 'address' }],
      [ticketNumber.runId, { body: 'As ticket 4417 shows.' }, { outcome: 'identifier', field: 'body', kind: 'ticket' }],
    ];
    for (const [runId, over, expected] of cases) {
      expect(await publishDocument(pool, input(runId, over)), JSON.stringify(over)).toEqual(expected);
    }
    expect(await documents()).toBe(0);
    // The same number in prose is not the ticket.
    expect(await publishDocument(pool, input(ticketNumber.runId, { body: 'Up to 4417 items ship at once.' })))
      .toMatchObject({ outcome: 'published' });
  });

  it("reads identifiers from the conversation's other turns too", async () => {
    const first = await caseOf('escalated');
    // A second message on the same conversation, with its own ticket id.
    const second = await enqueueTicket(pool, {
      ticketId: 'T-second-7', messageId: '<second@mail.example>', ticketText: 'a follow-up',
      customerAddress: ADDRESS, linkage: { priorMessageIds: [first.messageId] },
    }, 4);
    expect(second.conversationId).toBe(first.conversationId);
    // A consumer acks each message, so the turns are what hold them after.
    await pool.query('DELETE FROM intake');
    expect(await publishDocument(pool, input(first.runId, { body: 'See T-second-7 for more.' })))
      .toEqual({ outcome: 'identifier', field: 'body', kind: 'ticket' });
    expect(await publishDocument(pool, input(first.runId, { body: 'Quoted from <second@mail.example>.' })))
      .toEqual({ outcome: 'identifier', field: 'body', kind: 'message' });
  });

  it('refuses a parked case whose reply changed since the page drew it', async () => {
    const c = await caseOf('awaiting_approval', { body: 'The parked reply.' });
    expect(await publishDocument(pool, input(c.runId, { shown: replyDigest('Another reply.') })))
      .toEqual({ outcome: 'shown_changed' });
    expect(await documents()).toBe(0);
    expect(await publishDocument(pool, input(c.runId, { shown: replyDigest('The parked reply.') })))
      .toMatchObject({ outcome: 'published', rerun: { status: 'waiting' } });
  });

  it('publishes a case that cannot be attempted again, and records why at once', async () => {
    const draft = await caseOf('awaiting_approval', { draft: '9001' });
    expect(await publishDocument(pool, input(draft.runId)))
      .toMatchObject({ outcome: 'published', rerun: { status: 'dropped', reason: 'copy_could_send' } });
    // Where the ledger holds the reply, the parked draft is a copy nobody can send.
    const held = await caseOf('awaiting_approval', { draft: '9002' });
    expect(await publishDocument(pool, input(held.runId, { ledgerReply: true })))
      .toMatchObject({ outcome: 'published', rerun: { status: 'waiting' } });
    const alone = await caseOf('escalated', { turn: false });
    expect(await publishDocument(pool, input(alone.runId)))
      .toMatchObject({ outcome: 'published', rerun: { status: 'dropped', reason: 'no_turn' } });
    const ended = await caseOf('resolved');
    // The state an approval leaves: resolved, with the approver recorded.
    await pool.query("UPDATE run SET approved_by = 'reviewer-b', approved_by_source = 'roster' WHERE run_id = $1", [ended.runId]);
    expect(await publishDocument(pool, input(ended.runId)))
      .toMatchObject({ outcome: 'published', rerun: { status: 'dropped', reason: 'approved' } });
    const { rows } = await pool.query<{ status: string; reason: string; ended: boolean }>(
      `SELECT status, reason, ended_at IS NOT NULL AS ended FROM document_rerun
        WHERE run_id = $1`,
      [draft.runId],
    );
    expect(rows).toEqual([{ status: 'dropped', reason: 'copy_could_send', ended: true }]);
  });

  it('answers a second identical post from the case with the first document', async () => {
    const c = await caseOf('escalated');
    const [first, second] = await Promise.all([
      publishDocument(pool, input(c.runId)), publishDocument(pool, input(c.runId)),
    ]);
    expect(first).toMatchObject({ outcome: 'published' });
    const docId = (first as { docId: string }).docId;
    const repeat = [first, second].find((one) => (one as { repeated?: true }).repeated === true);
    expect(repeat).toEqual({ outcome: 'published', docId, rerun: { status: 'waiting' }, repeated: true });
    expect(await documents()).toBe(1);
    // The same title and answer with another owner, products or author is
    // refused by name, and so is a repeat once the re-run has ended.
    for (const over of [{ owner: 'other-team' }, { products: ['aurora', 'ledger'] }, { writtenBy: 'reviewer-b' }]) {
      expect(await publishDocument(pool, input(c.runId, over)), JSON.stringify(over))
        .toEqual({ outcome: 'already_published', docId });
    }
    expect(await documents()).toBe(1);
  });

  it('answers a repeat on a case that could not re-run with the first answer, and reads products as a set', async () => {
    const ended = await caseOf('closed');
    const first = await publishDocument(pool, input(ended.runId, { products: ['aurora', 'ledger'] }));
    expect(first).toMatchObject({ outcome: 'published', rerun: { status: 'dropped', reason: 'closed' } });
    const docId = (first as { docId: string }).docId;
    expect(await publishDocument(pool, input(ended.runId, { products: ['ledger', 'aurora'] }))).toEqual({
      outcome: 'published', docId, repeated: true, rerun: { status: 'dropped', reason: 'closed' },
    });
    expect(await documents()).toBe(1);
    // A repeat after the request started reports that it started.
    await pool.query(
      "UPDATE document_rerun SET status = 'started', reason = NULL, ended_at = now(), started_attempt = 2"
        + ' WHERE doc_id = $1', [docId]);
    expect(await publishDocument(pool, input(ended.runId, { products: ['aurora', 'ledger'] })))
      .toMatchObject({ repeated: true, rerun: { status: 'started' } });
    // And after it failed, that it failed.
    await pool.query(
      "UPDATE document_rerun SET status = 'failed', reason = NULL, ended_at = now(), started_attempt = NULL WHERE doc_id = $1", [docId]);
    expect(await publishDocument(pool, input(ended.runId, { products: ['aurora', 'ledger'] })))
      .toMatchObject({ repeated: true, rerun: { status: 'failed' } });
    // Another document from the same case is its own.
    expect(await publishDocument(pool, input(ended.runId, { title: 'Another title' })))
      .toMatchObject({ outcome: 'published' });
    expect(await documents()).toBe(2);
  });

  // The runbook's removal block can delete the document while a repeat post
  // reads it. A person removed it, so a post written before that act must not
  // write it back (DEC-50). The repeat waits for the removal, then refuses.
  const setStatus = {
    ended: "UPDATE document_rerun SET status = 'dropped', reason = 'ended', ended_at = now(), started_attempt = NULL WHERE doc_id = $1",
    dropped: "UPDATE document_rerun SET status = 'dropped', reason = 'copy_could_send', ended_at = now(), started_attempt = NULL WHERE doc_id = $1",
    started: "UPDATE document_rerun SET status = 'started', reason = NULL, ended_at = now(), started_attempt = 2 WHERE doc_id = $1",
    waiting: "UPDATE document_rerun SET status = 'waiting', reason = NULL, ended_at = NULL, started_attempt = NULL WHERE doc_id = $1",
    failed: "UPDATE document_rerun SET status = 'failed', reason = NULL, ended_at = now(), started_attempt = NULL WHERE doc_id = $1",
  } as const;

  /** Waits until a publish in this database waits on the request's row lock. */
  async function publishWaitsOnRequest(): Promise<boolean> {
    for (let tries = 0; tries < 200; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      // This database only: the db project runs other files beside this one.
      const { rows } = await pool.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%FROM document_rerun WHERE doc_id = $1 FOR UPDATE%'`,
      );
      if (rows.length > 0) return true;
    }
    return false;
  }

  // A post that differs from the first refuses too: the case already
  // published that answer, and a person removed it.
  for (const [status, differs] of [
    ['ended', false], ['dropped', false], ['started', false], ['waiting', false], ['failed', false],
    ['waiting', true],
  ] as const) {
    it(`refuses a ${differs ? 'differing' : 'repeat'} post whose first document a person removes while it waits, its re-run ${status}`, async () => {
      const c = await caseOf('closed');
      const first = await publishDocument(pool, input(c.runId));
      const firstId = (first as { docId: string }).docId;
      await pool.query(setStatus[status], [firstId]);
      const remover = await pool.connect();
      let publishing: Promise<unknown> | undefined;
      let broken = false;
      try {
        await remover.query('BEGIN');
        await remover.query('DELETE FROM document_rerun WHERE doc_id = $1', [firstId]);
        await remover.query('DELETE FROM document WHERE doc_id = $1', [firstId]);
        publishing = publishDocument(pool, input(c.runId, differs ? { owner: 'another-team' } : {}))
          .then((v) => v, (error: unknown) => error);
        expect(await publishWaitsOnRequest(), 'the repeat never waited on the removal').toBe(true);
        await remover.query('COMMIT');
        // The repeat read the first document before the removal committed, so
        // only a post that waited on it can answer this.
        expect(await publishing).toEqual({ outcome: 'removed' });
      } finally {
        await remover.query('ROLLBACK').catch(() => { broken = true; });
        remover.release(broken);
        await publishing;
      }
      expect(await documents()).toBe(0);
    });
  }

  // The repeat answers with the request as it stands once it holds the lock.
  // A consumer that starts the request meanwhile is the one it reports.
  it('answers a repeat with the status the request holds once its lock is free', async () => {
    const c = await caseOf('closed');
    const first = await publishDocument(pool, input(c.runId));
    const firstId = (first as { docId: string }).docId;
    const consumer = await pool.connect();
    let publishing: Promise<unknown> | undefined;
    let broken = false;
    try {
      await consumer.query('BEGIN');
      await consumer.query('SELECT 1 FROM document_rerun WHERE doc_id = $1 FOR UPDATE', [firstId]);
      await consumer.query(setStatus.started, [firstId]);
      publishing = publishDocument(pool, input(c.runId)).then((v) => v, (error: unknown) => error);
      expect(await publishWaitsOnRequest(), 'the repeat never waited on the request').toBe(true);
      await consumer.query('COMMIT');
      expect(await publishing).toMatchObject({ outcome: 'published', docId: firstId, repeated: true, rerun: { status: 'started' } });
    } finally {
      await consumer.query('ROLLBACK').catch(() => { broken = true; });
      consumer.release(broken);
      await publishing;
    }
  });

  // Every lock a publish takes has a bound. When a removal holds the request
  // past it, the post answers busy and publishes nothing. The runbook states
  // what follows.
  it('answers busy when a removal holds the request past the bound', async () => {
    const c = await caseOf('closed');
    const first = await publishDocument(pool, input(c.runId));
    const firstId = (first as { docId: string }).docId;
    const remover = await pool.connect();
    let broken = false;
    try {
      await remover.query('BEGIN');
      await remover.query('SELECT 1 FROM document_rerun WHERE doc_id = $1 FOR UPDATE', [firstId]);
      expect(await publishDocument(pool, input(c.runId, { timeoutMs: 300 }))).toEqual({ outcome: 'busy' });
    } finally {
      await remover.query('ROLLBACK').catch(() => { broken = true; });
      remover.release(broken);
    }
    expect(await documents()).toBe(1);
  });

  // The runbook's removal block clears the journal first and locks the
  // request last. A repeat post therefore waits only for the deletes, not for
  // journal statements that can scan a large journal past the publish bound.
  it('answers a repeat at once while the removal block is still clearing the journal', async () => {
    const runbook = readFileSync(new URL('../../docs/operations.md', import.meta.url), 'utf8');
    const at = runbook.indexOf('#### Removing a document written from a case');
    const block = /```sql\n([\s\S]*?)```/.exec(runbook.slice(at))![1]!;
    const c = await caseOf('closed');
    const first = await publishDocument(pool, input(c.runId));
    const firstId = (first as { docId: string }).docId;
    // A compose row that cites the document, held by another session, so the
    // block stops at its journal statements.
    await pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, 'compose', 'done', $2::jsonb, 'p1', 'm1', 0)`,
      [c.runId, JSON.stringify({ citedBodies: { [firstId]: 'the body' } })],
    );
    const holder = await pool.connect();
    const remover = await pool.connect();
    let removal: Promise<unknown> | undefined;
    const broken = { holder: false, remover: false };
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM step_journal WHERE run_id = $1 AND step_id = 'compose' FOR UPDATE`, [c.runId]);
      const pid = (await remover.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      removal = remover.query(block.replaceAll('<doc-id>', firstId)).then(() => null, (error: unknown) => error);
      let stopped = false;
      for (let tries = 0; tries < 200 && !stopped; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        // Match the remover by its process id, because the server keeps
        // only the first part of a long statement's text.
        const { rows } = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'`, [pid],
        );
        stopped = rows.length > 0;
      }
      expect(stopped, 'the block never waited on the held journal row').toBe(true);
      expect(await publishDocument(pool, input(c.runId, { timeoutMs: 3000 })))
        .toMatchObject({ outcome: 'published', docId: firstId, repeated: true });
      await holder.query('COMMIT');
      expect(await removal).toBeNull();
    } finally {
      await holder.query('ROLLBACK').catch(() => { broken.holder = true; });
      holder.release(broken.holder);
      await removal;
      await remover.query('ROLLBACK').catch(() => { broken.remover = true; });
      remover.release(broken.remover);
    }
    expect(await documents()).toBe(0);
  });

  it('rejects, and ends no process, when the ledger ends its session mid-publish', async () => {
    const guarded = guardLedgerPool(new Pool({ connectionString: dbUrl(), max: 1 }), () => undefined);
    const holder = await pool.connect();
    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => { uncaught.push(error); };
    process.on('uncaughtException', onUncaught);
    try {
      const c = await caseOf('escalated');
      // Hold the run's row, so the publish waits on it with its session open.
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM run WHERE run_id = $1 FOR UPDATE', [c.runId]);
      // Captured at once, since it can reject while this test awaits the kill.
      const publishing = publishDocument(guarded, input(c.runId)).then(() => null, (error: unknown) => error);
      let waiting: number | undefined;
      for (let tries = 0; tries < 50 && waiting === undefined; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const { rows } = await pool.query<{ pid: number }>(
          `SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%FROM run WHERE run_id = $1 FOR UPDATE%'
              AND pid <> $1::int`,
          [(await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid],
        );
        waiting = rows[0]?.pid;
      }
      expect(waiting).toBeDefined();
      await pool.query('SELECT pg_terminate_backend($1)', [waiting]);
      expect(await publishing).toBeInstanceOf(Error);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(uncaught).toEqual([]);
      await holder.query('ROLLBACK');
      expect(await documents()).toBe(0);
    } finally {
      process.off('uncaughtException', onUncaught);
      holder.release();
      await guarded.end();
    }
  });

  it("reads a turnless run's queued message id", async () => {
    const alone = await caseOf('escalated', { turn: false });
    await pool.query(
      `INSERT INTO intake (ticket_id, message_id, partition, ticket_text)
       VALUES ($1, '<queued-9@mail.example>', 0, 'a queued question')`,
      [alone.ticketId],
    );
    expect(await publishDocument(pool, input(alone.runId, { body: 'Quoted from <queued-9@mail.example>.' })))
      .toEqual({ outcome: 'identifier', field: 'body', kind: 'message' });
  });

  it('answers busy, and writes nothing, when another write holds the case past the bound', async () => {
    const c = await caseOf('escalated');
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM run WHERE run_id = $1 FOR UPDATE', [c.runId]);
      expect(await publishDocument(pool, { ...input(c.runId), timeoutMs: 200 })).toEqual({ outcome: 'busy' });
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    expect(await documents()).toBe(0);
  });

  it('refuses an unknown run', async () => {
    expect(await publishDocument(pool, input(randomUUID()))).toEqual({ outcome: 'unknown_run' });
  });
});
