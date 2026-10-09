// The erasure path the runbook publishes, run against the ledger.
//
// `docs/operations.md` gives an adopter the statements that clear customer
// text by age, and claims each one leaves the keys a reader joins on. Both
// halves are testable and neither was tested: a statement that does not parse
// is a runbook that fails at the worst moment, and a statement that clears a
// key would leave a surface unable to name the turn it just emptied.
//
// The statements are read out of the runbook rather than restated here. A
// copy would drift, and the copy that matters is the one an adopter runs.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl, readerDbUrl } from '../db/config.js';
import { truncateLedger } from '../test-support/schema.js';
import { readRunJournal } from '../journal/query.js';
import { PARKED_RUN_STATES, TERMINAL_RUN_STATE_NAMES } from '../ledger/run-state.js';
import { RERUN_STALE_HOURS } from '../knowledge/rerun.js';
import { readConversation } from './query.js';

const pool = new Pool({ connectionString: dbUrl(), max: 4 });
// The readers connect as the role that cannot act beyond a read.
const readers = new Pool({ connectionString: readerDbUrl(), max: 4 });
const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/**
 * The statements the runbook publishes, in the order it publishes them.
 *
 * Taken from the fenced block under the retention heading. A block that stops
 * being there fails the non-vacuity check below rather than passing silently.
 */
