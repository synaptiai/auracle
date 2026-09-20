// Integration suite for the control-band report (bands.yaml, sections 4.10
// and 5).
//
// Seeds runs through the real write path and then sets `created_at` to a day
// this suite chose, so every number below is one the suite decided. A test
// that asserted whatever the query returned would prove only that the query
// is deterministic.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { truncateLedger } from '../test-support/schema.js';
import { fencedInsert } from '../ledger/insert.js';
import type { FencedRunInput } from '../ledger/insert.js';
import { readDays } from './query.js';
import { WINDOW_DAYS } from './metrics.js';
import { loadBandsArtifact } from './artifact.js';
import { runBandsJob } from './run.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

/**
 * A pool shaped like the one the command builds.
 *
 * `runBandsJob` refuses a connection it cannot prove read-only, so a case that
 * exercises the job needs one. The seeding above still uses the plain pool:
 * it writes, which is the point.
 */
const readOnlyPool = new Pool({
  connectionString: dbUrl(),
  max: 2,
  options: '-c default_transaction_read_only=on -c statement_timeout=60000',
});

// The global setup guarantees a reachable database before the workers fork.
// A failure here is a fault, and a suite that skipped itself would report
// success while proving nothing.
await pool.query('SELECT 1');

const MINUTE = 60_000;

interface SeedOptions {
  /** UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  /** The run's state. Defaults to a terminal one. */
  state?: string;
  /** The compose step's outcome, or absent for a run that never composed. */
  abstained?: boolean;
  /** What answered the run's model calls, recorded beside the compose outcome. */
  provider?: string;
  /** The gate step's reason, or absent for a run that never gated. */
  reason?: string;
  /** A gate step journalled before the reason existed. */
  gateWithoutReason?: boolean;
  /** A gate the groundedness judge made unreadable: status failed, no reason. */
  gateFailed?: boolean;
  /** The value on the run row, or absent for a run nobody approved. */
  editDistance?: number;
  /** Outbox rows to attach, by status. */
  outbox?: readonly string[];
}

