// The erasure path the runbook publishes, run against the ledger.
//
// `docs/operations.md` gives an adopter three statements to clear customer
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
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { truncateLedger } from '../test-support/schema.js';
import { readRunJournal } from '../journal/query.js';
import { readConversation } from './query.js';

const pool = new Pool({ connectionString: dbUrl(), max: 4 });
const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/**
 * The statements the runbook publishes, in the order it publishes them.
 *
 * Taken from the fenced block under the retention heading. A block that stops
 * being there fails the non-vacuity check below rather than passing silently.
 */
function publishedStatements(): string[] {
  const runbook = readFileSync(`${REPO_ROOT}docs/operations.md`, 'utf8');
  const heading = runbook.indexOf('### What the ledger stores about a customer');
  expect(heading, 'the retention section is not in the runbook').toBeGreaterThan(-1);
  const block = /```sql\n([\s\S]*?)```/.exec(runbook.slice(heading));
  expect(block, 'the retention section publishes no statements').not.toBeNull();
  return block![1]!
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

afterAll(async () => {
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
     VALUES ($1, 'SYN-1', 'ada@customer.example', 'resolved', ${OLD})`,
    [conversationId],
  );
  await pool.query(
    `INSERT INTO turn (conversation_id, turn_number, ticket_id, body_text, approved_reply_text, created_at)
     VALUES ($1, 1, 'SYN-1', 'the customer wrote this', 'and we answered that', ${OLD})`,
    [conversationId],
  );
  await pool.query(
    `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                      cost_micros, steps_used, deadline_at, conversation_id, turn_number, created_at)
     VALUES ($1, 'SYN-1', 0, 1, 'resolved', 'p', 'm', 0, 0, now(), $2, 1, ${OLD})`,
    [runId, conversationId],
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

describe('the erasure path the runbook publishes', () => {
  it('publishes statements the ledger accepts', async () => {
    const statements = publishedStatements();
    // Three: the turn, the journal, the participant. Non-vacuity, because a
    // block that lost one would otherwise pass every case below.
    expect(statements).toHaveLength(3);
    await seedOldConversation();
    await runPublished();
  });

  it('clears every place a customer\'s words are held', async () => {
    const { conversationId, runId } = await seedOldConversation();
    await runPublished();

    const thread = await readConversation(pool, conversationId);
    expect(thread?.turns[0]?.bodyText).toBeNull();
    expect(thread?.turns[0]?.replyText).toBeNull();
    expect(thread?.participantNamed).toBe(false);

    const journal = await readRunJournal(pool, runId);
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
      `SELECT coalesce(string_agg(concat_ws(' ', body_text, approved_reply_text), ' '), '') AS turns
         FROM turn`,
    );
    const addresses = await pool.query(
      `SELECT coalesce(string_agg(customer_address, ' '), '') AS named FROM conversation`,
    );
    const everything = [
      (raw.rows[0] as { journal: string }).journal,
      (columns.rows[0] as { turns: string }).turns,
      (addresses.rows[0] as { named: string }).named,
    ].join(' ');
    for (const cleared of [
      'the customer wrote this', 'and we answered that', 'the drafted reply',
      'the first claim', 'the courtesy opening', 'the first sentence of the reply',
      'the document body', 'ada@customer.example',
      'bob@customer.example', '550 no such user',
    ]) {
      expect(everything, cleared).not.toContain(cleared);
    }
  });

  // The runbook's own claim: each statement leaves the keys a reader joins on.
  // A cleared row that stopped rendering would take the turn off the surface
  // rather than emptying it, and an operator would read a conversation that
  // had lost a message the customer sent.
  it('leaves every key a reader joins on', async () => {
    const { conversationId, runId, refusedRun } = await seedOldConversation();
    await runPublished();

    const thread = await readConversation(pool, conversationId);
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

    const journal = await readRunJournal(pool, runId);
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
    await runPublished();
    const thread = await readConversation(pool, conversationId);
    expect(thread?.turns[0]?.bodyText).toBe('written today');
    expect(thread?.participantNamed).toBe(true);
  });
});