function publishedStatements(): string[] {
  return sqlBlockAfter('### What the ledger stores about a customer')
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** The first `sql` block after a runbook heading. */
function sqlBlockAfter(heading: string): string {
  const runbook = readFileSync(`${REPO_ROOT}docs/operations.md`, 'utf8');
  const at = runbook.indexOf(heading);
  expect(at, `the runbook has no heading ${heading}`).toBeGreaterThan(-1);
  const block = /```sql\n([\s\S]*?)```/.exec(runbook.slice(at));
  expect(block, `the section ${heading} holds no sql block`).not.toBeNull();
  return block![1]!;
}

/**
 * The run states a statement names in its first `state IN (...)` or
 * `state NOT IN (...)` list. The runbook spells them out, so a state the
 * ledger adds would otherwise leave the statement behind without a failure.
 */
function statesNamed(sql: string, pattern: RegExp): string[] {
  const list = pattern.exec(sql);
  expect(list, `no state list matches ${pattern}`).not.toBeNull();
  return [...list![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
}

afterAll(async () => {
  await readers.end();
  await pool.end();
});


beforeEach(async () => {
  await truncateLedger(pool);
});

const OLD = "now() - interval '400 days'";

async function seedOldConversation(): Promise<{
  conversationId: string;
  runId: string;
  refusedRun: string;
}> {
  const conversationId = randomUUID();
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO conversation (conversation_id, primary_ticket_id, customer_address, state, opened_at)
     VALUES ($1, 'SYN-1', 'ada@customer.example', 'open', ${OLD})`,
    [conversationId],
  );
  await pool.query(
    `INSERT INTO turn (conversation_id, turn_number, ticket_id, body_text, approved_reply_text,
                       saved_reply_text, saved_reply_by, saved_reply_by_source, created_at)
     VALUES ($1, 1, 'SYN-1', 'the customer wrote this', 'and we answered that',
             'a saved edit for the customer', 'reviewer@example.test', 'roster', ${OLD})`,
    [conversationId],
  );
  await pool.query(
    `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                      cost_micros, steps_used, deadline_at, conversation_id, turn_number,
                      created_at, send_back_note)
     VALUES ($1, 'SYN-1', 0, 1, 'resolved', 'p', 'm', 0, 0, now(), $2, 1, ${OLD},
             'ada@customer.example asked twice, so answer both')`,
    [runId, conversationId],
  );
  // The reply a sent record carried, when the ledger held it rather than the
  // helpdesk (DEC-44). The relay has sent it, so the text has done its work.
  await pool.query(
    `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery,
                         payload, status, reply)
     VALUES ($1, 'approve', 'retention-sent-reply', 1, 'customer_reply', 'at_most_once',
             '{}'::jsonb, 'sent', $2::jsonb)`,
    [runId, JSON.stringify({
      bodyText: 'the reply the ledger sent to ada@customer.example',
      disclosure: 'drafted by an assistant', provenance: {},
    })],
  );
  // A record the relay is done with in every other way: each finished status
  // keeps a reply nothing reads again, so the purge clears each one.
  for (const status of ['fenced', 'delivery_unknown', 'malformed', 'not_sent']) {
    await pool.query(
      `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery,
                           payload, status, reply)
       VALUES ($1, $2, $3, 1, 'customer_reply', 'at_most_once', '{}'::jsonb, $4, $5::jsonb)`,
      [runId, `approve_${status}`, `retention-${status}-reply`, status, JSON.stringify({
        bodyText: `a finished reply the relay left as ${status}`,
        disclosure: 'drafted by an assistant', provenance: {},
      })],
    );
  }
  // A record the relay still owes. It is as old as the rest, and the purge
  // must leave its reply, or the relay refuses it as malformed and the
  // approved reply never goes out.
  await pool.query(
    `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery,
                         payload, status, reply)
     VALUES ($1, 'approve_pending', 'retention-pending-reply', 1, 'customer_reply',
             'at_most_once', '{}'::jsonb, 'pending', $2::jsonb)`,
    [runId, JSON.stringify({
      bodyText: 'a pending reply the relay still owes',
      disclosure: 'drafted by an assistant', provenance: {},
    })],
  );
  // The note a reviewer sent the case back with (DEC-49). It is written
  // twice: on the run, where the next attempt reads it, and in the journal
  // row that records who asked. A statement that cleared one and not the
  // other would leave the words a reader sees.
  await pool.query(
    `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
     VALUES ($1, 'send_back', 'done', $2::jsonb, 'p', 'm', 0)`,
    [runId, JSON.stringify({
      note: 'ada@customer.example asked twice, so answer both',
      reviewer: 'reviewer@example.test', reviewerSource: 'roster', attempt: 1,
      // DEC-49: the reply a person saved on the turn belongs to the attempt a
      // reviewer rejects, so the send-back clears it and records what it
      // cleared. A statement that reached the note and not this would leave
      // the person's own words behind.
      clearedReply: 'a reply a person saved, quoting ada@customer.example',
      // DEC-50: a reviewer's document asked for this attempt, and its title is
      // the reviewer's own words about the case.
      documentTitle: 'a title a reviewer wrote from the case',
    })],
  );
  await pool.query(
    `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
     VALUES ($1, 'park', 'done', $2::jsonb, 'p', 'm', 0)`,
    [runId, JSON.stringify({
      draftExternalId: 'hd-1', actionClass: 'send_reply', delivery: 'at_most_once',
      body: 'the drafted reply', turnNumber: 1,
    })],
  );
  await pool.query(
    `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
     VALUES ($1, 'compose', 'done', $2::jsonb, 'p', 'm', 0)`,
    [runId, JSON.stringify({
      abstained: false, claimCount: 2, staleDocumentIds: [], provider: 'stub',
      // Both keys on one row, deliberately. `sentences` is what a run writes
      // today (DEC-43) and `claims` is what every run before it wrote, and a
      // statement that reached one and not the other would clear the ledger
      // for half of its own history.
      sentences: [
        { text: 'the courtesy opening', docId: null },
        { text: 'the first sentence of the reply', docId: 'SYN-1' },
      ],
      claims: [{ text: 'the first claim', docId: 'SYN-1' }],
      citedBodies: { 'SYN-1': 'the document body' },
    })],
  );
  // The two rows that hold an address rather than a message. The relay
  // interpolates whatever an adapter threw, and an SMTP rejection quotes the
  // recipient; the adapter's own fault names the expected one. A statement
  // that reached neither would leave an address behind while the section
  // above it said every place was named.
  await pool.query(
    `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
     VALUES ($1, 'escalate', 'done', $2::jsonb, 'p', 'm', 0)`,
    [runId, JSON.stringify({
      reason: 'delivery_unknown: 550 no such user ada@customer.example',
    })],
  );
  const refusedRun = randomUUID();
  await pool.query(
    `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                      cost_micros, steps_used, deadline_at, conversation_id, turn_number, created_at)
     VALUES ($1, 'SYN-1', 0, 1, 'escalated', 'p', 'm', 0, 0, now(), $2, 1, ${OLD})`,
    [refusedRun, conversationId],
  );
  await pool.query(
    `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
     VALUES ($1, 'park', 'failed', $2::jsonb, 'p', 'm', 0)`,
    [refusedRun, JSON.stringify({
      actionClass: 'send_reply', delivery: 'at_most_once', parkKey: 'k',
      error: 'expected ada@customer.example but the thread is from bob@customer.example',
    })],
  );
  return { conversationId, runId, refusedRun };
}

async function runPublished(): Promise<void> {
  for (const statement of publishedStatements()) {
    await pool.query(statement);
  }
}

/**
 * The runbook's block that removes one document written from a case, with
 * its placeholder filled in. Read from the runbook, so the test runs what an
 * adopter copies.
 */
function removalBlock(docId: string): string {
  return sqlBlockAfter('#### Removing a document written from a case').replaceAll('<doc-id>', docId);
}

/**
 * Runs the block on a client of its own, so a refusal cannot poison the pool.
 * Returns the error the block raised, or null. A rollback that fails too
 * discards the client rather than return a broken one to the pool, and the
 * block's own error is still the one returned.
 */
async function runRemoval(
  docId: string,
  onClient?: (pid: number) => void,
  onRemovedAt?: (at: Date) => void,
): Promise<unknown> {
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    return error;
  }
  let broken = false;
  try {
    if (onClient) {
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      onClient(rows[0]!.pid);
    }
    const results = await client.query(removalBlock(docId)) as unknown as { rows: { removed_at?: Date }[] }[];
    const printed = results.flatMap((result) => result.rows).find((row) => row.removed_at !== undefined);
    if (onRemovedAt && printed?.removed_at) onRemovedAt(printed.removed_at);
    return null;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    return error;
  } finally {
    client.release(broken);
  }
}

type CaseRerun =
  | { status: 'dropped' }
  | { status: 'waiting' }
  // `attemptRun` is the state of a run at the attempt the request started,
  // or absent when no such run exists yet.
  | { status: 'started'; attemptRun?: string };

async function seedCaseDocument(rerun: CaseRerun): Promise<string> {
  const conversationId = randomUUID();
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO conversation (conversation_id, primary_ticket_id, customer_address)
     VALUES ($1, 'SYN-9', 'erin@customer.example')`,
    [conversationId],
  );
  await pool.query(
    `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                      cost_micros, steps_used, deadline_at, conversation_id, turn_number)
     VALUES ($1, 'SYN-9', 0, 1, 'resolved', 'p', 'm', 0, 0, now(), $2, 1)`,
    [runId, conversationId],
  );
  for (const [docId, title, source, writer] of [
    ['case-doc', 'a title from the case', 'console', 'reviewer@example.test'],
    ['corpus-doc', 'a corpus title', 'loader', null],
  ] as const) {
    await pool.query(
      `INSERT INTO document (doc_id, kind, title, body, owner, review_by, source, embedding_status, written_by)
       VALUES ($1, 'document', $2, $3, 'synthetic-owner', '2999-01-01', $4, 'pending', $5)`,
      [docId, title, `the body of ${docId}`, source, writer],
    );
  }
  const journal = [
    ['retrieve', { documents: [
      { docId: 'case-doc', title: 'a title from the case', owner: 'o' },
      { docId: 'corpus-doc', title: 'a corpus title', owner: 'o' },
    ] }],
    ['compose', { claimCount: 2, citedBodies: { 'case-doc': 'the body of case-doc', 'corpus-doc': 'the body of corpus-doc' } }],
    ['send_back', { attempt: 1, document: 'case-doc', documentTitle: 'a title from the case' }],
  ] as const;
  for (const [stepId, result] of journal) {
    await pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, $2, 'done', $3::jsonb, 'p', 'm', 0)`,
      [runId, stepId, JSON.stringify(result)],
    );
  }
  const insert = {
    started: `INSERT INTO document_rerun (doc_id, run_id, conversation_id, turn_number, attempt, status, ended_at, started_attempt)
              VALUES ('case-doc', $1, $2, 1, 1, 'started', now(), 2)`,
    waiting: `INSERT INTO document_rerun (doc_id, run_id, conversation_id, turn_number, attempt)
              VALUES ('case-doc', $1, $2, 1, 1)`,
    dropped: `INSERT INTO document_rerun (doc_id, run_id, conversation_id, turn_number, attempt, status, reason, ended_at)
              VALUES ('case-doc', $1, $2, 1, 1, 'dropped', 'ended', now())`,
  }[rerun.status];
  await pool.query(insert, [runId, conversationId]);
  if (rerun.status === 'started' && rerun.attemptRun !== undefined) {
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        cost_micros, steps_used, deadline_at, conversation_id, turn_number, attempt)
       VALUES ($1, 'SYN-9', 0, 1, $3, 'p', 'm', 0, 0, now(), $2, 1, 2)`,
      [randomUUID(), conversationId, rerun.attemptRun],
    );
  }
  return runId;
}

