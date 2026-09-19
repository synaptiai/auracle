// The consumer wakes on arrival instead of sleeping through it (issue #25).
//
// This suite measures the thing the issue exists to change, and it measures
// it the way `pnpm run latency` does: `run.created_at - run.enqueued_at`,
// read back off stored rows after a real loop picked a real queued message
// up. Nothing here is drawn from a model of the loop. The seeder models the
// loop and is checked separately; a model that agreed with itself would
// prove nothing about the code.
//
// The default poll interval below is short, so most cases finish in
// milliseconds. Issue #68 cut it from 4000 ms, because the whole suite was
// paying for a regime only some of its cases need.
//
// Three cases do need a slow poll, and each names its own interval rather
// than imposing one on the file. They assert that the tick is what picked a
// message up, or that no tick fired inside an observation window, and both
// properties are meaningless when the interval is close to the sleep beside
// it: the measurement then reads the clock rather than the consumer.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { ArrivalSignal } from './arrival-signal.js';
import { startConsumer } from './consumer.js';
import type { ConsumerOptions } from './consumer.js';
import type { CoordinatorDeps } from './coordinator.js';
import { enqueueTicket } from './intake.js';
import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { dbUrl } from '../db/config.js';
import { FakeProvider } from '../models/fake.js';
import type { AdapterCapabilities } from '../policy/policy.js';
import { truncateLedger } from '../test-support/schema.js';

const pool = new Pool({ connectionString: dbUrl(), max: 6 });

await pool.query('SELECT 1');

const PARTITION_COUNT = 8;
const PARTITIONS = [0, 1, 2, 3, 4, 5, 6, 7];
// A few hundred milliseconds. This was 4000, and cases waited up to twice
// that: the suite proves the consumer wakes on a signal rather than on the
// poll, so the poll only has to be slower than the signal, not slow.
const POLL_MS = 300;

/**
 * The interval used by the two cases that prove a signal picked a message up.
 *
 * Long enough that no poll tick can fire inside the case at all. That is what
 * makes those cases deterministic: the pickup is either the signal's doing or
 * it does not happen, so nothing rests on a wall-clock margin.
 *
 * A margin was the first approach and it did not survive a loaded machine.
 * The assertion `waited < 500` failed at 3896 ms during review and at 1943 ms
 * on a later run, both times on code that was working.
 */
const NO_TICK_MS = 120_000;

const CAPABILITIES: AdapterCapabilities = {
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
  supportsLedgerReply: false,
};

afterAll(async () => {
  await pool.end();
});

/**
 * A coordinator whose every step fails fast.
 *
 * The measurement is `created_at - enqueued_at`, which is stamped at pickup,
 * before any model call. So the run's own outcome does not matter and a
 * provider that answers nothing keeps each case short. What matters is that
 * a run row exists with both timestamps, which pickup guarantees.
 */
function deps(): CoordinatorDeps {
  return {
    pool,
    provider: new FakeProvider([]),
    taxonomy: { intents: [] },
    capabilities: CAPABILITIES,
    egress: new HelpdeskAdapter(),
    pins: { promptVer: 'wake-test-v1', modelVer: 'fake-model' },
    embedModelVer: 'fake-embed',
    // DEC-25. Present because the run row is written before the first model
    // call and the insert reads the deadline; a missing one throws ahead of
    // the insert, and then no row carries a queue wait to measure.
    limits: { maxCostMicros: 100_000_000, maxSteps: 50, deadlineAt: new Date(Date.now() + 60_000) },
    thresholds: { agreement: 0.7, coverageBlock: 0.7, coverageReview: 0.8 },
    partitionCount: PARTITION_COUNT,
  } as unknown as CoordinatorDeps;
}

function options(overrides: Partial<ConsumerOptions> = {}): ConsumerOptions {
  return {
    partitions: PARTITIONS,
    intervalMs: POLL_MS,
    action: {
      actionClass: 'route_ticket',
      delivery: 'at_least_once',
      isCustomerVisible: false,
    },
    maxIntakeAttempts: 1,
    ...overrides,
  } as ConsumerOptions;
}

/**
 * A pool that counts the poll statement, so a case can wait for a scan to
 * have happened rather than sleep and hope.
 *
 * Sleeping 300 ms and assuming the first scan is done is a wall-clock
 * assumption of exactly the kind these cases exist without. A first scan
 * slow to start reads the message itself, and then the case passes with the
 * wake mechanism deleted.
 */