async function seedRun(opts: SeedOptions): Promise<string> {
  const run: FencedRunInput = {
    runId: randomUUID(),
    ticketId: 'T-' + randomUUID().slice(0, 8),
    partition: 0,
    epoch: 1n,
    state: opts.state ?? 'resolved',
    promptVer: 'p1',
    modelVer: 'm1',
    deadlineAt: new Date(Date.now() + MINUTE),
  };
  expect(await fencedInsert(pool, run, null)).toEqual({ outcome: 'accepted' });

  // Noon UTC, so a timezone the database happens to run in cannot move the
  // row into the day before or after.
  await pool.query('UPDATE run SET created_at = $2, approval_edit_distance = $3 WHERE run_id = $1', [
    run.runId,
    new Date(`${opts.day}T12:00:00.000Z`),
    opts.editDistance ?? null,
  ]);

  if (opts.abstained !== undefined) {
    await pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, 'compose', 'done', $2::jsonb, 'p1', 'm1', 0)`,
      [
        run.runId,
        JSON.stringify(
          opts.provider === undefined
            ? { abstained: opts.abstained }
            : { abstained: opts.abstained, provider: opts.provider },
        ),
      ],
    );
  }
  if (opts.reason !== undefined || opts.gateWithoutReason === true || opts.gateFailed === true) {
    // The exact shape the coordinator files on an unreadable judge answer:
    // status 'failed', a non-null result, and no reason inside it.
    const failed = opts.gateFailed === true;
    const result = failed
      ? { shape: 'no-verdict', error: 'unreadable verdict' }
      : opts.gateWithoutReason === true
        ? { decision: 'gated', groundedness: 1 }
        : { decision: 'auto', groundedness: 1, reason: opts.reason };
    await pool.query(
      `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
       VALUES ($1, 'gate', $3, $2::jsonb, 'p1', 'm1', 0)`,
      [run.runId, JSON.stringify(result), failed ? 'failed' : 'done'],
    );
  }
  for (const [i, status] of (opts.outbox ?? []).entries()) {
    await pool.query(
      `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery, payload, status)
       VALUES ($1, $2, $3, 1, 'route_ticket', 'at_most_once', '{}'::jsonb, $4)`,
      [run.runId, `execute-${i}`, `${run.runId}-${i}`, status],
    );
  }
  return run.runId;
}

/** The whole window plus a margin, so no seeded day falls outside the read. */
const FROM = new Date('2026-01-01T00:00:00.000Z');
const TO = new Date('2026-04-01T00:00:00.000Z');

describe('the control-band daily sample', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  afterAll(async () => {
    // The last case's rows would otherwise survive against an explicit
    // DATABASE_URL, which is the mode AGENTS.md documents.
    await truncateLedger(pool);
    await pool.end();
    await readOnlyPool.end();
  });

  it('reports one row per day that holds a run, and none for a day that holds none', async () => {
    await seedRun({ day: '2026-02-01' });
    await seedRun({ day: '2026-02-01' });
    await seedRun({ day: '2026-02-03' });

    const days = await readDays(pool, FROM, TO);
    expect(days.map((d) => d.day)).toEqual(['2026-02-01', '2026-02-03']);
    expect(days[0]!.runs).toBe(2);
    expect(days[1]!.runs).toBe(1);
  });

  // Issue #23. The provider is read off the compose journal row, so it must
  // survive the round trip through the query, not merely be written.
  it('reads back one provider for a day whose runs agree', async () => {
    await seedRun({ day: '2026-03-01', abstained: false, provider: 'stub' });
    await seedRun({ day: '2026-03-01', abstained: true, provider: 'stub' });
    const days = await readDays(pool, new Date('2026-03-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'));
    expect(days).toHaveLength(1);
    expect(days[0]!.provider).toBe('stub');
    // And every metric of the day carries it, because the provider answered
    // the day's runs and not the day's metrics.
    expect(days[0]!.samples.abstain_rate.provider).toBe('stub');
    expect(days[0]!.samples.gate_pass_rate.provider).toBe('stub');
  });

  // A day that mixed providers is not a day from either of them, and it is
  // not a day that recorded nothing either. It reports the mixed sentinel, so
  // a window of nothing but mixed days still refuses a verdict.
  it('reads back the mixed sentinel for a day whose runs disagree', async () => {
    await seedRun({ day: '2026-03-01', abstained: false, provider: 'stub' });
    await seedRun({ day: '2026-03-01', abstained: true, provider: 'model' });
    const days = await readDays(pool, new Date('2026-03-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'));
    expect(days[0]!.provider).toBe('mixed');
  });

  // A run recorded before the field existed, beside one recorded after. The
  // day cannot be proven unanimous, so it is not claimed to be.
  it('reads back the mixed sentinel for a day holding a run with no provider', async () => {
    await seedRun({ day: '2026-03-01', abstained: false, provider: 'stub' });
    await seedRun({ day: '2026-03-01', abstained: true });
    const days = await readDays(pool, new Date('2026-03-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'));
    expect(days[0]!.provider).toBe('mixed');
  });

  // A run that never composed made no model call, so it cannot testify to a
  // provider. Counting its absence as a disagreement made one unreadable
  // classifier answer silence every metric for the thirty days that window
  // covers — the opposite of what the guard is for.
  //
  // Runs reach this shape constantly: abandonMessage files one with 'intake'
  // pins and only an escalate row, and classifier_unreadable, limit_cost and
  // limit_steps all stop before the compose step starts.
  it('ignores a run that never composed when reading the day provider', async () => {
    await seedRun({ day: '2026-03-01', abstained: false, provider: 'stub' });
    // No `abstained`, so no compose row at all: the run stopped earlier.
    await seedRun({ day: '2026-03-01', reason: 'auto' });
    const days = await readDays(pool, new Date('2026-03-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'));
    expect(days[0]!.provider).toBe('stub');
  });

  // But a run that DID compose and recorded no provider is a real
  // disagreement: it is the deploy boundary, one side of which knows.
  it('reads mixed for a day holding a compose that recorded no provider', async () => {
    await seedRun({ day: '2026-03-01', abstained: false, provider: 'stub' });
    await seedRun({ day: '2026-03-01', abstained: true });
    const days = await readDays(pool, new Date('2026-03-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'));
    expect(days[0]!.provider).toBe('mixed');
  });

  // Only this case is null: a day where nothing recorded a provider at all.
  it('reads back null for a day where nothing recorded a provider', async () => {
    await seedRun({ day: '2026-03-01', abstained: false });
    const days = await readDays(pool, new Date('2026-03-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'));
    expect(days[0]!.provider).toBeNull();
  });

  // The privacy guard over the payload is a text scan, so it cannot see what
  // a value actually holds. This drives a value the read path must refuse
  // rather than asserting a bound on one the test itself wrote — which is
  // what the first version did, and it could not fail (DEC-18).
  it('refuses a provider value that is not one the field declares', async () => {
    const essay = 'x'.repeat(4096);
    await seedRun({ day: '2026-03-01', abstained: false, provider: essay });
    const days = await readDays(pool, new Date('2026-03-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'));
    // Treated as unrecorded, so nothing long reaches the artifact.
    expect(days[0]!.provider).toBeNull();
  });

  // The two the field declares, and nothing else. A short name that nobody
  // declared is still refused, because the guard is an allowlist and not a
  // length bound.
  it('carries only the two providers the field declares', async () => {
    await seedRun({ day: '2026-03-02', abstained: false, provider: 'stub' });
    await seedRun({ day: '2026-03-03', abstained: false, provider: 'model' });
    await seedRun({ day: '2026-03-04', abstained: false, provider: 'gpt' });
    const days = await readDays(pool, new Date('2026-03-02T00:00:00Z'), new Date('2026-03-05T00:00:00Z'));
    expect(days.map((d) => d.provider)).toEqual(['stub', 'model', null]);
  });

  it('computes the abstain rate over runs that composed, and counts the rest', async () => {
    await seedRun({ day: '2026-02-01', abstained: true });
    await seedRun({ day: '2026-02-01', abstained: false });
    await seedRun({ day: '2026-02-01', abstained: false });
    // Never composed: the run stopped earlier. It is not a run that declined
    // to abstain, so it belongs in neither half of the rate.
    await seedRun({ day: '2026-02-01' });

    const [day] = await readDays(pool, FROM, TO);
    const sample = day!.samples.abstain_rate;
    expect(sample.value).toBeCloseTo(1 / 3, 12);
    expect(sample.count).toBe(3);
    expect(sample.notReached).toBe(1);
  });

  // The metric bands.yaml sources from "the classifier agreement gate". A
  // customer reply is gated before agreement is ever compared (DEC-12), so
  // counting it as a failure would make the rate track traffic mix.
  it('computes the gate rate over runs that reached the agreement comparison', async () => {
    await seedRun({ day: '2026-02-01', reason: 'auto' });
    await seedRun({ day: '2026-02-01', reason: 'groundedness_review' });
    await seedRun({ day: '2026-02-01', reason: 'agreement' });
    // Short-circuited before the comparison: excluded from both halves.
    await seedRun({ day: '2026-02-01', reason: 'customer_visible' });
    await seedRun({ day: '2026-02-01', reason: 'high_risk' });
    // Never gated at all.
    await seedRun({ day: '2026-02-01' });

    const [day] = await readDays(pool, FROM, TO);
    const sample = day!.samples.gate_pass_rate;
    // Two of the three that reached it cleared it. A run that cleared
    // agreement and then failed on groundedness passed THIS gate (DEC-05).
    expect(sample.value).toBeCloseTo(2 / 3, 12);
    expect(sample.count).toBe(3);
    expect(sample.notReached).toBe(3);
    expect(sample.unrecorded).toBe(0);
  });

  // Every run journalled before the reason existed carries a gate row without
  // one. "We cannot tell" is not "it did not reach the gate", so it gets its
  // own count: the remedy is to wait for the ledger to turn over.
  it('counts a gate step with no reason under its own name', async () => {
    await seedRun({ day: '2026-02-01', reason: 'auto' });
    await seedRun({ day: '2026-02-01', gateWithoutReason: true });
    await seedRun({ day: '2026-02-01', gateWithoutReason: true });

    const [day] = await readDays(pool, FROM, TO);
    const sample = day!.samples.gate_pass_rate;
    expect(sample.value).toBe(1);
    expect(sample.count).toBe(1);
    expect(sample.unrecorded).toBe(2);
    expect(sample.notReached).toBe(0);
  });

  // A gate the judge made unreadable is a live fault, not a legacy row. It
  // stopped before the policy engine ran, so it never reached the agreement
  // comparison. Counting it as unrecorded made that count rise forever, and
  // the runbook's remedy — wait for the ledger to turn over — was then wrong.
  it('counts a failed gate as not reached, not as unrecorded', async () => {
    await seedRun({ day: '2026-02-01', reason: 'auto' });
    await seedRun({ day: '2026-02-01', gateFailed: true });
    await seedRun({ day: '2026-02-01', gateFailed: true });

    const [day] = await readDays(pool, FROM, TO);
    const sample = day!.samples.gate_pass_rate;
    expect(sample.value).toBe(1);
    expect(sample.count).toBe(1);
    expect(sample.unrecorded).toBe(0);
    expect(sample.notReached).toBe(2);
  });

  it('averages the approval-edit distance over approvals, not over runs', async () => {
    await seedRun({ day: '2026-02-01', editDistance: 0.2 });
    await seedRun({ day: '2026-02-01', editDistance: 0.6 });
    // Never approved: null, and null is not a distance of zero. Averaging
    // over it would report the flattering answer about the runs the ledger
    // knows least about.
    await seedRun({ day: '2026-02-01' });

    const [day] = await readDays(pool, FROM, TO);
    const sample = day!.samples.approval_edit_distance;
    expect(sample.value).toBeCloseTo(0.4, 12);
    expect(sample.count).toBe(2);
    expect(sample.notReached).toBe(1);
  });

  // Two values are written after the run is picked up: the edit distance at
  // approval, and the delivery status when the relay gives up. Neither table
  // records when that happened, so both are filed under the pickup day and a
  // recent day is provisional. The count says how much is still to land.
  it('counts what has still to land, beside the value it would change', async () => {
    await seedRun({ day: '2026-02-01', editDistance: 0.4 });
    await seedRun({ day: '2026-02-01', state: 'awaiting_approval' });
    await seedRun({ day: '2026-02-01', state: 'awaiting_approval' });
    await seedRun({ day: '2026-02-01', outbox: ['pending'] });

    const [day] = await readDays(pool, FROM, TO);
    const edit = day!.samples.approval_edit_distance;
    expect(edit.value).toBeCloseTo(0.4, 12);
    expect(edit.count).toBe(1);
    // Two runs are still waiting for a person, so this mean can still move.
    expect(edit.pending).toBe(2);

    const stuck = day!.samples.relay_delivery_unknown_count;
    expect(stuck.value).toBe(0);
    // One record the relay has not resolved could still become unknown.
    expect(stuck.pending).toBe(1);

    // Pending overlaps the exclusions rather than partitioning with them.
    expect(edit.count + edit.notReached + edit.unrecorded).toBe(day!.runs);
  });

  // DEC-48: a case a person closed with no reply. Nobody approved it and no
  // reply was sent, so it carries no edit distance and counts as not reached.
  // It is not pending either: it has left the queue, and the day's totals
  // still account for it.
  it('counts a closed case as not reached, and never as one still to land', async () => {
    await seedRun({ day: '2026-02-01', editDistance: 0.4 });
    await seedRun({ day: '2026-02-01', state: 'closed' });
    await seedRun({ day: '2026-02-01', state: 'awaiting_approval' });

    const [day] = await readDays(pool, FROM, TO);
    const edit = day!.samples.approval_edit_distance;
    expect(edit.count).toBe(1);
    expect(edit.notReached).toBe(2);
    // Only the waiting run is still to land. A closed case counted here would
    // report a queue that is holding work nobody is doing.
    expect(edit.pending).toBe(1);
    expect(edit.count + edit.notReached + edit.unrecorded).toBe(day!.runs);
  });

  // DEC-48: a snoozed case has left the queue without ending, so it is still
  // to land. Counting it as not pending would report a case nobody is working
  // as one that is already settled.
  it('counts a snoozed case as still to land, beside the ones waiting for a person', async () => {
    await seedRun({ day: '2026-02-01', editDistance: 0.4 });
    const snoozed = await seedRun({ day: '2026-02-01', state: 'snoozed' });
    await pool.query(
      "UPDATE run SET snoozed_until = now() + interval '2 hours' WHERE run_id = $1",
      [snoozed],
    );
    await seedRun({ day: '2026-02-01', state: 'awaiting_approval' });

    const [day] = await readDays(pool, FROM, TO);
    const edit = day!.samples.approval_edit_distance;
    expect(edit.pending).toBe(2);
    // And the identity still holds: pending overlaps the exclusions.
    expect(edit.count + edit.notReached + edit.unrecorded).toBe(day!.runs);
  });

  it('counts a run with a stuck delivery once, however many records are stuck', async () => {
    await seedRun({ day: '2026-02-01', outbox: ['delivery_unknown', 'delivery_unknown'] });
    await seedRun({ day: '2026-02-01', outbox: ['sent'] });
    await seedRun({ day: '2026-02-01' });

    const [day] = await readDays(pool, FROM, TO);
    const sample = day!.samples.relay_delivery_unknown_count;
    expect(sample.value).toBe(1);
    // The population is the day's runs: this metric is a count, not a rate.
    expect(sample.count).toBe(3);
    // DEC-30 makes delivery_unknown terminal, because the relay reads only
    // pending rows. So a stuck record is settled, never still to land. Without
    // this the CTE could admit it and the artifact would say a permanently
    // stuck day may still move.
    expect(sample.pending).toBe(0);
  });

  // The read-only guarantee, exercised rather than grepped.
  //
  // A first version asserted the string `default_transaction_read_only`
  // appeared in the CLI's source. Moving the flag from the pool's `options`
  // to its `application_name` kept that literal and left the connection
  // writable, and every case stayed green. These open a pool both ways and
  // check what the job does, which is the only thing that protects a ledger.
  it('refuses to read through a connection that is not read-only', async () => {
    const writable = new Pool({ connectionString: dbUrl(), max: 1 });
    try {
      await expect(runBandsJob({ pool: writable, day: '2026-02-01' })).rejects.toThrow(
        /the connection is not read-only/,
      );
    } finally {
      await writable.end();
    }
  });

  it('reads through a connection that is read-only and bounded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bands-ro-'));
    try {
      const { artifact } = await runBandsJob({
        pool: readOnlyPool, day: '2026-02-01', artifactDir: pathToFileURL(dir + '/'),
      });
      expect(artifact.day).toBe('2026-02-01');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a metric that measured nothing as null, never as zero', async () => {
    // A run that reached no step at all, and was never approved.
    await seedRun({ day: '2026-02-01' });

    const [day] = await readDays(pool, FROM, TO);
    expect(day!.samples.abstain_rate.value).toBeNull();
    expect(day!.samples.gate_pass_rate.value).toBeNull();
    expect(day!.samples.approval_edit_distance.value).toBeNull();
    // Zero stuck deliveries over one run is a real answer, and the good one.
    expect(day!.samples.relay_delivery_unknown_count.value).toBe(0);
  });

  // The session timezone is moved for this case, because without that the
  // cast to UTC is a no-op and dropping it changed no result. Kiritimati is
  // UTC+14, so 23:30 UTC on the 1st is 13:30 on the 2nd there: a bucket that
  // used the session zone would file this run on the wrong day.
  it('keeps a run in the UTC day of its pickup, whatever the session zone', async () => {
    const runId = await seedRun({ day: '2026-02-01' });
    await pool.query('UPDATE run SET created_at = $2 WHERE run_id = $1', [
      runId,
      new Date('2026-02-01T23:30:00.000Z'),
    ]);

    const shifted = new Pool({ connectionString: dbUrl(), max: 1 });
    try {
      await shifted.query("SET TIME ZONE 'Pacific/Kiritimati'");
      const days = await readDays(shifted, FROM, TO);
      expect(days.map((d) => d.day)).toEqual(['2026-02-01']);
    } finally {
      await shifted.end();
    }
  });

  it('reads a window longer than the baseline, one row per day', async () => {
    // Thirty-one days: a full baseline window plus the day under test. This
    // is the population the band evaluation needs, and asserting it here
    // proves the reader can supply it.
    for (let i = 0; i < WINDOW_DAYS + 1; i += 1) {
      const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      await seedRun({ day, abstained: i % 2 === 0 });
    }

    const days = await readDays(pool, FROM, TO);
    expect(days).toHaveLength(WINDOW_DAYS + 1);
    expect(days[0]!.day).toBe('2026-01-01');
    expect(days.at(-1)!.day).toBe('2026-01-31');
    // Sixteen of the thirty-one abstained: days 0, 2, ... 30.
    expect(days.filter((d) => d.samples.abstain_rate.value === 1)).toHaveLength(16);
  });

  // The job layer end to end: the numbers this suite seeded reach a file on
  // disk, come back through the shared versioned scan, and carry a band the
  // suite can compute by hand.
  it('writes an artifact whose band matches the days it was seeded from', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bands-artifact-'));
    try {
      // Thirty prior days alternating 0 and 1 abstains out of one run: mean
      // 0.5, population sigma 0.5. Then a day at 1.0, which is one sigma out.
      for (let i = 0; i < WINDOW_DAYS; i += 1) {
        const day = new Date(Date.UTC(2026, 1, 1 + i)).toISOString().slice(0, 10);
        await seedRun({ day, abstained: i % 2 === 0 });
      }
      const target = new Date(Date.UTC(2026, 1, 1 + WINDOW_DAYS)).toISOString().slice(0, 10);
      await seedRun({ day: target, abstained: true });

      const { artifact } = await runBandsJob({
        pool: readOnlyPool,
        day: target,
        artifactDir: pathToFileURL(dir + '/'),
      });

      expect(artifact.day).toBe(target);
      expect(artifact.runs).toBe(1);
      expect(artifact.window_days).toBe(WINDOW_DAYS);

      const abstain = artifact.metrics.find((m) => m.metric === 'abstain_rate')!;
      expect(abstain.value).toBe(1);
      expect(abstain.baseline?.mean).toBeCloseTo(0.5, 12);
      expect(abstain.baseline?.sigma).toBeCloseTo(0.5, 12);
      expect(abstain.baseline?.days).toBe(WINDOW_DAYS);
      // (1 - 0.5) / 0.5 = 1 sigma: the first line bands.yaml names.
      expect(abstain.band?.sigma_distance).toBeCloseTo(1, 12);
      expect(abstain.band?.action).toBe('log');
      expect(abstain.band?.toward_bad).toBe(true);
      expect(abstain.shortfall).toBeNull();

      // A metric nobody exercised reports its shortfall rather than a band,
      // on the same day and in the same file. Its reason is that the day
      // measured nothing, which is more specific than the missing baseline
      // behind it: no approval happened, so there is no point to place.
      const edit = artifact.metrics.find((m) => m.metric === 'approval_edit_distance')!;
      expect(edit.band).toBeNull();
      expect(edit.value).toBeNull();
      expect(edit.count).toBe(0);
      expect(edit.shortfall).toBe('the day measured nothing');

      // The delivery count is a count, so zero is a real answer and the good
      // one. It still has no band, because one run is not a window.
      const stuck = artifact.metrics.find((m) => m.metric === 'relay_delivery_unknown_count')!;
      expect(stuck.value).toBe(0);
      expect(stuck.shortfall).toBe(`steady at 0 over ${WINDOW_DAYS} days`);

      // What reached disk is what was computed, read back through the same
      // scan every other offline job uses.
      const reloaded = await loadBandsArtifact(undefined, pathToFileURL(dir + '/'));
      expect(reloaded).toEqual(artifact);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The job's own day filter, which was pinned by nothing.
  //
  // A first version seeded an alternating window and four abstaining runs on
  // the target. Admitting the target into its own baseline moved a 1 in and a
  // 1 out, so the mean stayed 0.5 and relaxing the filter changed no result.
  // The target day here is far from every prior day, so the only way the mean
  // stays put is if the filter excludes it.
  it('builds the baseline from days before the target, never including it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bands-window-'));
    try {
      // The OLDEST day must differ from the target's own value. Admitting the
      // target pushes the window forward by one: the oldest day falls out and
      // the target comes in. A first version had both at a rate of 1.0, so
      // the substitution cancelled and the mean did not move — the mutation
      // survived. Here the oldest day abstains on no run and the target
      // abstains on every one, so the swap moves the mean to 16/30.
      for (let i = 0; i < WINDOW_DAYS; i += 1) {
        const day = new Date(Date.UTC(2026, 1, 1 + i)).toISOString().slice(0, 10);
        await seedRun({ day, abstained: i % 2 === 1 });
      }
      const target = new Date(Date.UTC(2026, 1, 1 + WINDOW_DAYS)).toISOString().slice(0, 10);
      // Twenty runs on the target day, every one abstaining, so the target's
      // own rate is 1.0 against a window whose mean is 0.5.
      for (let i = 0; i < 20; i += 1) await seedRun({ day: target, abstained: true });

      const { artifact } = await runBandsJob({
        pool: readOnlyPool, day: target, artifactDir: pathToFileURL(dir + '/'),
      });
      const abstain = artifact.metrics.find((m) => m.metric === 'abstain_rate')!;
      expect(abstain.count).toBe(20);
      expect(abstain.value).toBe(1);
      expect(abstain.baseline?.mean).toBeCloseTo(0.5, 12);
      expect(abstain.baseline?.days).toBe(WINDOW_DAYS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
