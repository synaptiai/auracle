// Integration suite for the escalations CLI queries (decision D9-A).
//
// Seeds runs through the real write path (fencedInsert) plus the journal
// steps and outbox rows the coordinator and relay produce, then checks
// listEscalations surfaces exactly what needs a person and why. Also pins
// the filters (--since parsing, --state) as unit cases.
import { randomUUID } from 'node:crypto';

import { applyLedgerSchema } from '../test-support/schema.js';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { fencedInsert, type FencedRunInput } from '../ledger/insert.js';
import { listEscalations, parseSince } from './query.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

// src/test-support/db-global-setup.ts guarantees a reachable database before
// the workers fork: it starts a container, or probes an explicit
// DATABASE_URL and fails the run. A failure here is therefore a fault, and
// a suite that skipped itself instead would report success while proving
// nothing.
await pool.query('SELECT 1');


async function seedRun(state: string): Promise<FencedRunInput> {
  const run: FencedRunInput = {
    runId: randomUUID(),
    ticketId: 'T-' + randomUUID().slice(0, 8),
    partition: 0,
    epoch: 1n,
    state,
    promptVer: 'p1',
    modelVer: 'm1',
    deadlineAt: new Date(Date.now() + 60_000),
  };
  const result = await fencedInsert(pool, run, null);
  expect(result).toEqual({ outcome: 'accepted' });
  return run;
}

async function journalStep(runId: string, stepId: string, result: object): Promise<void> {
  await pool.query(
    // DEC-26 pins are NOT NULL on step_journal (db/006). This suite used to
    // omit them, because it applied 001 alone and never saw the constraint.
    `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
     VALUES ($1, $2, 'done', $3, 'escalations-test-prompt', 'escalations-test-model', 0)`,
    [runId, stepId, JSON.stringify(result)],
  );
}

