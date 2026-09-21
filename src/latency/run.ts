// The offline latency job (docs/v1-architecture.md section 6, V2 open item 7).
//
// Reads the three timing columns db/005_run_timing.sql added and reports queue
// wait and service time per partition. Section 6 concedes that partitions
// trade concurrent runs on one ticket for head-of-line delay, and predicts it
// "will appear as latency on busy partitions". This is what makes that
// prediction checkable.
//
// Offline and on demand, like the gold report. It observes and never corrects:
// choosing a correction needs production data this repository does not have,
// which is what open item 7 has always said.
//
// Read-only. Every statement the query module issues is a SELECT, so this is
// safe against a live database (DEC-17, DEC-19).

import { Pool } from 'pg';

import { closeLedger, requireDbUrl } from '../db/config.js';
import { loadDotEnv } from '../config/env.js';
import { startedAsCommand } from '../corpus/output-path.js';
import {
  assertLatencyDirUsable,
  defaultLatencyDir,
  nextVersion,
  validateLatencyArtifact,
  writeLatencyArtifact,
} from './artifact.js';
import type { LatencyArtifact } from './artifact.js';
import { readLatency } from './query.js';
import type { LatencyWindow } from './query.js';
import { runEntry } from '../cli/entry.js';
import { humanMs } from './format.js';

export interface LatencyJobOptions {
  pool: Pool;
  window?: LatencyWindow;
  /** Artifact directory override (tests). */
  artifactDir?: URL;
}

export interface LatencyJobResult {
  artifact: LatencyArtifact;
}

/** Read the ledger, build the artifact, write it. Never writes to the ledger. */
export async function runLatencyJob(options: LatencyJobOptions): Promise<LatencyJobResult> {
  const dir = options.artifactDir ?? defaultLatencyDir();
  // Fault on an unusable directory before the query runs, like every other
  // job here: a report an operator cannot keep is a report they will re-run.
  await assertLatencyDirUsable(dir);

  const window = options.window ?? {};
  const report = await readLatency(options.pool, window);

  // Annotated, because `validateLatencyArtifact` takes `unknown` and would
  // accept a misspelled or missing field here without a word. The compiler
  // checks the names; the validator checks the arithmetic between them.
  const draft: LatencyArtifact = {
    artifact: 'run-latency',
    version: await nextVersion(dir),
    generated_at: new Date().toISOString(),
    role: 'observation',
    since: window.since?.toISOString() ?? null,
    runs: report.runs,
    partitions: report.partitions.map((p) => ({
      partition: p.partition,
      wait: {
        count: p.wait.count,
        unmeasured: p.wait.unmeasured,
        unordered: p.wait.unordered,
        p50_ms: p.wait.p50Ms,
        p95_ms: p.wait.p95Ms,
        p99_ms: p.wait.p99Ms,
        max_ms: p.wait.maxMs,
      },
      service: {
        count: p.service.count,
        unfinished: p.service.unfinished,
        unstamped: p.service.unstamped,
        unordered: p.service.unordered,
        never_ran: p.service.neverRan,
        snoozed: p.service.snoozed,
        rejected: p.service.rejected,
        p50_ms: p.service.p50Ms,
        p95_ms: p.service.p95Ms,
        p99_ms: p.service.p99Ms,
        max_ms: p.service.maxMs,
      },
    })),
  };
  const artifact = validateLatencyArtifact(draft);

  await writeLatencyArtifact(artifact, dir);
  return { artifact };
}

/**
 * Parse a window argument, or throw with what an operator should type.
 *
 * The same spelling as the escalations CLI's `--since`, and a different
 * meaning: that one filters on arrival and this one filters on pickup
 * (`run.created_at`). So a run picked up before the window and still running
 * is outside it — and that is exactly the run holding up a partition. The
 * runbook says to drop the window when hunting a stalled one.
 */
export function parseSince(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `--since needs an ISO timestamp, got '${value}'. For example 2026-09-01T00:00:00Z`,
    );
  }
  return parsed;
}

