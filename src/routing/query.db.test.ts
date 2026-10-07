// The routing screen's figures (issue #112).
//
// For each product and intent, the gate step keeps its latest record: the
// threshold in force for that run, whether it was fitted, and the rule that
// decided. A rule that stops an action whatever the gates read means the
// product may not act on its own; a decision the gates made means it may,
// when both pass. The screen reads those records and the arrival signals,
// never the whole journal.
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { enqueueTicket } from '../coordinator/intake.js';
import { dbUrl, readerDbUrl } from '../db/config.js';
import { fencedInsert } from '../ledger/insert.js';
import type { GateThresholds, PolicyReason } from '../policy/policy.js';
import { truncateLedger } from '../test-support/schema.js';
import { recordGateLatest } from './latest.js';
import { ROUTING_TIMEOUT_MS, readRouting } from './query.js';

const pool = new Pool({ connectionString: dbUrl() });
// The readers connect as the role that cannot act beyond a read (issue #153).
const readers = new Pool({ connectionString: readerDbUrl(), max: 4 });
await pool.query('SELECT 1');

const INTENTS = [
  { id: 'billing_refund', risk_tier: 'high' as const },
  { id: 'account_access', risk_tier: 'medium' as const },
  { id: 'shipping_status', risk_tier: 'low' as const },
];
const SEED: GateThresholds = { agreement: 0.6, groundednessBlock: 0.7, groundednessReview: 0.8 };

let epoch = 1n;

/** A run of `product` that started at `createdAt`, with no intake row left. */
async function runOf(product: string | null, createdAt: Date): Promise<string> {
  const ticketId = 'T-' + randomUUID().slice(0, 8);
  const turn = await enqueueTicket(pool, { ticketId, messageId: randomUUID(), ticketText: 'a synthetic question' }, 4);
  const runId = randomUUID();
  epoch += 1n;
  expect(await fencedInsert(pool, {
    runId, ticketId, partition: 0, epoch, state: 'resolved', promptVer: 'p1', modelVer: 'm1',
    conversationId: turn.conversationId, turnNumber: turn.turnNumber, deadlineAt: new Date(Date.now() + 60_000),
  }, null)).toEqual({ outcome: 'accepted' });
  await pool.query('UPDATE run SET product = $2, created_at = $3, enqueued_at = $3 WHERE run_id = $1',
    [runId, product, createdAt]);
  await pool.query('DELETE FROM intake WHERE ticket_id = $1', [ticketId]);
  return runId;
}

/** A run that reached the gate, recorded as the gate step records it. */
async function gated(
  product: string | null, intentId: string, reason: PolicyReason, thresholds: GateThresholds, createdAt: Date,
): Promise<string> {
  const runId = await runOf(product, createdAt);
  await recordGateLatest(pool, { runId, intentId, reason, thresholds });
  return runId;
}

/**
 * A record the backfill of db/037 wrote from older journal rows: the latest
 * readable one, if any, and how many newer rows could not be read.
 */
