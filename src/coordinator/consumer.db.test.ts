// Integration suite for the partition consumer and rebalance procedure
// (section 4.3, DEC-27, DEC-28) against the compose Postgres.
//
// Proves what the card asks for:
//   - two consumers never process one ticket concurrently in normal
//     operation (disjoint partition sets + hash routing),
//   - a stale owner's writes are refused after a rebalance
//     (claimPartition bumps the fences; the fenced ledger path refuses).
//
// The model is a FakeProvider with scripted responses; every ledger write is
// real. Synthetic data only (DEC-18).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { claimPartition, nextEpoch, processQueuedTickets } from './consumer.js';
import type { ConsumerOptions } from './consumer.js';
import { coordinateTicket, partitionOf } from './coordinator.js';
import type { CoordinateInput, CoordinatorDeps } from './coordinator.js';
import { enqueueTicket } from './intake.js';
import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { dbUrl } from '../db/config.js';
import { fencedInsert, fencedTransition } from '../ledger/insert.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import type { AdapterCapabilities } from '../policy/policy.js';
import { indexDocument } from '../retriever/retriever.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

let dbUp = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbUp = false;
}

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');
const LEDGER_DDL = readFileSync(path.join(dbDir, '001_ledger.sql'), 'utf8');
const DOCUMENTS_DDL = readFileSync(path.join(dbDir, '002_documents.sql'), 'utf8');
const INTAKE_DDL = readFileSync(path.join(dbDir, '004_intake.sql'), 'utf8');
const TIMING_DDL = readFileSync(path.join(dbDir, '005_run_timing.sql'), 'utf8');

const CAPABILITIES: AdapterCapabilities = {
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
};
const PARTITION_COUNT = 8;
const DIM = 1536;

// Seeded PRNG so every run uses identical synthetic vectors (DEC-18).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) >>> 0;
    return t / 4294967296;
  };
}

