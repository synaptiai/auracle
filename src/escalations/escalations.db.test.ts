// Integration suite for the escalations CLI queries (decision D9-A).
//
// Seeds runs through the real write path (fencedInsert) plus the journal
// steps and outbox rows the coordinator and relay produce, then checks
// listEscalations surfaces exactly what needs a person and why. Also pins
// the filters (--since parsing, --state) as unit cases.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { fencedInsert, type FencedRunInput } from '../ledger/insert.js';
import { listEscalations, parseSince } from './query.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

let dbUp = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbUp = false;
}

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');
const LEDGER_DDL = readFileSync(path.join(dbDir, '001_ledger.sql'), 'utf8');
const INTAKE_DDL = readFileSync(path.join(dbDir, '004_intake.sql'), 'utf8');
const TIMING_DDL = readFileSync(path.join(dbDir, '005_run_timing.sql'), 'utf8');

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
    "INSERT INTO step_journal (run_id, step_id, status, result) VALUES ($1, $2, 'done', $3)",
    [runId, stepId, JSON.stringify(result)],
  );
}

describe.skipIf(!dbUp)('escalations CLI queries', () => {
  beforeEach(async () => {
    await pool.query(LEDGER_DDL);
    await pool.query(INTAKE_DDL);
    await pool.query(TIMING_DDL);
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, intake');
  });

  afterEach(async () => {
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, intake');
  });

  it('surfaces a coordinator escalation with its limit reason', async () => {
    const run = await seedRun('escalated');
    await journalStep(run.runId, 'escalate', { reason: 'limit_cost' });

    const items = await listEscalations(pool);

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      runId: run.runId,
      ticketId: run.ticketId,
      state: 'escalated',
      reason: 'limit_cost',
      outboxStatus: null,
      draftExternalId: null,
      actionClass: null,
      delivery: null,
      costCents: 0,
      stepsUsed: 0,
    });
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
      'INSERT INTO intake (ticket_id, partition, ticket_text, enqueued_at) VALUES ($1, $2, $3, $4)',
      [recentTicket, 0, 'body', new Date(Date.now() - 60_000)],
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
      'INSERT INTO intake (ticket_id, partition, ticket_text, enqueued_at) VALUES ($1, $2, $3, $4)',
      [staleTicket, 0, 'body', new Date(Date.now() - 7 * 86_400_000)],
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