function countingPool(onPoll?: () => void): { pool: Pool; polls: () => number } {
  let polls = 0;
  const proxy = new Proxy(pool, {
    get(target, key, receiver) {
      if (key !== 'query') return Reflect.get(target, key, receiver) as unknown;
      return async (...args: unknown[]): Promise<unknown> => {
        const isPoll = typeof args[0] === 'string' && args[0].includes('FROM intake i');
        const result = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
        if (isPoll) {
          polls += 1;
          onPoll?.();
        }
        return result;
      };
    },
  }) as Pool;
  return { pool: proxy, polls: () => polls };
}

/** Waits until at least `n` poll statements have completed. */
async function awaitPolls(count: () => number, n: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (count() < n) {
    if (Date.now() >= deadline) throw new Error(`only ${count()} polls in 15 s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * A signal fired by hand, standing in for a notification whose timing the
 * suite must control. `pgArrivalSignal` is proved separately against a real
 * Postgres; what these cases need is the arrival at a chosen instant.
 */
function signalByHand(): ArrivalSignal & { fire(partition: number): void } {
  let wake: ((partition: number) => void) | undefined;
  return {
    async start(w): Promise<void> {
      wake = w;
    },
    async stop(): Promise<void> {
      wake = undefined;
    },
    fire(partition): void {
      wake?.(partition);
    },
  };
}

/** The stored queue wait of the one run the ledger holds, in milliseconds. */
async function storedWaitMs(): Promise<number> {
  const { rows } = await pool.query<{ ms: number }>(
    `SELECT extract(epoch FROM (created_at - enqueued_at)) * 1000 AS ms
       FROM run WHERE enqueued_at IS NOT NULL ORDER BY created_at LIMIT 1`,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('no run carries a queue wait');
  return Number(row.ms);
}

/**
 * Waits until the ledger holds a run, or gives up after `budgetMs`.
 *
 * The deadline is checked after the query and not before it. Checking first
 * lets the budget overshoot by one query latency, and under load that
 * overshoot sailed past the poll tick: the tick-produced run was then read
 * as a wake, and only the final assertion caught it.
 */
async function awaitRun(budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM run WHERE enqueued_at IS NOT NULL',
    );
    if ((rows[0]?.n ?? 0) > 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function enqueueOne(): Promise<void> {
  await enqueueTicket(
    pool,
    {
      ticketId: randomUUID(),
      messageId: randomUUID(),
      ticketText: 'a synthetic ticket',
    },
    PARTITION_COUNT,
  );
}

describe('the consumer loop', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  // The measurement this issue exists to move. A message arriving just after
  // a scan waits for the next tick today; with the signal it is picked up at
  // once.
  //
  // The wake is fired in process rather than over a real notification. The
  // loop, the ledger and the measured quantity are all real — this is the
  // same `created_at - enqueued_at` that `pnpm run latency` reports, read
  // back off the stored row. Only the transport is stubbed, and
  // `arrival-signal.db.test.ts` owns that end of it against a real Postgres.
  //
  // That seam is what makes the case deterministic. With the notification
  // round trip inside the budget, this assertion failed on unmutated code
  // during review at 3896 ms: the wall time ran past the 4 s tick and the
  // tick-produced run read as a wake.
  it('picks a message up with no poll tick available to do it', async () => {
    const manual = signalByHand();
    const counted = countingPool();
    const consumer = startConsumer(
      { ...deps(), pool: counted.pool },
      options({ signal: manual, intervalMs: NO_TICK_MS }),
    );
    try {
      // After the first scan has actually polled, so the message cannot be
      // caught by it. The next scan is two minutes away, so nothing but the
      // signal can produce a run.
      await awaitPolls(counted.polls, 1);
      await enqueueOne();
      manual.fire(0);
      expect(await awaitRun(15_000)).toBe(true);
    } finally {
      await consumer.stop();
    }
    // The stored quantity `pnpm run latency` reports, read back off the row.
    // The bound is generous because the existence of the run is the proof;
    // this only witnesses that the figure is a wait and not a tick.
    expect(await storedWaitMs()).toBeLessThan(NO_TICK_MS / 4);
  });

  // The same case with no signal supplied. This is the loop that ships
  // today, and it is the falsification of the case above: if the assertion
  // above passed without the signal doing any work, this one would fail.
  // This case owns a slow interval, because its property is that the wait is
  // the interval. The suite's default is a few hundred milliseconds (issue
  // #68), and at that speed a message is picked up so quickly that "it waited
  // for a tick" and "it was picked up at once" are indistinguishable.
  it('waits for the poll tick when no signal is supplied', async () => {
    const slowPoll = 2_000;
    const consumer = startConsumer(deps(), options({ intervalMs: slowPoll }));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await enqueueOne();
      expect(await awaitRun(slowPoll * 2)).toBe(true);
    } finally {
      await consumer.stop();
    }
    const waited = await storedWaitMs();
    // Enqueued 300ms into a 2s interval, so the message waits most of what is
    // left. Half the interval is the floor that separates a wait from a
    // pickup without one.
    expect(waited).toBeGreaterThan(slowPoll / 2);
  });

  // A lost signal must cost latency and nothing else. The ceiling is the
  // guarantee that makes the notification an optimisation rather than an
  // authority, so it is asserted with a signal that never fires.
  it('still picks the message up on the interval ceiling when the signal is silent', async () => {
    const silent: ArrivalSignal = {
      start: async (): Promise<void> => undefined,
      stop: async (): Promise<void> => undefined,
    };
    // This case owns a slow interval, for the same reason as the poll-tick
    // case above: its property is that the ceiling is what picked the message
    // up. At the suite's default the settle below would equal the interval,
    // the enqueue would land on a tick boundary, and the measured wait would
    // be the few milliseconds to the next scan — a number that says nothing
    // about the ceiling. Measured at 8 to 15ms before this was fixed.
    const slowPoll = 2_000;
    const settleMs = 200;
    const consumer = startConsumer(deps(), options({ signal: silent, intervalMs: slowPoll }));
    try {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
      await enqueueOne();
      expect(await awaitRun(slowPoll * 2)).toBe(true);
    } finally {
      await consumer.stop();
    }
    // Above half a poll period, so the ceiling is what picked it up rather
    // than some other wake. `created_at - enqueued_at` is never exactly
    // zero, so a `toBeGreaterThan(0)` here asserted nothing at all.
    expect(await storedWaitMs()).toBeGreaterThan(slowPoll / 2);
  });

  // A signal landing while a scan runs must not be dropped. Dropping it
  // costs a full interval, which is the defect this issue removes.
  //
  // The timing is forced rather than hoped for. The first scan's poll is
  // held open after it has read — so it saw an empty queue — and the message
  // is queued and signalled while it is held. When the scan then ends, the
  // loop must rescan. The interval is two minutes here, so a loop that
  // dropped the arrival would leave the message queued for the whole case.
  it('rescans immediately for a signal that arrives mid-scan', async () => {
    const manual = signalByHand();
    const gate: { release: () => void } = { release: (): void => undefined };
    const held = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    let holdsLeft = 1;
    const holding = {
      ...deps(),
      pool: new Proxy(pool, {
        get(target, key, receiver) {
          if (key !== 'query') return Reflect.get(target, key, receiver) as unknown;
          return async (...args: unknown[]): Promise<unknown> => {
            const result = await (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
            if (holdsLeft > 0) {
              holdsLeft -= 1;
              await held;
            }
            return result;
          };
        },
      }) as Pool,
    };
    const consumer = startConsumer(holding, options({ signal: manual, intervalMs: NO_TICK_MS }));
    try {
      // The first poll has now run and returned nothing, and it is held.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await enqueueOne();
      manual.fire(0);
      gate.release();
      // No tick can rescue this within the budget, so a run appearing is
      // the rescan and nothing else.
      expect(await awaitRun(15_000)).toBe(true);
    } finally {
      gate.release();
      await consumer.stop();
    }
  });

  // A signal that will not start must not take the loop down with it. The
  // module says failing to listen is not fatal, because a daemon that
  // refused to start over a lost optimisation would trade seconds of
  // latency for an outage. Nothing asserted it.
  it('keeps polling when the signal refuses to start', async () => {
    const refuses = {
      start: async (): Promise<void> => {
        throw new Error('the listener could not connect');
      },
      stop: async (): Promise<void> => undefined,
    };
    const consumer = startConsumer(deps(), options({ signal: refuses }));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await enqueueOne();
      expect(await awaitRun(POLL_MS * 2)).toBe(true);
    } finally {
      await consumer.stop();
    }
  });

  // A notification needs no grant in Postgres, so any role that can open a
  // session on the ledger can send one — a read-only reporting role
  // included. Without a floor, a stream of notifications for rows that do
  // not exist holds the loop in a tight poll for as long as it lasts.
  //
  // The floor applies only after a scan that found nothing, so a real
  // arrival never pays it.
  it('bounds the scan rate a signal alone can drive', async () => {
    const manual = signalByHand();
    let scans = 0;
    const counting = {
      ...deps(),
      pool: new Proxy(pool, {
        get(target, key, receiver) {
          if (key !== 'query') return Reflect.get(target, key, receiver) as unknown;
          return async (...args: unknown[]): Promise<unknown> => {
            if (typeof args[0] === 'string' && args[0].includes('FROM intake i')) scans += 1;
            return (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
          };
        },
      }) as Pool,
    };
    const consumer = startConsumer(counting, options({ signal: manual }));
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const before = scans;
      const forFor = 600;
      const until = Date.now() + forFor;
      // As fast as the event loop allows, for a partition this consumer
      // owns, with nothing ever queued.
      while (Date.now() < until) {
        manual.fire(0);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Thousands of notifications land in that window. The floor caps the
      // scans they can buy at one per SIGNAL_FLOOR_MS; without it the count
      // tracks the notifications. The margin is generous in one direction
      // only: a loose ceiling here would pass a floor that had been widened
      // by accident, so it is set from the constant rather than guessed.
      const floorMs = 50;
      expect(scans - before).toBeLessThanOrEqual(Math.ceil(forFor / floorMs) + 2);
    } finally {
      await consumer.stop();
    }
  });

  // The floor must hold when the scan is returning rows it cannot drain.
  //
  // A count of polled rows is the wrong proxy for progress: the abandonment
  // path can throw without bound, leaving the message queued and reporting an
  // outcome every scan. A loop that read that as work would skip the floor on
  // every iteration and spin hardest against a ledger already failing, which
  // is the opposite of what the floor is for.
  it('keeps the floor when the scan drains nothing it polled', async () => {
    const manual = signalByHand();
    let scans = 0;
    const failing = {
      ...deps(),
      pool: new Proxy(pool, {
        get(target, key, receiver) {
          if (key !== 'query') return Reflect.get(target, key, receiver) as unknown;
          return async (...args: unknown[]): Promise<unknown> => {
            const sql = typeof args[0] === 'string' ? args[0] : '';
            if (sql.includes('FROM intake i')) scans += 1;
            // Every ledger write for this run fails, so the message is
            // polled on each scan and never leaves the queue.
            if (sql.includes('INSERT INTO run')) throw new Error('the ledger is refusing writes');
            return (target.query as (...a: unknown[]) => Promise<unknown>)(...args);
          };
        },
      }) as Pool,
    };
    await enqueueOne();
    const consumer = startConsumer(failing, options({ signal: manual, maxIntakeAttempts: 10_000 }));
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const before = scans;
      const forFor = 600;
      const until = Date.now() + forFor;
      while (Date.now() < until) {
        manual.fire(0);
        await new Promise((resolve) => setImmediate(resolve));
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(scans - before).toBeLessThanOrEqual(Math.ceil(forFor / 50) + 2);
    } finally {
      await consumer.stop();
    }
  });

  // A wake for a partition this consumer does not own buys nothing and costs
  // a scan. Every consumer in a deployment hears every arrival, so without
  // the filter one busy partition wakes the whole fleet.
  it('ignores a wake for a partition it does not own', async () => {
    const manual = signalByHand();
    let scans = 0;
    const counting = {
      ...deps(),
      pool: new Proxy(pool, {
        get(target, key) {
          if (key === 'query') scans += 1;
          return Reflect.get(target, key) as unknown;
        },
      }) as Pool,
    };
    // A poll must not fire inside the observation window, or the count below
    // measures the clock rather than the filter. So this case names an
    // interval far longer than the window it watches.
    const consumer = startConsumer(
      counting,
      options({ partitions: [0], signal: manual, intervalMs: 30_000 }),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const before = scans;
      manual.fire(7);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(scans).toBe(before);
    } finally {
      await consumer.stop();
    }
  });
});