/** The ids of every document, and the journal rows that still hold the case title. */
async function untouched(): Promise<{ docs: string[]; titled: number }> {
  const docs = await pool.query<{ doc_id: string }>('SELECT doc_id FROM document ORDER BY doc_id');
  const titles = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM step_journal WHERE result::text LIKE '%a title from the case%'`,
  );
  return { docs: docs.rows.map((row) => row.doc_id), titled: titles.rows[0]!.n };
}

describe('the removal of a document written from a case', () => {
  it('clears every copy the journal keeps, and leaves other documents whole', async () => {
    const runId = await seedCaseDocument({ status: 'dropped' });
    expect(await runRemoval('case-doc')).toBeNull();
    const docs = await pool.query<{ doc_id: string }>('SELECT doc_id FROM document ORDER BY doc_id');
    expect(docs.rows.map((row) => row.doc_id)).toEqual(['corpus-doc']);
    const reruns = await pool.query('SELECT 1 FROM document_rerun');
    expect(reruns.rows).toEqual([]);
    const journal = await pool.query<{ step_id: string; result: Record<string, unknown> }>(
      'SELECT step_id, result FROM step_journal WHERE run_id = $1', [runId],
    );
    const result = new Map(journal.rows.map((row) => [row.step_id, row.result]));
    expect(result.get('retrieve')).toEqual({ documents: [
      { docId: 'case-doc', owner: 'o' },
      { docId: 'corpus-doc', title: 'a corpus title', owner: 'o' },
    ] });
    expect(result.get('compose')).toEqual({ claimCount: 2, citedBodies: { 'corpus-doc': 'the body of corpus-doc' } });
    expect(result.get('send_back')).toEqual({ attempt: 1, document: 'case-doc' });
  });

  // The attempt has landed only when a run at it is parked or terminal, as
  // the consumer's scan reads it. A run still walking, or one that died
  // mid-walk, still needs the request that points the scan at the turn.
  for (const attemptRun of [undefined, 'received', 'composed', 'executing']) {
    it(`refuses while the attempt the document asked for has ${attemptRun ?? 'no run'}, and changes nothing`, async () => {
      await seedCaseDocument({ status: 'started', ...(attemptRun ? { attemptRun } : {}) });
      expect(String(await runRemoval('case-doc'))).toMatch(/has not landed/);
      expect(await untouched()).toEqual({ docs: ['case-doc', 'corpus-doc'], titled: 2 });
    });
  }

  for (const attemptRun of ['awaiting_approval', 'resolved', 'escalated']) {
    it(`removes the document once the attempt it asked for has landed as ${attemptRun}`, async () => {
      await seedCaseDocument({ status: 'started', attemptRun });
      expect(await runRemoval('case-doc')).toBeNull();
      expect(await untouched()).toEqual({ docs: ['corpus-doc'], titled: 0 });
    });
  }

  // These cases run the runbook's follow-up queries. The test reads each one
  // from the runbook, and seeds a row the query must leave out as well as one
  // it finds.
  it('notes the case, finds what the case published, and finds a copy a run wrote late', async () => {
    const runId = await seedCaseDocument({ status: 'dropped' });
    const { rows: [seeded] } = await pool.query<{ conversation_id: string }>(
      'SELECT conversation_id FROM run WHERE run_id = $1', [runId],
    );
    const conversationId = seeded!.conversation_id;
    // This is another case's document. It has the same title, its own request
    // and a send-back row. No query about this case may name it.
    const otherRun = randomUUID();
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        cost_micros, steps_used, deadline_at)
       VALUES ($1, 'SYN-8', 0, 1, 'resolved', 'p', 'm', 0, 0, now())`, [otherRun],
    );
    await pool.query(
      `INSERT INTO document (doc_id, kind, title, body, owner, review_by, source, embedding_status, written_by)
       VALUES ('other-doc', 'document', 'a title from the case', 'b', 'synthetic-owner', '2999-01-01', 'console', 'pending', 'reviewer@example.test')`,
    );
    await pool.query(
      `INSERT INTO document_rerun (doc_id, run_id, attempt, status, reason, ended_at)
       VALUES ('other-doc', $1, 1, 'dropped', 'ended', now())`, [otherRun],
    );
    await pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, 'send_back', 'done', $2::jsonb, 'p', 'm', 0)`,
      [otherRun, JSON.stringify({ document: 'other-doc', documentTitle: 'a title from the case' })],
    );

    const noted = await pool.query(sqlBlockAfter('So note the case before you run the block').replaceAll('<doc-id>', 'case-doc'));
    expect(noted.rows).toEqual([{ run_id: runId }]);

    expect(await runRemoval('case-doc')).toBeNull();
    // After the block, the note query finds nothing: the request is gone.
    expect((await pool.query(sqlBlockAfter('So note the case before you run the block').replaceAll('<doc-id>', 'case-doc'))).rows).toEqual([]);
    const copies = async (): Promise<unknown[]> => (await pool.query(
      sqlBlockAfter('lists each journal row that still holds a copy').replaceAll('<doc-id>', 'case-doc'),
    )).rows;
    expect(await copies()).toEqual([]);

    // A run that walks during the block writes each of its three copies late.
    for (const [stepId, result] of [
      ['retrieve', { documents: [{ docId: 'case-doc', title: 'a title from the case', owner: 'o' }] }],
      ['compose', { citedBodies: { 'case-doc': 'the body of case-doc' } }],
      ['send_back', { attempt: 1, document: 'case-doc', documentTitle: 'a title from the case' }],
    ] as const) {
      await pool.query(
        'UPDATE step_journal SET result = $3::jsonb WHERE run_id = $1 AND step_id = $2',
        [runId, stepId, JSON.stringify(result)],
      );
    }
    const late = (await copies()) as { step_id: string }[];
    expect(late.map((row) => row.step_id).sort()).toEqual(['compose', 'retrieve', 'send_back']);
    // The runbook's answer: run the block's three journal statements again.
    for (const statement of removalBlock('case-doc').split(';').map((one) => one.trim())) {
      if (statement.startsWith('UPDATE step_journal') && !statement.includes('run_id IN')) await pool.query(statement);
    }
    expect(await copies()).toEqual([]);

    // Every document the case publishes again, whatever its title, and from
    // a later run of the same conversation too.
    const published = async (run = runId): Promise<string[]> => (await pool.query<{ doc_id: string }>(
      sqlBlockAfter('After the block commits, this query lists every document').replaceAll('<run-id>', run),
    )).rows.map((row) => row.doc_id);
    expect(await published()).toEqual([]);
    const laterRun = randomUUID();
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        cost_micros, steps_used, deadline_at, conversation_id, turn_number)
       VALUES ($1, 'SYN-9', 0, 1, 'resolved', 'p', 'm', 0, 0, now(), $2, 2)`, [laterRun, conversationId],
    );
    // A run from before conversations has none, so the query finds its
    // documents by the run alone.
    const loneRun = randomUUID();
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        cost_micros, steps_used, deadline_at)
       VALUES ($1, 'SYN-5', 0, 1, 'resolved', 'p', 'm', 0, 0, now())`, [loneRun],
    );
    for (const [docId, title, onRun, conversation] of [
      ['case-doc-2', 'a title from the case', runId, conversationId],
      ['case-doc-3', 'a title the reviewer changed', laterRun, conversationId],
      ['lone-doc', 'a title from the case', loneRun, null],
    ] as const) {
      await pool.query(
        `INSERT INTO document (doc_id, kind, title, body, owner, review_by, source, embedding_status, written_by)
         VALUES ($1, 'document', $2, 'b', 'synthetic-owner', '2999-01-01', 'console', 'pending', 'reviewer@example.test')`,
        [docId, title],
      );
      await pool.query(
        `INSERT INTO document_rerun (doc_id, run_id, conversation_id, turn_number, attempt, status, reason, ended_at)
         VALUES ($1, $2, $3, 1, 1, 'dropped', 'ended', now())`, [docId, onRun, conversation],
      );
    }
    expect((await published()).sort()).toEqual(['case-doc-2', 'case-doc-3']);
    expect(await published(loneRun)).toEqual(['lone-doc']);
  });

  // A run that walks past the code's own bound has stopped mid-walk, and
  // writes nothing more. The query leaves it out, so the operator's wait ends.
  it('lists each run still walking, and no run that parked, ended or died', async () => {
    await seedCaseDocument({ status: 'dropped' });
    const walking = randomUUID();
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        cost_micros, steps_used, deadline_at, created_at)
       VALUES ($1, 'SYN-7', 0, 1, 'composed', 'p', 'm', 0, 0, now(), now()),
              ($2, 'SYN-7', 0, 1, 'gated', 'p', 'm', 0, 0, now(),
               now() - interval '${String(RERUN_STALE_HOURS + 1)} hours')`,
      [walking, randomUUID()],
    );
    // One recent run in each state that parks or ends.
    for (const state of [...PARKED_RUN_STATES, ...TERMINAL_RUN_STATE_NAMES]) {
      await pool.query(
        `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                          cost_micros, steps_used, deadline_at, created_at)
         VALUES ($1, 'SYN-7', 0, 1, $2, 'p', 'm', 0, 0, now(), now())`,
        [randomUUID(), state],
      );
    }
    const query = sqlBlockAfter('lists each run that is still walking');
    const { rows } = await pool.query<{ run_id: string }>(query);
    expect(rows.map((row) => row.run_id)).toEqual([walking]);
    expect(statesNamed(query, /state NOT IN \(([^)]*)\)/))
      .toEqual([...PARKED_RUN_STATES, ...TERMINAL_RUN_STATE_NAMES].sort());
    expect(query).toContain(`interval '${String(RERUN_STALE_HOURS)} hours'`);
  });

  // An attempt of the request's own turn can write its copies while the
  // block's first journal statements run. Each statement reads the journal
  // before that write. The block clears that turn's runs again once it holds
  // the lock.
  it('clears a copy the request\'s attempt writes while the block clears the journal', async () => {
    const runId = await seedCaseDocument({ status: 'dropped' });
    const { rows: [seeded] } = await pool.query<{ conversation_id: string }>(
      'SELECT conversation_id FROM run WHERE run_id = $1', [runId],
    );
    // Another session locks a send_back row elsewhere that names the
    // document, so the block stops at its last first-pass statement.
    const elsewhere = randomUUID();
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        cost_micros, steps_used, deadline_at)
       VALUES ($1, 'SYN-6', 0, 1, 'resolved', 'p', 'm', 0, 0, now())`, [elsewhere],
    );
    await pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, 'send_back', 'done', $2::jsonb, 'p', 'm', 0)`,
      [elsewhere, JSON.stringify({ attempt: 1, document: 'case-doc', documentTitle: 'a title from the case' })],
    );
    const attempt = randomUUID();
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        cost_micros, steps_used, deadline_at, conversation_id, turn_number, attempt)
       VALUES ($1, 'SYN-9', 0, 1, 'awaiting_approval', 'p', 'm', 0, 0, now(), $2, 1, 2)`,
      [attempt, seeded!.conversation_id],
    );
    const holder = await pool.connect();
    let removal: Promise<unknown> | undefined;
    let broken = false;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM step_journal WHERE run_id = $1 AND step_id = 'send_back' FOR UPDATE`, [elsewhere]);
      let removerPid = 0;
      let removedAt: Date | undefined;
      let ended = false;
      removal = runRemoval('case-doc', (pid) => { removerPid = pid; }, (at) => { removedAt = at; })
        .then((result) => { ended = true; return result; });
      for (let tries = 0; ; tries += 1) {
        // A block that fails before it waits names its own error.
        if (ended) expect(await removal).toBeNull();
        const { rows } = await pool.query<{ waiting: boolean }>(
          `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`, [removerPid],
        );
        if (rows[0]?.waiting === true) break;
        expect(tries, 'the block never stopped at its send_back statement').toBeLessThan(200);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // A run on another conversation starts while the block waits. It can
      // read the document and write a copy after the commit, so the
      // runbook's wait must count it.
      const during = randomUUID();
      await pool.query(
        `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                          cost_micros, steps_used, deadline_at)
         VALUES ($1, 'SYN-4', 0, 1, 'retrieved', 'p', 'm', 0, 0, now())`, [during],
      );
      // The attempt writes its three copies now, after each first-pass
      // statement reads the journal. Its send_back row is the one the
      // consumer writes when it starts the request.
      for (const [stepId, result] of [
        ['retrieve', { documents: [{ docId: 'case-doc', title: 'a title from the case', owner: 'o' }] }],
        ['compose', { citedBodies: { 'case-doc': 'the body of case-doc' } }],
        ['send_back', { attempt: 2, document: 'case-doc', documentTitle: 'a title from the case' }],
      ] as const) {
        await pool.query(
          `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
           VALUES ($1, $2, 'done', $3::jsonb, 'p', 'm', 0)`,
          [attempt, stepId, JSON.stringify(result)],
        );
      }
      await holder.query('COMMIT');
      expect(await removal).toBeNull();
      // The block prints the time it commits. Each run created before it
      // is one the wait still counts, the run that started during the block
      // included.
      expect(removedAt, 'the block printed no commit time').toBeInstanceOf(Date);
      const walking = await pool.query<{ run_id: string; created_at: Date }>(
        sqlBlockAfter('lists each run that is still walking'),
      );
      const counted = walking.rows.filter((row) => row.created_at < removedAt!).map((row) => row.run_id);
      expect(counted).toContain(during);
    } finally {
      await holder.query('ROLLBACK').catch(() => { broken = true; });
      holder.release(broken);
      await removal;
    }
    // The block's send_back statement reads the locked row before it waits,
    // so it clears that row once the holder commits. The attempt's rows
    // arrive after the first pass reads the journal, and only the second
    // pass over the request's turn clears them.
    const { rows } = await pool.query<{ step_id: string }>(
      sqlBlockAfter('lists each journal row that still holds a copy').replaceAll('<doc-id>', 'case-doc'),
    );
    expect(rows).toEqual([]);
  });

  it('names the states the consumer counts as landed', () => {
    const block = removalBlock('case-doc');
    expect(statesNamed(block, /r\.state IN \(([^)]*)\)/))
      .toEqual([...PARKED_RUN_STATES, ...TERMINAL_RUN_STATE_NAMES].sort());
  });

  it('refuses an id that names no document written from a case, and changes nothing', async () => {
    await seedCaseDocument({ status: 'dropped' });
    for (const docId of ['no-such-doc', 'corpus-doc']) {
      expect(String(await runRemoval(docId)), docId).toMatch(/names no document written from a case/);
    }
    expect(await untouched()).toEqual({ docs: ['case-doc', 'corpus-doc'], titled: 2 });
  });

  // The consumer takes a waiting request with a row lock, marks it started
  // and raises the turn. The block must read the request after that commits,
  // or it deletes a request whose attempt has not landed.
  it('waits for a request the consumer is starting, then refuses it', async () => {
    await seedCaseDocument({ status: 'waiting' });
    const consumer = await pool.connect();
    let removal: Promise<unknown> | undefined;
    try {
      await consumer.query('BEGIN');
      await consumer.query(`SELECT 1 FROM document_rerun WHERE doc_id = 'case-doc' FOR UPDATE`);
      await consumer.query(
        `UPDATE document_rerun SET status = 'started', ended_at = now(), started_attempt = 2
          WHERE doc_id = 'case-doc'`,
      );
      let removerPid = 0;
      removal = runRemoval('case-doc', (pid) => { removerPid = pid; });
      // The block is blocked on the consumer's lock before the consumer commits.
      for (let tries = 0; ; tries += 1) {
        const { rows } = await pool.query<{ waiting: boolean }>(
          `SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1`, [removerPid],
        );
        if (rows[0]?.waiting === true) break;
        expect(tries, 'the block never waited on the consumer\'s lock').toBeLessThan(200);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await consumer.query('COMMIT');
      expect(String(await removal)).toMatch(/has not landed/);
    } finally {
      // A failed wait leaves the consumer's lock held. A release here keeps
      // the lock while the connection idles in the pool. The pool's idle
      // timeout closes it, and the block waits that long. Rolling back frees
      // the block at once. A connection whose rollback fails is discarded.
      let broken = false;
      await consumer.query('ROLLBACK').catch(() => { broken = true; });
      consumer.release(broken);
      await removal;
    }
    expect(await untouched()).toEqual({ docs: ['case-doc', 'corpus-doc'], titled: 2 });
  });
});