/**
 * The exclusions worth naming, as an operator reads them.
 *
 * Every non-zero count, not the first two. The runbook gives one remedy per
 * count and tells an operator to read them, and three of the six reached the
 * artifact file alone — including `never_ran`, which the same runbook says
 * rises when a partition is failing. A diagnostic invisible on the command an
 * operator runs is a diagnostic nobody reads.
 */
export function excluded(counts: readonly (readonly [string, number])[]): string {
  const named = counts.filter(([, n]) => n > 0).map(([name, n]) => `${n} ${name}`);
  return named.length === 0 ? '' : ` (${named.join(', ')})`;
}

// CLI entry: `pnpm run latency` executes dist/latency/run.js.
async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const sinceArg = args.indexOf('--since');
  let window: LatencyWindow = {};
  if (sinceArg !== -1) {
    const value = args[sinceArg + 1];
    if (value === undefined) {
      console.error('--since needs an ISO timestamp. For example --since 2026-09-01T00:00:00Z');
      process.exitCode = 1;
      return;
    }
    window = { since: parseSince(value) };
  }

  // `requireDbUrl`, never `dbUrl`. The compose fallback would let an operator
  // who lost DATABASE_URL read a versioned, plausible report about a
  // throwaway container and take it for production. Every other entry point
  // in this repository refuses to guess, and this one reads a live ledger.
  // One connection, because the job issues one statement.
  const pool = new Pool({ connectionString: requireDbUrl('the latency report'), max: 1 });
  // An idle client that fails reaches the pool as an 'error' event, and with no
  // listener Node rethrows it outside this function's promise chain: the catch
  // below never sees it. The window is the whole artifact write, and it opens
  // exactly when an operator runs this against a ledger being restarted.
  //
  // The message and the code, not the whole error. `pg-pool` attaches the
  // client to this one, and printing it buries the single useful line under
  // fifty lines of connection state.
  pool.on('error', (error: Error & { code?: string }) => {
    console.error(`latency: database connection lost: ${error.message}`
      + `${error.code === undefined ? '' : ` (${error.code})`}`);
    process.exitCode = 1;
  });
  try {
    const { artifact } = await runLatencyJob({ pool, window });
    console.log(
      `latency v${artifact.version} over ${artifact.runs} runs`
        + `${artifact.since === null ? ', whole ledger' : `, since ${artifact.since}`}:`,
    );
    if (artifact.partitions.length === 0) {
      console.log('  no runs in this window');
    }
    for (const p of artifact.partitions) {
      console.log(
        `  partition ${p.partition}: wait p50 ${humanMs(p.wait.p50_ms)} `
          + `p95 ${humanMs(p.wait.p95_ms)} p99 ${humanMs(p.wait.p99_ms)} `
          + `max ${humanMs(p.wait.max_ms)} over ${p.wait.count} runs`
          + excluded([
            ['unmeasured', p.wait.unmeasured],
            ['unordered', p.wait.unordered],
          ]),
      );
      console.log(
        `                 service p50 ${humanMs(p.service.p50_ms)} `
          + `p95 ${humanMs(p.service.p95_ms)} p99 ${humanMs(p.service.p99_ms)} `
          + `max ${humanMs(p.service.max_ms)} over ${p.service.count} runs`
          + excluded([
            ['unfinished', p.service.unfinished],
            ['unstamped', p.service.unstamped],
            ['unordered', p.service.unordered],
            ['never_ran', p.service.never_ran],
            ['snoozed', p.service.snoozed],
            ['rejected', p.service.rejected],
          ]),
      );
    }
  } finally {
    await closeLedger(pool, 'latency');
  }
}

// The shared helper, not a copy of its comparison. `startedAsCommand` was
// extracted so the rule could be tested once; cloning it here put the rule
// back in two places, which is the thing the extraction removed.
if (startedAsCommand(import.meta.url, process.argv[1])) {
  void runEntry(main);
}