describe('escalations CLI queries', () => {
  beforeEach(async () => {
    await applyLedgerSchema(pool);
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, intake, conversation, turn');
  });

  afterEach(async () => {
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, intake, conversation, turn');
  });

  it('surfaces a coordinator escalation with its limit reason', async () => {
    const run = await seedRun('escalated');
    await journalStep(run.runId, 'escalate', { reason: 'limit_cost' });

    const items = await listEscalations(pool);

    expect(items).toHaveLength(1);
    const { createdAt, ...rest } = items[0]!;
    expect(rest).toEqual({
      runId: run.runId,
      ticketId: run.ticketId,
      state: 'escalated',
      // The pin is on the row so a person can tell a seeded run from a
      // produced one in the queue they work from.
      promptVer: 'p1',
      reason: 'limit_cost',
      // This run escalated and never gated, so the queue has no rule to
      // name and no coverage to report. Null and not a guess: a person
      // reading `customer_visible` on a run that never reached the gate
      // would be reading an invention.
      gateReason: null,
      coverage: null,
      intentId: null,
      outboxStatus: null,
      draftExternalId: null,
      payloadRecorded: false,
      payload: null,
      actionClass: null,
      delivery: null,
      costMicros: 0,
      stepsUsed: 0,
    });
    // Read off the row rather than compared to a clock this test does not
    // own. The ledger stamps it, and a surface ordering by time needs it.
    expect(createdAt).toBeInstanceOf(Date);
  });

  // The defect this queue was built with. `reason` reads the `escalate` row,
  // and a run awaiting approval has not escalated — so every waiting run
  // reported "no reason journalled" while the gate row held the answer. The
  // two are different questions and the queue now answers both.
  it('names the policy rule that sent a waiting run to a person', async () => {
    const run = await seedRun('awaiting_approval');
    await journalStep(run.runId, 'classify', { intentId: 'refund_request', agreement: 0.89 });
    await journalStep(run.runId, 'gate', {
      groundedness: 0.75, decision: 'gated', reason: 'customer_visible',
    });
    await journalStep(run.runId, 'park', {
      draftExternalId: randomUUID(), actionClass: 'customer_reply',
      delivery: 'at_least_once', body: 'a draft body',
    });

    const items = await listEscalations(pool);

    expect(items[0]).toMatchObject({
      // Null, because this run has not escalated. Reporting the gate rule
      // here would answer a question about escalation with an answer about
      // gating.
      reason: null,
      gateReason: 'customer_visible',
      intentId: 'refund_request',
      coverage: 0.75,
    });
  });

  // DEC-34: a gated write with no customer draft parks in the ledger alone,
  // and `approveRun` relays the journalled payload. The console could not
  // tell such a run from one that parked nothing, so it offered no approval
  // for 51 of 161 waiting runs.
  it('says a ledger-only park carries an action payload (DEC-34)', async () => {
    const ledgerOnly = await seedRun('awaiting_approval');
    await journalStep(ledgerOnly.runId, 'park', {
      actionClass: 'apply_credit', delivery: 'at_most_once',
      body: 'a drafted note', payload: { amountMicros: 1_000 },
    });

    const items = await listEscalations(pool);

    expect(items[0]).toMatchObject({
      draftExternalId: null,
      payloadRecorded: true,
      // What approving it performs. DEC-40 lets this console approve because
      // the approver reads what they are approving, and a ledger-only park
      // has no drafted reply — this is the whole of the act.
      payload: { amountMicros: 1_000 },
      actionClass: 'apply_credit',
    });
  });

  // The other half of that pair. A park that recorded neither is one
  // `approveRun` refuses, and a console offering a button for it would send
  // a person to a failure.
  it('says a park carrying neither a handle nor a payload has no payload', async () => {
    const run = await seedRun('awaiting_approval');
    await journalStep(run.runId, 'park', {
      actionClass: 'apply_credit', delivery: 'at_most_once', body: 'a drafted note',
    });

    const items = await listEscalations(pool);

    expect(items[0]).toMatchObject({ draftExternalId: null, payloadRecorded: false });
  });

  it('surfaces an awaiting_approval run with its park record', async () => {
    const run = await seedRun('awaiting_approval');
    const draftExternalId = randomUUID();
    await journalStep(run.runId, 'park', {
      draftExternalId,
      actionClass: 'customer_reply',
      delivery: 'at_most_once',
      body: 'a draft body',
    });

    const items = await listEscalations(pool);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      state: 'awaiting_approval',
      reason: null,
      draftExternalId,
      actionClass: 'customer_reply',
      delivery: 'at_most_once',
    });
  });

  it('marks runs the relay parked on an unknown delivery', async () => {
    const run = await seedRun('escalated');
    await pool.query(
      `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery, payload, status)
       VALUES ($1, 'send', $2, 1, 'customer_reply', 'at_least_once', '{}', 'delivery_unknown')`,
      [run.runId, 'idem-' + randomUUID()],
    );

    const [item] = await listEscalations(pool);
    expect(item).toMatchObject({
      runId: run.runId,
      state: 'escalated',
      reason: null,
      outboxStatus: 'delivery_unknown',
    });
  });

  it('still lists a delivery_unknown record whose run row reads resolved', async () => {
    // DEC-30 makes this unreachable through the normal paths; the CLI keeps
    // surfacing a stuck record rather than trusting the run row alone.
    const run = await seedRun('resolved');
    await pool.query(
      `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery, payload, status)
       VALUES ($1, 'send', $2, 1, 'customer_reply', 'at_least_once', '{}', 'delivery_unknown')`,
      [run.runId, 'idem-' + randomUUID()],
    );

    const items = await listEscalations(pool);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ runId: run.runId, outboxStatus: 'delivery_unknown' });
  });

  // A cast that raises takes the whole statement, not one row — the queue an
  // operator came to work goes blank. The `gate_unreadable` path writes a
  // gate row with a different result shape, so this is a shape the ledger
  // holds. A `::bytea` cast of the same kind once took the run detail down.
  it('survives a gate row whose groundedness is not a number', async () => {
    const run = await seedRun('awaiting_approval');
    await journalStep(run.runId, 'gate', {
      groundedness: 'unreadable', decision: 'gated', reason: 'customer_visible',
    });

    const items = await listEscalations(pool);

    expect(items).toHaveLength(1);
    expect(items[0]?.coverage).toBeNull();
    expect(items[0]?.gateReason).toBe('customer_visible');
  });

  // `approveRun` refuses a payload that is not an object, and it throws bare
  // rather than returning an outcome the console can render. A queue that
  // tested for the key alone would put a button in front of a person that
  // leads to a stack trace.
  it('says a payload that is not an object is no payload', async () => {
    for (const payload of [null, 'text', 7, ['a']]) {
      await pool.query('TRUNCATE run, step_journal, outbox CASCADE');
      const run = await seedRun('awaiting_approval');
      await journalStep(run.runId, 'park', {
        actionClass: 'compensate', delivery: 'at_most_once', body: 'a note', payload,
      });
      const items = await listEscalations(pool);
      expect(items[0]?.payloadRecorded, JSON.stringify(payload)).toBe(false);
    }
  });

  // The outbox statement is a second copy of the run SELECT, and it is the
  // only one that answers for a run outside the two escalation states. A
  // column added to one and not the other reports nothing about exactly the
  // run an operator came here for — the one whose delivery is unknown.
  it('carries the same fields for a stuck record as for a waiting run', async () => {
    const run = await seedRun('resolved');
    await journalStep(run.runId, 'classify', { intentId: 'chargeback-notice', agreement: 0.9 });
    await journalStep(run.runId, 'gate', {
      groundedness: 0.6, decision: 'gated', reason: 'high_risk',
    });
    await journalStep(run.runId, 'park', {
      actionClass: 'apply_credit', delivery: 'at_most_once',
      body: 'a drafted note', payload: { amountMicros: 1_000 },
    });
    await pool.query(
      `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery, payload, status)
       VALUES ($1, 'send', $2, 1, 'customer_reply', 'at_least_once', '{}', 'delivery_unknown')`,
      [run.runId, 'idem-' + randomUUID()],
    );

    const items = await listEscalations(pool);

    expect(items[0]).toMatchObject({
      outboxStatus: 'delivery_unknown',
      gateReason: 'high_risk',
      intentId: 'chargeback-notice',
      coverage: 0.6,
      payloadRecorded: true,
      actionClass: 'apply_credit',
    });
    expect(items[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('ignores resolved runs without a stuck record', async () => {
    await seedRun('resolved');
    expect(await listEscalations(pool)).toEqual([]);
  });

  it('filters by state, including the synthetic delivery_unknown view', async () => {
    const escalated = await seedRun('escalated');
    await journalStep(escalated.runId, 'escalate', { reason: 'policy_escalated' });
    const awaiting = await seedRun('awaiting_approval');
    await journalStep(awaiting.runId, 'park', {
      draftExternalId: randomUUID(),
      actionClass: 'customer_reply',
      delivery: 'at_least_once',
      body: 'a draft',
    });
    const stuck = await seedRun('escalated');
    await pool.query(
      `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery, payload, status)
       VALUES ($1, 'send', $2, 1, 'customer_reply', 'at_least_once', '{}', 'delivery_unknown')`,
      [stuck.runId, 'idem-' + randomUUID()],
    );

    expect((await listEscalations(pool, { state: 'escalated' })).map((i) => i.runId).sort())
      .toEqual([escalated.runId, stuck.runId].sort());
    expect((await listEscalations(pool, { state: 'awaiting_approval' })).map((i) => i.runId))
      .toEqual([awaiting.runId]);
    expect(
      (await listEscalations(pool, { state: 'delivery_unknown' })).map((i) => i.outboxStatus),
    ).toEqual(['delivery_unknown']);
  });

  it('applies --since against the ticket arrival time and keeps unknown arrivals', async () => {
    const recentTicket = 'T-recent-' + randomUUID().slice(0, 8);
    const oldRun = await seedRun('escalated');
    await journalStep(oldRun.runId, 'escalate', { reason: 'limit_steps' });

    const recent = await seedRun('escalated');
    await pool.query('UPDATE run SET ticket_id = $1 WHERE run_id = $2', [
      recentTicket,
      recent.runId,
    ]);
    await journalStep(recent.runId, 'escalate', { reason: 'limit_clock' });
    await pool.query(
      'INSERT INTO intake (ticket_id, message_id, partition, ticket_text, enqueued_at) VALUES ($1, $2, $3, $4, $5)',
      // One queued message for this ticket, keyed by its own identity.
      [recentTicket, recentTicket, 0, 'body', new Date(Date.now() - 60_000)],
    );

    const items = await listEscalations(pool, { since: '24h' });
    // The recent ticket passes the window; the old one has no intake row,
    // so its arrival is unknown and it must not be hidden.
    expect(items.map((i) => i.ticketId)).toEqual([oldRun.ticketId, recentTicket].sort());

    // A long window brings back the same set; sorting is by ticket id.
    const all = await listEscalations(pool, { since: '3650d' });
    expect(all).toHaveLength(2);
  });

  it('excludes items whose known arrival predates the --since cutoff', async () => {
    // This one arrived a week ago and must drop out of a 24h window.
    const staleTicket = 'T-stale-' + randomUUID().slice(0, 8);
    const stale = await seedRun('escalated');
    await pool.query('UPDATE run SET ticket_id = $1 WHERE run_id = $2', [
      staleTicket,
      stale.runId,
    ]);
    await journalStep(stale.runId, 'escalate', { reason: 'limit_steps' });
    await pool.query(
      'INSERT INTO intake (ticket_id, message_id, partition, ticket_text, enqueued_at) VALUES ($1, $2, $3, $4, $5)',
      [staleTicket, staleTicket, 0, 'body', new Date(Date.now() - 7 * 86_400_000)],
    );

    // No intake row: arrival unknown, so this one stays listed.
    const kept = await seedRun('escalated');
    await journalStep(kept.runId, 'escalate', { reason: 'limit_clock' });

    const items = await listEscalations(pool, { since: '24h' });
    expect(items.map((i) => i.ticketId)).toEqual([kept.ticketId]);
  });

  describe('parseSince', () => {
    it('accepts relative durations', () => {
      const cutoff = parseSince('45m');
      expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(45 * 60_000 - 5_000);
      expect(Date.now() - cutoff.getTime()).toBeLessThan(46 * 60_000);
    });

    it('accepts ISO timestamps', () => {
      expect(parseSince('2026-01-15T00:00:00Z').toISOString()).toBe('2026-01-15T00:00:00.000Z');
    });

    it('rejects garbage instead of silently dropping items', () => {
      expect(() => parseSince('yesterday')).toThrow(/--since/);
    });
  });

  afterAll(async () => {
    await pool.end();
  });
});