describe('the erasure path the runbook publishes', () => {
  it('publishes statements the ledger accepts', async () => {
    const statements = publishedStatements();
    // Five: the turn, the journal, the note a reviewer sent a case back
    // with, the reply a finished record carried, and the participant.
    // Non-vacuity, because a block that lost one would otherwise pass every
    // case below.
    expect(statements).toHaveLength(5);
    await seedOldConversation();
    await runPublished();
  });

  it('clears every place a customer\'s words are held', async () => {
    const { conversationId, runId } = await seedOldConversation();
    await runPublished();

    const thread = await readConversation(readers, conversationId);
    expect(thread?.turns[0]?.bodyText).toBeNull();
    expect(thread?.turns[0]?.replyText).toBeNull();
    expect(thread?.participantNamed).toBe(false);

    const journal = await readRunJournal(readers, runId);
    const park = journal?.steps.find((step) => step.stepId === 'park')?.park;
    const compose = journal?.steps.find((step) => step.stepId === 'compose')?.compose;
    expect(park?.draftBody).toBeNull();
    expect(compose?.sentences).toBeNull();
    expect(compose?.claims).toBeNull();
    expect(compose?.citedBodies).toBeNull();

    // Read off the ledger, not off a reader.
    //
    // A sweep over `readRunJournal`'s output sees only the fields it
    // projects, and it deliberately projects neither the fault message nor
    // the action payload. So a key the statements missed would be invisible
    // to it — which is exactly how an escalation reason holding a recipient
    // address survived a section claiming every place was named.
    const raw = await pool.query(
      `SELECT coalesce(string_agg(result::text, ' '), '') AS journal FROM step_journal`,
    );
    const columns = await pool.query(
      `SELECT coalesce(string_agg(concat_ws(' ', body_text, approved_reply_text, saved_reply_text), ' '), '') AS turns
         FROM turn`,
    );
    // The saved reply goes with the name of who saved it (DEC-45): the
    // statement clears both, and the ledger accepts the pair cleared.
    const saver = await pool.query(
      'SELECT saved_reply_by AS by, saved_reply_by_source AS source FROM turn WHERE conversation_id = $1',
      [conversationId],
    );
    expect(saver.rows).toEqual([{ by: null, source: null }]);
    const addresses = await pool.query(
      `SELECT coalesce(string_agg(customer_address, ' '), '') AS named FROM conversation`,
    );
    const sent = await pool.query(
      `SELECT coalesce(string_agg(reply::text, ' '), '') AS replies FROM outbox
        WHERE status <> 'pending'`,
    );
    const everything = [
      (sent.rows[0] as { replies: string }).replies,
      (raw.rows[0] as { journal: string }).journal,
      (columns.rows[0] as { turns: string }).turns,
      (addresses.rows[0] as { named: string }).named,
    ].join(' ');
    for (const cleared of [
      'asked twice, so answer both',
      'a reply a person saved, quoting ada@customer.example',
      'the customer wrote this', 'and we answered that', 'a saved edit for the customer',
      'the drafted reply', 'the reply the ledger sent', 'a finished reply the relay left as',
      'a title a reviewer wrote from the case',
      'the first claim', 'the courtesy opening', 'the first sentence of the reply',
      'the document body', 'ada@customer.example',
      'bob@customer.example', '550 no such user',
    ]) {
      expect(everything, cleared).not.toContain(cleared);
    }
  });

  // The runbook's own claim: the outbox statement clears the text of a record
  // the relay is done with, keeps the record, and leaves one it still owes.
  it('leaves a reply the relay still has to send, and keeps every record', async () => {
    await seedOldConversation();
    await runPublished();
    const { rows } = await pool.query<{ status: string; reply: { bodyText: string } | null }>(
      'SELECT status, reply FROM outbox ORDER BY status',
    );
    expect(rows.map((row) => row.status).sort()).toEqual(
      ['delivery_unknown', 'fenced', 'malformed', 'not_sent', 'pending', 'sent'],
    );
    for (const row of rows) {
      if (row.status === 'pending') {
        expect(row.reply?.bodyText).toBe('a pending reply the relay still owes');
      } else {
        expect(row.reply, `the ${row.status} record keeps its reply`).toBeNull();
      }
    }
  });

  // The runbook's own claim: each statement leaves the keys a reader joins on.
  // A cleared row that stopped rendering would take the turn off the surface
  // rather than emptying it, and an operator would read a conversation that
  // had lost a message the customer sent.
  it('leaves every key a reader joins on', async () => {
    const { conversationId, runId, refusedRun } = await seedOldConversation();
    await runPublished();

    const thread = await readConversation(readers, conversationId);
    // The turn is still there, and it names why it is empty.
    expect(thread?.turns).toHaveLength(1);
    expect(thread?.turns[0]?.turnNumber).toBe(1);
    expect(thread?.turns[0]?.ticketId).toBe('SYN-1');
    expect(thread?.turns[0]?.messageAbsence).toBe('not_retained');
    // The run that last worked the turn, which is the refused one. Two runs
    // share this turn because a park row is unique per run, so the refusal
    // needed its own — and the lateral join takes the newest by design.
    expect(thread?.turns[0]?.runId).toBe(refusedRun);
    expect(thread?.turns[0]?.runAttempts).toBe(2);

    const journal = await readRunJournal(readers, runId);
    const park = journal?.steps.find((step) => step.stepId === 'park')?.park;
    // The approval derives its idempotency key from these (DEC-24, DEC-38).
    expect(park?.draftExternalId).toBe('hd-1');
    expect(park?.actionClass).toBe('send_reply');
    expect(park?.turnNumber).toBe(1);
    // The coverage a gate recorded still has a denominator.
    const compose = journal?.steps.find((step) => step.stepId === 'compose')?.compose;
    expect(compose?.claimCount).toBe(2);
  });

  it('leaves a row younger than the window alone', async () => {
    const conversationId = randomUUID();
    await pool.query(
      `INSERT INTO conversation (conversation_id, primary_ticket_id, customer_address, state)
       VALUES ($1, 'SYN-2', 'bob@customer.example', 'open')`,
      [conversationId],
    );
    await pool.query(
      `INSERT INTO turn (conversation_id, turn_number, ticket_id, body_text)
       VALUES ($1, 1, 'SYN-2', 'written today')`,
      [conversationId],
    );
    // A run of today, with every field the purge clears by the run's age.
    const runId = randomUUID();
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        cost_micros, steps_used, deadline_at, conversation_id, turn_number,
                        send_back_note)
       VALUES ($1, 'SYN-2', 0, 1, 'resolved', 'p', 'm', 0, 0, now(), $2, 1, 'a note from today')`,
      [runId, conversationId],
    );
    await pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, 'escalate', 'done', '{"reason": "a reason from today"}'::jsonb, 'p', 'm', 0)`,
      [runId],
    );
    await pool.query(
      `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery,
                           payload, status, reply)
       VALUES ($1, 'approve', 'retention-young-reply', 1, 'customer_reply', 'at_most_once',
               '{}'::jsonb, 'sent', '{"bodyText": "a reply sent today"}'::jsonb)`,
      [runId],
    );
    await runPublished();
    const thread = await readConversation(readers, conversationId);
    expect(thread?.turns[0]?.bodyText).toBe('written today');
    expect(thread?.participantNamed).toBe(true);
    const young = await pool.query<{ note: string | null; reason: string | null; reply: string | null }>(
      `SELECT r.send_back_note AS note, j.result->>'reason' AS reason, o.reply->>'bodyText' AS reply
         FROM run r
         JOIN step_journal j ON j.run_id = r.run_id AND j.step_id = 'escalate'
         JOIN outbox o ON o.run_id = r.run_id
        WHERE r.run_id = $1`,
      [runId],
    );
    expect(young.rows).toEqual([
      { note: 'a note from today', reason: 'a reason from today', reply: 'a reply sent today' },
    ]);
  });

});