function unitVector(seed: number): number[] {
  const rand = mulberry32(seed);
  const v = Array.from({ length: DIM }, () => rand() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

const VEC = unitVector(42);
const TICKET_TEXT = 'I cannot sign in to my account. How do I reset my password?';
const DISCLOSURE = 'This reply was drafted by an automated assistant and approved by a person.';

/**
 * Script for one run that passes both gates: 9 classifier samples, one embed,
 * composer draft, claim splitter, judge verdict (12 cents at FakeProvider's
 * default of 1 cent per chat call).
 */
function happyScript(): FakeStep[] {
  return [
    ...Array.from({ length: 9 }, () => ({ text: 'password_reset' })),
    { vectors: [VEC] },
    { text: '[doc:d1] Open the account settings page and choose reset password.' },
    { text: '- Open the account settings page and choose reset password.' },
    { text: 'VERDICT: SUPPORTED' },
  ];
}

function makeDeps(script: FakeStep[], promptVer: string): CoordinatorDeps {
  return {
    pool,
    provider: new FakeProvider(script),
    taxonomy: {
      intents: [
        { id: 'password_reset', label: 'Password reset', risk_tier: 'low' },
      ],
    },
    capabilities: CAPABILITIES,
    egress: new HelpdeskAdapter(),
    pins: { promptVer, modelVer: 'coord-test-model' },
    limits: {
      maxCostCents: 10_000,
      maxSteps: 50,
      deadlineAt: new Date(Date.now() + 60_000),
    },
    partitionCount: PARTITION_COUNT,
  };
}

/** Action spec shared by every consumer under test (mirrors the entrypoint). */
function actionSpec(): ConsumerOptions['action'] {
  return {
    actionClass: 'route_ticket',
    actionPayload: { queue: 'password-support' },
    delivery: 'at_most_once',
    isCustomerVisible: false,
    disclosure: DISCLOSURE,
  };
}

function optionsFor(partitions: number[]): ConsumerOptions {
  return { partitions, intervalMs: 1000, action: actionSpec() };
}

function autoInput(ticketId: string, epoch: bigint): CoordinateInput {
  return {
    ticketId,
    ticketText: TICKET_TEXT,
    epoch,
    ...actionSpec(),
  };
}

type QueryFn = (text: string | unknown, values?: unknown[]) => Promise<unknown>;

/**
 * A pool view that runs `match`-triggered `hook` once around `query`.
 * Used to land a claimPartition bump at a precise point inside the
 * nextEpoch-read -> fenced-insert window, which is where a concurrent
 * rebalance would hit in production. Ledger writes themselves go through
 * pool.connect() and bypass the wrapper, so only coordinator-level queries
 * are intercepted.
 */
function wrappedPool(real: Pool, match: string, hook: () => Promise<void>): Pool {
  let fired = false;
  const query: QueryFn = async (text, values) => {
    const fire =
      !fired && typeof text === 'string' && text.includes(match);
    let result: unknown;
    if (fire && typeof text === 'string' && text.includes('FROM ticket_epoch')) {
      // Post-read hook: the SELECT must see the PRE-bump fence first.
      result = await real.query(text, values);
      fired = true;
      await hook();
      return result;
    }
    if (fire) {
      fired = true;
      await hook();
    }
    return real.query(text as string, values);
  };
  return { query, connect: real.connect.bind(real) } as unknown as Pool;
}

/** Finds a synthetic ticket id whose DEC-27 partition is `partition`. */
function ticketIdInPartition(partition: number): string {
  for (let i = 0; i < 10_000; i++) {
    const id = `T-${partition}-${i}`;
    if (partitionOf(id, PARTITION_COUNT) === partition) return id;
  }
  throw new Error(`no ticket id found for partition ${partition}`);
}

interface RunRow {
  run_id: string;
  epoch: string;
  state: string;
  partition: number;
  prompt_ver: string;
}

async function runRowsFor(ticketId: string): Promise<RunRow[]> {
  const rows = await pool.query(
    `SELECT run_id::text AS run_id, epoch::text AS epoch, state, partition, prompt_ver
     FROM run WHERE ticket_id = $1`,
    [ticketId],
  );
  return rows.rows as RunRow[];
}

describe.skipIf(!dbUp)('section 4.3 partition consumer', () => {
  beforeEach(async () => {
    await pool.query(LEDGER_DDL);
    await pool.query(DOCUMENTS_DDL);
    await pool.query(INTAKE_DDL);
    await pool.query(TIMING_DDL);
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, document, intake');
    await indexDocument(
      pool,
      {
        docId: 'd1',
        kind: 'document',
        title: 'Reset your password',
        body: 'Open the account settings page and choose security. Choose reset password and follow the link we email you.',
        owner: 'synthetic-owner',
        reviewBy: '2999-01-01',
      },
      VEC,
    );
  });

  afterEach(async () => {
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, document, intake');
  });

  it('routes each ticket to its owning consumer; two consumers never produce two runs for one ticket', async () => {
    // Four tickets across four partitions; consumer A owns {p0, p1}, B owns
    // {p2, p3}. Disjoint sets are the DEC-27 exclusivity mechanism.
    const tickets = [0, 1, 2, 3].map((p) => ({
      id: ticketIdInPartition(p),
      partition: p,
    }));
    for (const ticket of tickets) {
      await enqueueTicket(pool, { ticketId: ticket.id, ticketText: TICKET_TEXT }, PARTITION_COUNT);
    }

    const ownedByA = tickets.filter((t) => t.partition <= 1).map((t) => t.partition);
    const ownedByB = tickets.filter((t) => t.partition > 1).map((t) => t.partition);

    // Both consumers scan concurrently, as they would on separate hosts.
    // Scripts sized to the number of tickets each consumer can poll.
    const [resultsA, resultsB] = await Promise.all([
      processQueuedTickets(
        makeDeps(Array.from({ length: ownedByA.length }, () => happyScript()).flat(), 'owner-a'),
        optionsFor(ownedByA),
      ),
      processQueuedTickets(
        makeDeps(Array.from({ length: ownedByB.length }, () => happyScript()).flat(), 'owner-b'),
        optionsFor(ownedByB),
      ),
    ]);

    // Every ticket was processed exactly once, across both consumers.
    expect([...resultsA, ...resultsB].map((r) => r.outcome)).toEqual(
      Array.from({ length: 4 }, () => 'resolved'),
    );
    expect(await pool.query('SELECT count(*)::int AS n FROM intake')).toMatchObject({
      rows: [{ n: 0 }],
    });

    for (const ticket of tickets) {
      const runs = await runRowsFor(ticket.id);
      // Exactly one run per ticket: neither consumer touched the other's
      // tickets, so no concurrent processing occurred.
      expect(runs).toHaveLength(1);
      const run = runs[0]!;
      expect(run.partition).toBe(partitionOf(ticket.id, PARTITION_COUNT));
      expect(run.state).toBe('resolved');
      // Attribution: the run carries the owning consumer's pinned prompt.
      expect(run.prompt_ver).toBe(ticket.partition <= 1 ? 'owner-a' : 'owner-b');
    }
  });

  it('carries the intake arrival time onto the run row (V2 open item 7)', async () => {
    const ticket = ticketIdInPartition(0);
    await enqueueTicket(pool, { ticketId: ticket, ticketText: TICKET_TEXT }, PARTITION_COUNT);

    const results = await processQueuedTickets(
      makeDeps(happyScript(), 'timing-owner'),
      optionsFor([0]),
    );
    expect(results.map((r) => r.outcome)).toEqual(['resolved']);

    // The ack deleted the intake row; the arrival time survives on the run.
    const intakeRows = await pool.query(
      'SELECT 1 FROM intake WHERE ticket_id = $1',
      [ticket],
    );
    expect(intakeRows.rows).toHaveLength(0);
    const rows = await pool.query(
      'SELECT enqueued_at, created_at, finished_at FROM run WHERE ticket_id = $1',
      [ticket],
    );
    expect(rows.rows).toHaveLength(1);
    const enqueuedAt = rows.rows[0]!.enqueued_at as Date;
    const createdAt = rows.rows[0]!.created_at as Date;
    const finishedAt = rows.rows[0]!.finished_at as Date;
    // All three stamps come from one Postgres clock, so they order
    // themselves: arrival, then pickup, then the terminal finish. The host
    // clock is not comparable here — the test container may lag it.
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(enqueuedAt.getTime());
    expect(finishedAt.getTime()).toBeGreaterThanOrEqual(createdAt.getTime());
  });

  it('keeps epochs monotonically increasing per ticket across repeated processing (DEC-28)', async () => {
    const ticketId = ticketIdInPartition(5);

    await enqueueTicket(pool, { ticketId, ticketText: TICKET_TEXT }, PARTITION_COUNT);
    const first = await processQueuedTickets(makeDeps(happyScript(), 'first'), optionsFor([5]));
    expect(first.map((r) => r.outcome)).toEqual(['resolved']);

    // Re-enqueue the same ticket (a customer replied): the next pickup reads
    // the fence and goes strictly above it.
    await enqueueTicket(pool, { ticketId, ticketText: TICKET_TEXT }, PARTITION_COUNT);
    const second = await processQueuedTickets(makeDeps(happyScript(), 'second'), optionsFor([5]));
    // Same action semantics as run one: the DEC-24 key collides, so the
    // replay stops superseded — but its writes still carried a higher epoch.
    expect(second.map((r) => r.outcome)).toEqual(['superseded']);

    const runs = await runRowsFor(ticketId);
    expect(runs.map((r) => Number(r.epoch))).toEqual([1, 2]);
    const fence = await pool.query(
      'SELECT epoch::text AS epoch FROM ticket_epoch WHERE ticket_id = $1',
      [ticketId],
    );
    expect(fence.rows[0]?.epoch).toBe('2');
    expect(await nextEpoch(pool, ticketId)).toBe(3n);
  });

  it('refuses a stale owner end to end after a rebalance (DEC-27 cost, DEC-28 safety)', async () => {
    const ticketId = ticketIdInPartition(6);

    // Normal operation first: the old owner processes the ticket, fence = 1.
    await enqueueTicket(pool, { ticketId, ticketText: TICKET_TEXT }, PARTITION_COUNT);
    await processQueuedTickets(makeDeps(happyScript(), 'old-owner'), optionsFor([6]));

    // Deployment moves ownership. The new owner claims the partition, which
    // bumps every fence in it.
    const bumped = await claimPartition(pool, 6);
    expect(bumped).toBe(1);
    let fence = await pool.query(
      'SELECT epoch::text AS epoch FROM ticket_epoch WHERE ticket_id = $1',
      [ticketId],
    );
    expect(fence.rows[0]?.epoch).toBe('2');

    // The old owner did not get the memo and re-runs its semantics with its
    // pre-rebalance epoch. Every fenced write is refused.
    const stale = await coordinateTicket(makeDeps(happyScript(), 'old-owner'), autoInput(ticketId, 1n));
    expect(stale.outcome).toBe('stale_epoch');
    if (stale.outcome === 'stale_epoch') expect(stale.highestAcceptedEpoch).toBe(2n);

    // And the new owner, reading the bumped fence, gets through.
    await enqueueTicket(pool, { ticketId, ticketText: TICKET_TEXT }, PARTITION_COUNT);
    const fresh = await processQueuedTickets(makeDeps(happyScript(), 'new-owner'), optionsFor([6]));
    expect(fresh.map((r) => r.outcome)).toEqual(['superseded']); // same semantics as run one
    fence = await pool.query(
      'SELECT epoch::text AS epoch FROM ticket_epoch WHERE ticket_id = $1',
      [ticketId],
    );
    expect(fence.rows[0]?.epoch).toBe('3');
  });

  it('an insert planned pre-bump may land at the equal fence; effects stay single-shot', async () => {
    // The reviewer's exact interleave: the old owner reads fence=1, plans
    // epoch 2; a rebalance bumps the fence to 2; the old owner's INSERT then
    // lands AT the equal fence and passes, because the ledger guard is strict
    // (`run.epoch < highest`). Refusing equality would break the
    // serialized-writer semantics pinned in src/ledger/concurrency.db.test.ts,
    // so this test pins instead why the window stays safe: even with both
    // epochs alive, DEC-24 makes the second execution of the same semantics
    // lose the outbox insert (superseded), so no second external effect is
    // possible — and the relay's send-time fence check ('fenced') backs that
    // up for any record already committed.
    const ticketId = ticketIdInPartition(4);

    // Normal operation first: run at epoch 1, fence 1, outbox row committed.
    await enqueueTicket(pool, { ticketId, ticketText: TICKET_TEXT }, PARTITION_COUNT);
    const setup = await processQueuedTickets(
      makeDeps(happyScript(), 'setup'),
      optionsFor([4]),
    );
    expect(setup.map((r) => r.outcome)).toEqual(['resolved']);

    // Old owner re-runs the SAME semantics while a rebalance lands inside its
    // read -> insert window.
    await enqueueTicket(pool, { ticketId, ticketText: TICKET_TEXT }, PARTITION_COUNT);
    const hookedDeps = {
      ...makeDeps(happyScript(), 'old-owner'),
      pool: wrappedPool(pool, 'FROM ticket_epoch', () => claimPartition(pool, 4)),
    };
    const oldOwner = await processQueuedTickets(hookedDeps, optionsFor([4]));

    // The equal-epoch insert passed (epoch 2 against fence 2), but the DEC-24
    // key collided with the setup run's outbox row: superseded, no new send.
    expect(oldOwner.map((r) => r.outcome)).toEqual(['superseded']);
    const outboxCount = await pool.query('SELECT count(*)::int AS n FROM outbox');
    expect(outboxCount.rows[0]?.n).toBe(1);
    const runs = await runRowsFor(ticketId);
    expect(runs.map((r) => Number(r.epoch))).toEqual([1, 2]);
    expect(runs.map((r) => r.state)).toEqual(['resolved', 'superseded']);
    expect(await pool.query('SELECT count(*)::int AS n FROM intake')).toMatchObject({
      rows: [{ n: 0 }],
    });

    // And the next owner proceeds above the fence as usual.
    await enqueueTicket(pool, { ticketId, ticketText: TICKET_TEXT }, PARTITION_COUNT);
    const freshAction = { ...actionSpec(), actionPayload: { queue: 'next-owner' } };
    const next = await processQueuedTickets(
      makeDeps(happyScript(), 'next-owner'),
      { partitions: [4], intervalMs: 1000, action: freshAction },
    );
    expect(next.map((r) => r.outcome)).toEqual(['resolved']);
    expect((await runRowsFor(ticketId)).map((r) => Number(r.epoch))).toEqual([1, 2, 3]);
  });

  it('a rebalance landing after the epoch read cuts the old owner off and keeps the ticket queued', async () => {
    // Second half of the overlap window: the bump lands AFTER the old owner's
    // fencedInsert accepted its pre-bump epoch. The new owner's raise must
    // refuse every later hop of the old run — including its outbox insert —
    // before any external effect, and F1 keeps the ticket queued so the new
    // owner redoes the work.
    const ticketId = ticketIdInPartition(3);

    await enqueueTicket(pool, { ticketId, ticketText: TICKET_TEXT }, PARTITION_COUNT);
    const setup = await processQueuedTickets(
      makeDeps(happyScript(), 'setup'),
      optionsFor([3]),
    );
    expect(setup.map((r) => r.outcome)).toEqual(['resolved']);

    await enqueueTicket(pool, { ticketId, ticketText: TICKET_TEXT }, PARTITION_COUNT);
    // Hook fires just before the first step_journal write, i.e. right after
    // the old owner's fencedInsert committed epoch 2 against fence 1.
    const hookedDeps = {
      ...makeDeps(happyScript(), 'old-owner'),
      pool: wrappedPool(
        pool,
        'INSERT INTO step_journal',
        () => claimPartition(pool, 3),
      ),
    };
    const oldOwner = await processQueuedTickets(hookedDeps, optionsFor([3]));
    expect(oldOwner.map((r) => r.outcome)).toEqual(['stale_epoch']);

    // F1: the refused ticket is NOT acked — the new owner must find it.
    expect(await pool.query('SELECT count(*)::int AS n FROM intake')).toMatchObject({
      rows: [{ n: 1 }],
    });
    // The cut-off run never produced external work.
    const oldRuns = await runRowsFor(ticketId);
    expect(oldRuns.map((r) => [Number(r.epoch), r.state, r.prompt_ver])).toEqual([
      [1, 'resolved', 'setup'],
      [2, 'received', 'old-owner'],
    ]);
    const oldOutbox = await pool.query(
      `SELECT count(*)::int AS n FROM outbox o JOIN run r ON r.run_id = o.run_id
       WHERE r.prompt_ver = 'old-owner'`,
    );
    expect(oldOutbox.rows[0]?.n).toBe(0);

    // New owner scans, reads the bumped fence, resolves the ticket.
    const freshAction = { ...actionSpec(), actionPayload: { queue: 'new-owner' } };
    const newOwner = await processQueuedTickets(
      makeDeps(happyScript(), 'new-owner'),
      { partitions: [3], intervalMs: 1000, action: freshAction },
    );
    expect(newOwner.map((r) => r.outcome)).toEqual(['resolved']);
    expect(await pool.query('SELECT count(*)::int AS n FROM intake')).toMatchObject({
      rows: [{ n: 0 }],
    });
    expect((await runRowsFor(ticketId)).map((r) => Number(r.epoch))).toEqual([1, 2, 4]);
  });

  it('refuses an old owner mid-run when a rebalance lands between two hops', async () => {
    const ticketId = ticketIdInPartition(7);
    const deadlineAt = new Date(Date.now() + 60_000);

    // Old owner created its run at epoch 1 and is between hops.
    const runId = '11111111-1111-4111-8111-111111111111';
    const started = await fencedInsert(
      pool,
      {
        runId,
        ticketId,
        partition: 7,
        epoch: 1n,
        state: 'received',
        promptVer: 'old-owner',
        modelVer: 'coord-test-model',
        deadlineAt,
      },
      null,
    );
    expect(started.outcome).toBe('accepted');

    // Rebalance: the new owner claims the partition mid-run.
    expect(await claimPartition(pool, 7)).toBe(1);

    // The old owner's next hop carries epoch 1 against a fence of 2: refused.
    const hop = await fencedTransition(pool, {
      runId,
      state: 'classified',
      costCents: 9,
      stepsUsed: 1,
    });
    expect(hop.outcome).toBe('stale_epoch');
    if (hop.outcome === 'stale_epoch') expect(hop.highestAcceptedEpoch).toBe(2n);

    // The run row is untouched by the refused hop.
    const state = await pool.query('SELECT state FROM run WHERE run_id = $1', [runId]);
    expect(state.rows[0]?.state).toBe('received');
  });
});
