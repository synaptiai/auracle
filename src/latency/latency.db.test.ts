// Integration suite for the latency report (V2 open item 7).
//
// Seeds runs through the real write path and then sets the three timing
// columns to known values, so every assertion below names a duration this
// suite chose. A test that asserted whatever the query returned would prove
// only that the query is deterministic.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { applyLedgerSchema } from '../test-support/schema.js';
import { fencedInsert } from '../ledger/insert.js';
import type { FencedRunInput } from '../ledger/insert.js';
import { readLatency } from './query.js';
import { loadLatencyArtifact } from './artifact.js';
import { runLatencyJob } from './run.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

// The global setup guarantees a reachable database before the workers fork.
// A failure here is a fault, and a suite that skipped itself would report
// success while proving nothing.
await pool.query('SELECT 1');

const MINUTE = 60_000;

/**
 * One run with timings this suite chose.
 *
 * `waitMs` and `serviceMs` are written straight onto the row afterwards,
 * because the write path stamps `now()` and a test that depended on wall
 * clock would assert nothing exact.
 */
async function seedRun(opts: {
  partition: number;
  waitMs: number | null;
  serviceMs: number | null;
  state?: string;
  /** Both pins are 'intake' for a run abandonMessage filed without executing. */
  promptVer?: string;
  modelVer?: string;
}): Promise<string> {
  const run: FencedRunInput = {
    runId: randomUUID(),
    ticketId: 'T-' + randomUUID().slice(0, 8),
    partition: opts.partition,
    epoch: 1n,
    state: opts.state ?? 'resolved',
    promptVer: opts.promptVer ?? 'p1',
    modelVer: opts.modelVer ?? 'm1',
    deadlineAt: new Date(Date.now() + MINUTE),
  };
  expect(await fencedInsert(pool, run, null)).toEqual({ outcome: 'accepted' });

  const createdAt = new Date('2026-09-02T12:00:00.000Z');
  await pool.query(
    `UPDATE run SET created_at = $2,
       enqueued_at = $3,
       finished_at = $4
     WHERE run_id = $1`,
    [
      run.runId,
      createdAt,
      opts.waitMs === null ? null : new Date(createdAt.getTime() - opts.waitMs),
      opts.serviceMs === null ? null : new Date(createdAt.getTime() + opts.serviceMs),
    ],
  );
  return run.runId;
}