async function backfilled(
  product: string | null, intentId: string,
  row: { gateAt: Date | null; runAt?: Date; reason?: unknown; thresholds?: unknown; unreadable: number },
): Promise<void> {
  const runAt = row.runAt ?? row.gateAt ?? at(59);
  const runId = await runOf(product, runAt);
  await pool.query(
    `INSERT INTO gate_latest (product, intent_id, run_id, run_created_at, gate_at, reason, thresholds, unreadable)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [product, intentId, runId, runAt, row.gateAt,
      row.reason === undefined ? null : JSON.stringify(row.reason),
      row.thresholds === undefined ? null : JSON.stringify(row.thresholds), row.unreadable],
  );
}

const at = (minute: number): Date => new Date(Date.UTC(2026, 8, 14, 12, minute));

describe('the routing screen (issue #112)', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });
  afterAll(async () => {
    await readers.end();
    await pool.end();
  });

  it('reads each product and intent from its latest gate', async () => {
    // Product aurora: an older automatic run, then a high-risk stop.
    await gated('aurora', 'billing_refund', 'auto', SEED, at(1));
    await gated('aurora', 'billing_refund', 'high_risk', SEED, at(5));
    // Product ledger: the latest is an agreement failure. The gates decided
    // it, so the product may act when both pass.
    await gated('ledger', 'billing_refund', 'customer_visible', SEED, at(2));
    await gated('ledger', 'billing_refund', 'agreement', SEED, at(6));

    const report = await readRouting(readers, { intents: INTENTS });
    const intent = (product: string, id: string) =>
      report.products.find((row) => row.product === product)!.intents.find((row) => row.id === id)!;
    expect(intent('aurora', 'billing_refund')).toEqual({
      id: 'billing_refund', risk: 'high', unreadable: 0, unreadableAtMost: false,
      gate: { at: at(5).toISOString(), reason: 'high_risk', mayAct: false, threshold: 0.6, fitted: false },
    });
    expect(intent('ledger', 'billing_refund').gate).toMatchObject({ reason: 'agreement', mayAct: true });
    // No run of either product reached a gate for this intent.
    expect(intent('aurora', 'shipping_status')).toEqual({ id: 'shipping_status', risk: 'low', gate: null, unreadable: 0, unreadableAtMost: false });
  });

  it('reads the threshold fitted for the intent, and the global one otherwise', async () => {
    const fitted: GateThresholds = { ...SEED, perIntent: { billing_refund: 0.8 } };
    await gated('aurora', 'billing_refund', 'auto', fitted, at(1));
    await gated('aurora', 'account_access', 'auto', fitted, at(2));
    const intents = (await readRouting(readers, { intents: INTENTS })).products[0]!.intents;
    expect(intents[0]!.gate).toMatchObject({ threshold: 0.8, fitted: true });
    expect(intents[1]!.gate).toMatchObject({ threshold: 0.6, fitted: false });
  });

  it('matches an intent however the classifier cased it', async () => {
    await gated('aurora', ' Billing_Refund ', 'irreversible', { ...SEED, perIntent: { billing_refund: 0.75 } }, at(1));
    const gate = (await readRouting(readers, { intents: INTENTS })).products[0]!.intents[0]!.gate;
    expect(gate).toMatchObject({ reason: 'irreversible', mayAct: false, threshold: 0.75, fitted: true });
  });

  it('shows a backfilled record with the newer rows the backfill could not read', async () => {
    await backfilled('aurora', 'billing_refund', { gateAt: at(1), reason: 'auto', thresholds: SEED, unreadable: 4 });
    const row = (await readRouting(readers, { intents: INTENTS })).products[0]!.intents[0]!;
    expect(row.unreadable).toBe(4);
    expect(row.gate).toMatchObject({ at: at(1).toISOString(), reason: 'auto', mayAct: true });
  });

  it('counts every row it cannot read when the backfill could read none', async () => {
    await backfilled('aurora', 'billing_refund', { gateAt: null, unreadable: 3 });
    const row = (await readRouting(readers, { intents: INTENTS })).products[0]!.intents[0]!;
    expect(row).toEqual({ id: 'billing_refund', risk: 'high', gate: null, unreadable: 3, unreadableAtMost: false });
  });

  it('refuses a stored record it cannot read, and counts it as one more', async () => {
    // 1e-400 is above 0 as the ledger stores it, and 0 once it is read into
    // a number, which is no threshold. A reason the gate never writes is none.
    await backfilled('aurora', 'billing_refund', { gateAt: at(1), reason: 'auto', thresholds: { agreement: 1e-400 }, unreadable: 2 });
    await backfilled('aurora', 'account_access', { gateAt: at(1), reason: 'a_reason_the_gate_never_writes', thresholds: SEED, unreadable: 0 });
    // The stored value is the one the ledger keeps, so it is written as text.
    await pool.query(
      `UPDATE gate_latest SET thresholds = jsonb_set(thresholds, '{agreement}', '1e-400'::jsonb) WHERE intent_id = 'billing_refund'`,
    );
    const intents = (await readRouting(readers, { intents: INTENTS })).products[0]!.intents;
    expect(intents[0]).toMatchObject({ gate: null, unreadable: 3 });
    expect(intents[1]).toMatchObject({ gate: null, unreadable: 1 });
  });

  it('reads a record whose fitted map holds a bad value only for another intent', async () => {
    await backfilled('aurora', 'billing_refund', {
      gateAt: at(2), reason: 'auto', thresholds: { ...SEED, perIntent: { account_access: 'high' } }, unreadable: 0,
    });
    const row = (await readRouting(readers, { intents: INTENTS })).products[0]!.intents[0]!;
    expect(row).toMatchObject({ unreadable: 0, gate: { at: at(2).toISOString(), threshold: 0.6, fitted: false } });
  });

  it('merges the spellings of one intent, showing the newer record and the unread rows newer than it', async () => {
    // The backfill keys an intent as the journal spelled it. A live gate keys
    // it as the policy engine does, so one intent can hold two rows.
    // Refund: the backfilled row read runs up to minute 7, and 2 of them could
    // not be read. The live record at minute 5 is older than some of them.
    await backfilled('aurora', 'Billing_Refund\t', { gateAt: at(1), runAt: at(7), reason: 'auto', thresholds: SEED, unreadable: 2 });
    await gated('aurora', 'billing_refund', 'agreement', SEED, at(5));
    // Access: the other row's unread rows are all older than the record shown,
    // so none of them is newer.
    await backfilled('aurora', ' ACCOUNT_access', { gateAt: at(9), reason: 'high_risk', thresholds: SEED, unreadable: 0 });
    await backfilled('aurora', 'account_access', { gateAt: at(2), runAt: at(3), reason: 'auto', thresholds: SEED, unreadable: 1 });
    const report = await readRouting(readers, { intents: INTENTS });
    const [refund, access] = report.products[0]!.intents;
    // Some of refund's 2 unread rows can be older than the record shown, so
    // the count is a bound, not an exact figure.
    expect(refund).toMatchObject({
      unreadable: 2, unreadableAtMost: true, gate: { at: at(5).toISOString(), reason: 'agreement' },
    });
    expect(access).toMatchObject({
      unreadable: 0, unreadableAtMost: false, gate: { at: at(9).toISOString(), reason: 'high_risk' },
    });
    expect(report.products[0]!.unlisted).toBe(0);
  });

  it('counts the intents it recorded that the taxonomy no longer lists', async () => {
    await gated('aurora', 'billing_refund', 'auto', SEED, at(1));
    await gated('aurora', 'returns_portal', 'auto', SEED, at(2));
    await gated('aurora', 'loyalty_points', 'auto', SEED, at(3));
    await gated('ledger', 'loyalty_points', 'auto', SEED, at(4));
    // Another spelling of one unlisted intent is the same intent.
    await backfilled('aurora', ' Loyalty_Points', { gateAt: at(0), reason: 'auto', thresholds: SEED, unreadable: 0 });
    const products = (await readRouting(readers, { intents: INTENTS })).products;
    expect(products.map((row) => [row.product, row.unlisted])).toEqual([['aurora', 2], ['ledger', 1]]);
    expect(products[0]!.intents.map((intent) => intent.id)).toEqual(INTENTS.map((intent) => intent.id));
  });

  it('lists configured products with no records, and no product last', async () => {
    await gated(null, 'billing_refund', 'auto', SEED, at(1));
    const report = await readRouting(readers, { intents: INTENTS, products: ['kestrel', 'aurora'] });
    expect(report.products.map((row) => row.product)).toEqual(['aurora', 'kestrel', null]);
    expect(report.products[0]).toEqual({
      product: 'aurora',
      intents: INTENTS.map((intent) => ({ id: intent.id, risk: intent.risk_tier, gate: null, unreadable: 0, unreadableAtMost: false })),
      unlisted: 0,
      channels: { lastArrival: null, waiting: 0, oldestWaiting: null, retried: 0 },
    });
  });

  it('reads the signals the ledger records about where cases come from', async () => {
    await runOf('aurora', at(1));
    await runOf('aurora', at(9));
    await runOf('ledger', at(40));
    for (const [minute, attempts] of [[20, 0], [15, 2], [30, 1]] as const) {
      const ticketId = 'T-' + randomUUID().slice(0, 8);
      await enqueueTicket(pool, { ticketId, messageId: randomUUID(), ticketText: 'a synthetic question' }, 4);
      await pool.query('UPDATE intake SET product = $2, enqueued_at = $3, attempts = $4 WHERE ticket_id = $1',
        [ticketId, 'aurora', at(minute), attempts]);
    }
    const products = (await readRouting(readers, { intents: INTENTS })).products;
    // The newest arrival of aurora is a message that waits, not a run.
    expect(products.map((row) => [row.product, row.channels])).toEqual([
      ['aurora', { lastArrival: at(30).toISOString(), waiting: 3, oldestWaiting: at(15).toISOString(), retried: 2 }],
      ['ledger', { lastArrival: at(40).toISOString(), waiting: 0, oldestWaiting: null, retried: 0 }],
    ]);
  });

  it('reads the last arrival of a product whose only messages still wait', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    await enqueueTicket(pool, { ticketId, messageId: randomUUID(), ticketText: 'a synthetic question' }, 4);
    await pool.query('UPDATE intake SET product = $2, enqueued_at = $3 WHERE ticket_id = $1', [ticketId, 'kestrel', at(4)]);
    const channels = (await readRouting(readers, { intents: INTENTS })).products[0]!.channels;
    expect(channels).toEqual({ lastArrival: at(4).toISOString(), waiting: 1, oldestWaiting: at(4).toISOString(), retried: 0 });
  });

  it('counts a run with no arrival time from its start', async () => {
    const runId = await runOf('aurora', at(7));
    await runOf(null, at(3));
    await pool.query('UPDATE run SET enqueued_at = NULL WHERE run_id = $1', [runId]);
    const products = (await readRouting(readers, { intents: INTENTS })).products;
    expect(products.map((row) => [row.product, row.channels.lastArrival])).toEqual([
      ['aurora', at(7).toISOString()], [null, at(3).toISOString()],
    ]);
  });

  it('reads a large history inside its time budget', async () => {
    // 300,000 runs over 60 days in three products, each with seven journal
    // steps and a threshold fitted for each of 25 intents, and a latest record
    // for each product and intent. A read that visits every gate row takes
    // seconds at this size; the budget is two, and the read visits one row per
    // product and intent.
    const FITTED: GateThresholds = {
      ...SEED, perIntent: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`intent-${i}`, 0.7])),
    };
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver, deadline_at,
                        product, created_at, enqueued_at)
       SELECT md5(n::text)::uuid, 'T-' || n, 0, 1, 'resolved', 'p', 'm', now(), 'prod-' || (n % 3),
              $1::timestamptz - (n * interval '17 seconds'), $1::timestamptz - (n * interval '17 seconds')
         FROM generate_series(1, 300000) n`,
      [at(0)],
    );
    await pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       SELECT md5(n::text)::uuid, s.step_id, 'done',
              CASE s.step_id WHEN 'classify' THEN jsonb_build_object('intentId', 'intent-' || (n % 25))
                             WHEN 'gate' THEN jsonb_build_object('reason', 'auto', 'thresholds', $1::jsonb)
                             ELSE '{}'::jsonb END,
              'p', 'm', 0
         FROM generate_series(1, 300000) n
        CROSS JOIN (VALUES ('classify'), ('retrieve'), ('compose'), ('gate'), ('execute'), ('park'), ('relay')) s(step_id)`,
      [JSON.stringify(FITTED)],
    );
    await pool.query(
      `INSERT INTO gate_latest (product, intent_id, run_id, run_created_at, gate_at, reason, thresholds)
       SELECT 'prod-' || (n % 3), 'intent-' || (n % 25), md5(n::text)::uuid, $1::timestamptz - (n * interval '17 seconds'),
              $1::timestamptz - (n * interval '17 seconds'), '"auto"', $2::jsonb
         FROM generate_series(1, 75) n`,
      [at(0), JSON.stringify(FITTED)],
    );
    await pool.query('ANALYZE');
    const intents = Array.from({ length: 25 }, (_, i) => ({ id: `intent-${i}`, risk_tier: 'low' as const }));
    const started = Date.now();
    const report = await readRouting(readers, { intents });
    const took = Date.now() - started;
    expect(report.products.map((row) => row.product)).toEqual(['prod-0', 'prod-1', 'prod-2']);
    expect(report.products.every((row) => row.intents.every((intent) => intent.gate !== null))).toBe(true);
    expect(report.products[1]!.channels.lastArrival).toBe(new Date(at(0).getTime() - 17_000).toISOString());
    expect(took).toBeLessThan(ROUTING_TIMEOUT_MS);
  });
});
