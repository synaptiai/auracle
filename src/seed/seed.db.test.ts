// The seeded history is reproducible, and it goes in through the real path.
//
// Reproducibility is the property a band rests on: a baseline built from a
// history nobody can rebuild is a number nobody can check. So it is asserted
// against the ledger itself, twice, not against the plan or the artifact.
//
// Three days rather than forty-five. The property is the same at either size
// and the suite runs against a container.
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { applyLedgerSchema } from '../test-support/schema.js';
import { readDays } from '../bands/query.js';
import { readLatency } from '../latency/query.js';
import { planHistory } from './plan.js';
import { writeHistory } from './write.js';

const pool = new Pool({ connectionString: dbUrl(), max: 8 });

await pool.query('SELECT 1');

const OPTIONS = { seed: 0x41726361, days: 3, endDay: '2026-06-30', partitions: 4, provider: 'stub' };

async function truncate(): Promise<void> {
  await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, intake, conversation, turn');
}

/** Every column of the ledger a second run must reproduce exactly. */
async function ledgerFingerprint(): Promise<string> {
  const runs = await pool.query(
    `SELECT run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
            created_at, enqueued_at, finished_at, approval_edit_distance, conversation_id
       FROM run ORDER BY run_id`,
  );
  const steps = await pool.query(
    'SELECT run_id, step_id, status, result FROM step_journal ORDER BY run_id, step_id',
  );
  const outbox = await pool.query(
    'SELECT run_id, idem_key, status, action_class FROM outbox ORDER BY idem_key',
  );
  return JSON.stringify({ runs: runs.rows, steps: steps.rows, outbox: outbox.rows });
}

afterAll(async () => {
  await truncate();
  await pool.end();
});

describe('the seeded history', () => {
  beforeEach(async () => {
    await applyLedgerSchema(pool);
    await truncate();
  });

  // The acceptance criterion, asserted over the ledger rather than the plan.
  // A planner that was deterministic and a writer that was not would pass a
  // plan-level check and fail this one.
  it('is byte-reproducible from its seed', async () => {
    await writeHistory(pool, planHistory(OPTIONS));
    const first = await ledgerFingerprint();

    await truncate();
    await writeHistory(pool, planHistory(OPTIONS));
    const second = await ledgerFingerprint();

    expect(second).toBe(first);
    expect(first.length).toBeGreaterThan(1000);
  });

  it('gives a different ledger from a different seed', async () => {
    await writeHistory(pool, planHistory(OPTIONS));
    const first = await ledgerFingerprint();

    await truncate();
    await writeHistory(pool, planHistory({ ...OPTIONS, seed: OPTIONS.seed + 1 }));
    expect(await ledgerFingerprint()).not.toBe(first);
  });

  it('has the ledger accept every run it plans', async () => {
    const plan = planHistory(OPTIONS);
    const report = await writeHistory(pool, plan);
    expect(report.refused).toBe(0);
    expect(report.accepted).toBe(plan.length);
  });

  // Through fencedInsert with a clock, so the epoch, the transaction and the
  // journal are the ones a live run takes. Read back off the stored rows.
  it('records the timing the plan chose, not the wall clock', async () => {
    const plan = planHistory(OPTIONS);
    await writeHistory(pool, plan);
    const { rows } = await pool.query(
      'SELECT created_at, enqueued_at, finished_at FROM run WHERE run_id = $1',
      [plan[0]!.runId],
    );
    const row = rows[0] as { created_at: Date; enqueued_at: Date; finished_at: Date | null };
    expect(row.created_at.toISOString()).toBe(plan[0]!.createdAt.toISOString());
    expect(row.enqueued_at.toISOString()).toBe(plan[0]!.enqueuedAt.toISOString());
    expect(row.finished_at?.toISOString() ?? null).toBe(
      plan[0]!.finishedAt?.toISOString() ?? null,
    );
  });

  // Reproducibility means one seed and one day always give the same run ids,
  // so writing the same window twice collides on the primary key. That is the
  // property working, and it is a refusal rather than a fault — but the raw
  // driver error is a stack trace about an index file, so it is named.
  it('refuses by name when the ledger already holds the history', async () => {
    await writeHistory(pool, planHistory(OPTIONS));
    await expect(writeHistory(pool, planHistory(OPTIONS))).rejects.toThrow(
      /already holds run/,
    );
  });

  // And two windows that share a seed do not collide, because each day mixes
  // the day string into its own stream. Seeding one extra day after a long
  // history used to regenerate the first day's ids.
  it('writes a neighbouring day without colliding on the same seed', async () => {
    await writeHistory(pool, planHistory(OPTIONS));
    const before = await pool.query('SELECT count(*)::int AS n FROM run');
    const extra = await writeHistory(
      pool,
      planHistory({ ...OPTIONS, days: 1, endDay: '2026-07-01' }),
    );
    expect(extra.refused).toBe(0);
    expect(extra.accepted).toBeGreaterThan(0);
    const after = await pool.query('SELECT count(*)::int AS n FROM run');
    expect((after.rows[0] as { n: number }).n).toBe(
      (before.rows[0] as { n: number }).n + extra.accepted,
    );
  });

  it('writes a fencing epoch for every ticket, as the real path does', async () => {
    const plan = planHistory(OPTIONS);
    await writeHistory(pool, plan);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM ticket_epoch');
    expect((rows[0] as { n: number }).n).toBe(new Set(plan.map((r) => r.ticketId)).size);
  });
});

describe('the readers over the seeded history', () => {
  beforeEach(async () => {
    await applyLedgerSchema(pool);
    await truncate();
    await writeHistory(pool, planHistory(OPTIONS));
  });

  it('gives bands a day whose provider is named', async () => {
    const days = await readDays(
      pool,
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
    );
    expect(days.length).toBeGreaterThanOrEqual(3);
    for (const day of days) expect(day.provider).toBe('stub');
  });

  it('gives bands a measured value for every metric it can measure', async () => {
    const days = await readDays(
      pool,
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
    );
    const day = days.at(-1)!;
    expect(day.samples.abstain_rate.value).not.toBeNull();
    expect(day.samples.gate_pass_rate.value).not.toBeNull();
    expect(day.samples.approval_edit_distance.value).not.toBeNull();
    expect(day.samples.relay_delivery_unknown_count.value).not.toBeNull();
  });

  // No seeded run lands in a column that means the ledger is wrong.
  //
  // `unfinished` is the exception, and it is not a defect: a run parked at
  // `awaiting_approval` is waiting for a person and genuinely has no service
  // time yet. DEC-12 puts a person on every customer reply, so a real ledger
  // always holds some. The other five columns each mean the row taught the
  // reader nothing, and none of them may hold a seeded run.
  it('leaves no seeded run in a latency column that means a broken ledger', async () => {
    const report = await readLatency(pool);
    expect(report.runs).toBeGreaterThan(0);
    let unfinished = 0;
    for (const p of report.partitions) {
      expect(p.wait.unmeasured).toBe(0);
      expect(p.wait.unordered).toBe(0);
      expect(p.service.unstamped).toBe(0);
      expect(p.service.unordered).toBe(0);
      expect(p.service.neverRan).toBe(0);
      unfinished += p.service.unfinished;
    }
    // Present, and counted under its own name rather than folded away.
    expect(unfinished).toBeGreaterThan(0);
  });

  it('loads every partition, so the report has something to compare', async () => {
    const report = await readLatency(pool);
    expect(report.partitions).toHaveLength(OPTIONS.partitions);
    for (const p of report.partitions) expect(p.wait.count).toBeGreaterThan(0);
  });
});