describe('the latency report (V2 open item 7)', () => {
  beforeEach(async () => {
    await applyLedgerSchema(pool);
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, intake, conversation, turn');
  });
  // A truncate before each case leaves the last case's rows behind. That is
  // harmless against the throwaway container and not harmless at all against
  // an explicit DATABASE_URL, which AGENTS.md documents as a supported mode:
  // the rows survived the run and the next `pnpm run latency` reported them.
  afterAll(async () => {
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, intake, conversation, turn');
    await pool.end();
  });

  // Every figure is a duration some run actually recorded, so the assertions
  // name seeded values rather than interpolations between them.
  it('reports each percentile as a duration a run actually took', async () => {
    // Ten runs, service times 1..10 minutes, in one partition.
    for (let i = 1; i <= 10; i++) {
      await seedRun({ partition: 3, waitMs: i * MINUTE, serviceMs: i * MINUTE });
    }

    const report = await readLatency(pool);
    expect(report.partitions).toHaveLength(1);
    const p = report.partitions[0]!;
    expect(p.partition).toBe(3);
    expect(p.service.count).toBe(10);
    // percentile_disc over 1..10 minutes: p50 is the 5th value, p95 and p99
    // the 10th. Each is a value in the seeded set.
    expect(p.service.p50Ms).toBe(5 * MINUTE);
    expect(p.service.p95Ms).toBe(10 * MINUTE);
    expect(p.service.p99Ms).toBe(10 * MINUTE);
    expect(p.service.maxMs).toBe(10 * MINUTE);
    expect(p.wait.p50Ms).toBe(5 * MINUTE);
    expect(p.wait.maxMs).toBe(10 * MINUTE);
  });

  // A run with no arrival time has no wait. Counting it as zero would invent
  // the most flattering possible number about the runs least is known about.
  it('counts a run with no arrival time as unmeasured, never as a wait of zero', async () => {
    await seedRun({ partition: 1, waitMs: 4 * MINUTE, serviceMs: MINUTE });
    await seedRun({ partition: 1, waitMs: 6 * MINUTE, serviceMs: MINUTE });
    await seedRun({ partition: 1, waitMs: null, serviceMs: MINUTE });

    const p = (await readLatency(pool)).partitions[0]!;
    expect(p.wait.count).toBe(2);
    expect(p.wait.unmeasured).toBe(1);
    // The median of the two measured waits, not of three with a zero in them.
    expect(p.wait.p50Ms).toBe(4 * MINUTE);
    expect(p.wait.maxMs).toBe(6 * MINUTE);
    // The unmeasured run still has a service time, so it is not lost entirely.
    expect(p.service.count).toBe(3);
  });

  // An unfinished run has no service time. Counted separately, so a reader
  // can tell an idle partition from a stalled one.
  it('excludes an unfinished run from service time and counts it', async () => {
    await seedRun({ partition: 2, waitMs: MINUTE, serviceMs: 2 * MINUTE });
    await seedRun({ partition: 2, waitMs: MINUTE, serviceMs: 8 * MINUTE });
    await seedRun({ partition: 2, waitMs: MINUTE, serviceMs: null, state: 'executing' });

    const p = (await readLatency(pool)).partitions[0]!;
    expect(p.service.count).toBe(2);
    expect(p.service.unfinished).toBe(1);
    expect(p.service.maxMs).toBe(8 * MINUTE);
    // The unfinished run still waited, so its wait is measured.
    expect(p.wait.count).toBe(3);
  });

  // The whole point: one partition falling behind must be visible beside the
  // others rather than averaged into them.
  it('separates a busy partition from a quiet one', async () => {
    for (let i = 0; i < 5; i++) {
      await seedRun({ partition: 0, waitMs: MINUTE, serviceMs: MINUTE });
      await seedRun({ partition: 1, waitMs: 30 * MINUTE, serviceMs: MINUTE });
    }

    const report = await readLatency(pool);
    expect(report.partitions.map((x) => x.partition)).toEqual([0, 1]);
    expect(report.partitions[0]!.wait.maxMs).toBe(MINUTE);
    expect(report.partitions[1]!.wait.maxMs).toBe(30 * MINUTE);
  });

  it('reports no partitions over an empty ledger, rather than failing', async () => {
    const report = await readLatency(pool);
    expect(report.partitions).toEqual([]);
    expect(report.runs).toBe(0);
  });

  // A window, so an operator can ask about the incident rather than all time.
  it('reads only the runs inside a window when one is given', async () => {
    // The whole row moves, not just its pickup. Moving `created_at` alone put
    // the pickup a month before the arrival, which is a negative queue wait
    // and a run that finished 32 days after it started. The window excluded
    // the row, so nothing asserted on it and the incoherence was invisible.
    const old = await seedRun({ partition: 0, waitMs: 20 * MINUTE, serviceMs: MINUTE });
    const pickup = new Date('2026-08-01T00:00:00.000Z');
    await pool.query(
      'UPDATE run SET created_at = $2, enqueued_at = $3, finished_at = $4 WHERE run_id = $1',
      [
        old,
        pickup,
        new Date(pickup.getTime() - 20 * MINUTE),
        new Date(pickup.getTime() + MINUTE),
      ],
    );
    await seedRun({ partition: 0, waitMs: MINUTE, serviceMs: MINUTE });

    const report = await readLatency(pool, { since: new Date('2026-09-01T00:00:00.000Z') });
    expect(report.runs).toBe(1);
    expect(report.partitions[0]!.wait.maxMs).toBe(MINUTE);
  });
  // A reversed pair is not a small wait. Its own count, because the remedy
  // differs from a missing intake row: this one is two hosts disagreeing
  // about the time.
  it('counts a reversed timestamp pair as unordered, and still reports the rest', async () => {
    await seedRun({ partition: 1, waitMs: 2 * MINUTE, serviceMs: MINUTE });
    await seedRun({ partition: 1, waitMs: 4 * MINUTE, serviceMs: MINUTE });
    const reversed = await seedRun({ partition: 1, waitMs: MINUTE, serviceMs: MINUTE });
    // Pickup a minute before arrival: a negative wait.
    await pool.query(
      'UPDATE run SET enqueued_at = created_at + interval \'1 minute\' WHERE run_id = $1',
      [reversed],
    );

    const report = await readLatency(pool);
    const p = report.partitions[0]!;
    expect(p.wait.unordered).toBe(1);
    expect(p.wait.unmeasured).toBe(0);
    // The two good runs still produce a report. One bad row used to abort it
    // for every partition, so an operator investigating a busy queue got
    // nothing at all.
    expect(p.wait.count).toBe(2);
    expect(p.wait.p50Ms).toBe(2 * MINUTE);
    expect(p.wait.maxMs).toBe(4 * MINUTE);
    // Every run is still accounted for, under exactly one heading.
    expect(report.runs).toBe(3);
  });

  // db/005: "Existing rows keep null enqueued_at/finished_at". Those runs are
  // finished. Keying on the timestamp reported them as unfinished forever, so
  // an upgraded ledger showed every partition permanently stalled.
  it('reports a terminal run with no finish time as unstamped, not unfinished', async () => {
    const old = await seedRun({ partition: 2, waitMs: MINUTE, serviceMs: null });
    await pool.query("UPDATE run SET state = 'resolved' WHERE run_id = $1", [old]);
    await seedRun({ partition: 2, waitMs: MINUTE, serviceMs: 3 * MINUTE });

    const p = (await readLatency(pool)).partitions[0]!;
    expect(p.service.unstamped).toBe(1);
    expect(p.service.unfinished).toBe(0);
    expect(p.service.count).toBe(1);
    expect(p.service.p50Ms).toBe(3 * MINUTE);
  });

  // abandonMessage inserts a run already terminal, so its creation and its
  // finish are one transaction timestamp. That path fires when a partition is
  // failing, so counting the zeros would let a broken partition manufacture
  // the figures that make it look fastest.
  it('excludes a run that never entered service, rather than scoring it at zero', async () => {
    // Three real runs, so the median moves when a fourth zero joins them:
    // percentile_disc over 10/20/30 is 20 minutes, and over 0/10/20/30 it is
    // 10. Two runs would put the median at the same value either way and the
    // case would pass with the exclusion deleted.
    for (const minutes of [10, 20, 30]) {
      await seedRun({ partition: 4, waitMs: MINUTE, serviceMs: minutes * MINUTE });
    }
    await seedRun({
      partition: 4,
      waitMs: MINUTE,
      serviceMs: 0,
      state: 'escalated',
      promptVer: 'intake',
      modelVer: 'intake',
    });

    const p = (await readLatency(pool)).partitions[0]!;
    expect(p.service.neverRan).toBe(1);
    expect(p.service.count).toBe(3);
    expect(p.service.p50Ms).toBe(20 * MINUTE);
  });

  // The job layer had no test caller at all: runLatencyJob, the write and the
  // version mint were reached only by the CLI. A wait figure written into the
  // service field leaves both distributions well formed and ordered, so
  // nothing downstream would have noticed.
  it('writes an artifact whose wait and service figures are not crossed', async () => {
    await seedRun({ partition: 7, waitMs: 5 * MINUTE, serviceMs: 30 * MINUTE });
    const dirPath = mkdtempSync(join(tmpdir(), 'latency-job-'));
    const dir = pathToFileURL(`${dirPath}/`);

    const first = await runLatencyJob({ pool, artifactDir: dir });
    expect(first.artifact.version).toBe(1);
    const p = first.artifact.partitions[0]!;
    expect(p.wait.max_ms).toBe(5 * MINUTE);
    expect(p.service.max_ms).toBe(30 * MINUTE);

    // Read back from disk through the shared versioned scan, which nothing
    // exercised before: the file on disk is what an operator keeps.
    const loaded = await loadLatencyArtifact(undefined, dir);
    expect(loaded).toEqual(first.artifact);

    // A second run mints the next version rather than overwriting the first.
    const second = await runLatencyJob({ pool, artifactDir: dir });
    expect(second.artifact.version).toBe(2);
    rmSync(dirPath, { recursive: true, force: true });
  });
  // The marker is both pins, not one. `abandonMessage` writes both, and
  // nothing stops a deployment setting PROMPT_VER. Matching on the prompt pin
  // alone would label every real run of such a deployment as never_ran: the
  // service distribution empties and the count the runbook reads as a failing
  // partition spikes on a healthy one.
  it('does not mistake a deployment that named its prompt pin intake', async () => {
    await seedRun({
      partition: 6,
      waitMs: MINUTE,
      serviceMs: 7 * MINUTE,
      promptVer: 'intake',
      modelVer: 'm1',
    });

    const p = (await readLatency(pool)).partitions[0]!;
    expect(p.service.neverRan).toBe(0);
    expect(p.service.count).toBe(1);
    expect(p.service.p50Ms).toBe(7 * MINUTE);
  });

  // The sixth counter, and the one the first pass left unasserted. A finish
  // before a creation is not a fast run.
  it('counts a service time that runs backwards as unordered', async () => {
    for (const minutes of [10, 20, 30]) {
      await seedRun({ partition: 5, waitMs: MINUTE, serviceMs: minutes * MINUTE });
    }
    await seedRun({ partition: 5, waitMs: MINUTE, serviceMs: -5 * MINUTE });

    const p = (await readLatency(pool)).partitions[0]!;
    expect(p.service.unordered).toBe(1);
    expect(p.service.count).toBe(3);
    expect(p.service.p50Ms).toBe(20 * MINUTE);
    expect(p.service.unfinished).toBe(0);
  });

  // The directory is checked before the query, so a report an operator cannot
  // keep is refused before the ledger is read. Ordering, not merely the fault:
  // moving the check below the query would leave every other case green.
  it('refuses an unusable artifact directory before it reads the ledger', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'latency-not-a-dir-')), 'a-file');
    writeFileSync(file, '');
    const notADir = pathToFileURL(`${file}/`);
    // A pool whose query would fail the case if the job ever reached it.
    const refusing = {
      query: () => {
        throw new Error('the ledger was read before the directory was checked');
      },
    } as unknown as Pool;

    // The directory fault, and specifically not the ledger's. If the check
    // moved below the query this would reject with the pool's message
    // instead, so the assertion names which fault arrived.
    await expect(
      runLatencyJob({ pool: refusing, artifactDir: notADir }),
    ).rejects.not.toThrow(/the ledger was read before the directory was checked/);
    await expect(
      runLatencyJob({ pool: refusing, artifactDir: notADir }),
    ).rejects.toThrow();
    rmSync(dirname(file), { recursive: true, force: true });
  });
});