/** One run on the conversation's first turn. */
interface QuietRun {
  state: string;
  /** Which attempt of the turn the run is. 1 when absent. */
  attempt?: number;
  /** Created now rather than long ago. */
  recent?: boolean;
  /** Written before `run.turn_number` existed, so it names no turn (db/015). */
  noTurn?: boolean;
}

/**
 * One conversation as the participant statement reads it. By default it is
 * quiet in every way the statement asks: old, one old turn whose text the turn
 * statement has cleared, and one old run that ended. Each case changes one
 * thing.
 */
interface Quiet {
  young?: boolean;
  recentTurn?: boolean;
  turnText?: 'body_text' | 'approved_reply_text' | 'saved_reply_text';
  turnAttempt?: number;
  runs?: QuietRun[];
  /** A document's request. A started one asked for attempt 2 of the turn. */
  rerun?: 'waiting' | 'started' | 'dropped';
  /** A message still in the queue, holding this text. */
  queued?: string;
}

async function seedQuiet(shape: Quiet): Promise<string> {
  const conversationId = randomUUID();
  await pool.query(
    `INSERT INTO conversation (conversation_id, primary_ticket_id, customer_address, opened_at)
     VALUES ($1, 'SYN-3', 'carol@customer.example', ${shape.young ? 'now()' : OLD})`,
    [conversationId],
  );
  await pool.query(
    `INSERT INTO turn (conversation_id, turn_number, ticket_id, attempt, created_at)
     VALUES ($1, 1, 'SYN-3', $2, ${shape.recentTurn ? 'now()' : OLD})`,
    [conversationId, shape.turnAttempt ?? 1],
  );
  if (shape.turnText !== undefined) {
    // A saved reply goes with the name of who saved it (DEC-45).
    const saver = shape.turnText === 'saved_reply_text'
      ? ", saved_reply_by = 'reviewer@example.test', saved_reply_by_source = 'roster'" : '';
    await pool.query(
      `UPDATE turn SET ${shape.turnText} = 'written long ago'${saver} WHERE conversation_id = $1`,
      [conversationId],
    );
  }
  const runIds: string[] = [];
  for (const run of shape.runs ?? [{ state: 'resolved' }]) {
    const runId = randomUUID();
    runIds.push(runId);
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        cost_micros, steps_used, deadline_at, conversation_id, turn_number,
                        attempt, created_at)
       VALUES ($1, 'SYN-3', 0, 1, $3, 'p', 'm', 0, 0, now(), $2, $4, $5, ${run.recent ? 'now()' : OLD})`,
      [runId, conversationId, run.state, run.noTurn ? null : 1, run.attempt ?? 1],
    );
  }
  if (shape.rerun !== undefined) {
    await pool.query(
      `INSERT INTO document (doc_id, kind, title, body, owner, review_by, source, embedding_status, written_by)
       VALUES ($1, 'document', 't', 'b', 'synthetic-owner', '2999-01-01', 'console', 'pending', 'reviewer@example.test')`,
      [`doc-${conversationId}`],
    );
    const columns = {
      waiting: ['', ''],
      started: [', status, ended_at, started_attempt', ", 'started', now(), 2"],
      dropped: [', status, reason, ended_at', ", 'dropped', 'ended', now()"],
    }[shape.rerun];
    await pool.query(
      `INSERT INTO document_rerun (doc_id, run_id, conversation_id, turn_number, attempt${columns[0]})
       VALUES ($1, $2, $3, 1, 1${columns[1]})`,
      [`doc-${conversationId}`, runIds[0], conversationId],
    );
  }
  if (shape.queued !== undefined) {
    await pool.query(
      `INSERT INTO intake (ticket_id, message_id, partition, ticket_text, conversation_id, turn_number)
       VALUES ('SYN-3', $1, 0, $2, $3, 1)`,
      [`m-${conversationId}`, shape.queued, conversationId],
    );
  }
  return conversationId;
}

/** The participant statement alone, the last of the five. */
function participantStatement(): string {
  const statement = publishedStatements().at(-1)!;
  expect(statement).toMatch(/^(--[^\n]*\n)*UPDATE conversation/);
  return statement;
}

async function participantAfter(shape: Quiet): Promise<string | null> {
  const id = await seedQuiet(shape);
  await pool.query(participantStatement());
  const { rows } = await pool.query<{ customer_address: string | null }>(
    'SELECT customer_address FROM conversation WHERE conversation_id = $1', [id],
  );
  return rows[0]!.customer_address;
}

describe('the participant statement', () => {
  // A participant the statement keeps. Each one names why.
  //
  // A recent turn or run: the period has not passed, on the clock the other
  //   statements read.
  // A turn or a queued message that still holds text: whoever claims the
  //   conversation next would draft from the earlier customer's words.
  // A parked run, a turn due another attempt, or a document request whose
  //   attempt has not landed: each parks a reply later, and the recipient
  //   check reads the participant.
  const kept: [string, Quiet][] = [
    ['a young conversation', { young: true }],
    ['a recent turn', { recentTurn: true }],
    ['a recent run that has ended', { runs: [{ state: 'resolved', recent: true }] }],
    ['a turn that still holds the message', { turnText: 'body_text' }],
    ['a turn that still holds the reply', { turnText: 'approved_reply_text' }],
    ['a turn that still holds a saved reply', { turnText: 'saved_reply_text' }],
    ['a queued message that holds text', { queued: 'a message still in the queue' }],
    ['a recent run still walking', { runs: [{ state: 'composed', recent: true }] }],
    ['a parked run', { runs: [{ state: 'awaiting_approval' }] }],
    ['a snoozed run', { runs: [{ state: 'snoozed' }] }],
    ['a turn due another attempt', { turnAttempt: 2 }],
    ['a turn whose new attempt is still walking', {
      turnAttempt: 2, runs: [{ state: 'resolved' }, { state: 'composed', attempt: 2 }],
    }],
    ['a request a document is waiting on', { rerun: 'waiting' }],
    // The turn stays on attempt 1, so only the request can keep it.
    ['a request whose attempt has not landed', { rerun: 'started' }],
    ['a request whose attempt is still walking', {
      rerun: 'started', runs: [{ state: 'resolved' }, { state: 'composed', attempt: 2 }],
    }],
  ];
  for (const [why, shape] of kept) {
    it(`keeps the participant of a conversation with ${why}`, async () => {
      expect(await participantAfter(shape)).toBe('carol@customer.example');
    });
  }

  // A participant the statement clears. The first is the positive control:
  // without it, a statement that cleared nothing would pass every case above,
  // as the statement on main did. Each other one is a conversation that is
  // done, and a statement that kept it would never finish the purge.
  const cleared: [string, Quiet][] = [
    ['is quiet in every way', {}],
    ['had a run die mid-walk, retried and resolved', {
      runs: [{ state: 'received' }, { state: 'resolved' }],
    }],
    ['has a run that names no turn', { runs: [{ state: 'resolved', noTurn: true }] }],
    ['had a turn attempted again, and the attempt landed', {
      turnAttempt: 2, runs: [{ state: 'resolved' }, { state: 'resolved', attempt: 2 }],
    }],
    ['had a document request start, and its attempt land', {
      rerun: 'started', turnAttempt: 2, runs: [{ state: 'escalated' }, { state: 'resolved', attempt: 2 }],
    }],
    ['had a document request end', { rerun: 'dropped' }],
    ['holds a queued message with no text', { queued: '  ' }],
  ];
  for (const [why, shape] of cleared) {
    it(`clears the participant of a conversation that ${why}`, async () => {
      expect(await participantAfter(shape)).toBeNull();
    });
  }

  it('names the states the consumer parks and lands in', () => {
    const statement = participantStatement();
    expect(statesNamed(statement, /r\.state IN \(([^)]*)\)/)).toEqual([...PARKED_RUN_STATES].sort());
    const landed = [...PARKED_RUN_STATES, ...TERMINAL_RUN_STATE_NAMES].sort();
    expect(statesNamed(statement, /e\.state IN \(([^)]*)\)/)).toEqual(landed);
    expect(statesNamed(statement, /s\.state IN \(([^)]*)\)/)).toEqual(landed);
  });
});
