// The offline control-band job (bands.yaml, sections 4.10 and 5).
//
// `bands.yaml` defines four metrics, a 30-day window and a daily sample, and
// nothing computed one. It holds no baseline, and it never could: a baseline
// is an adopter's production number and the file is tracked (DEC-18). The
// runbook told an operator in Phase 2 to watch four bands and named no tool
// that produced one. This job is that tool, and it computes each baseline
// from the ledger.
//
// Offline and on demand, like the latency report. It observes and never
// corrects: bands.yaml's three-sigma action is a pull request, and this job
// says one is warranted rather than opening it.
//
// Read-only. Every statement the query module issues is a SELECT, so this is
// safe against a live database, and the connection opens read-only. The
// artifact stays with the adopter: it describes their own traffic, so nothing
// real enters the repository (DEC-18).

import { Pool } from 'pg';

import { closeLedger, requireDbUrl } from '../db/config.js';
import { loadDotEnv } from '../config/env.js';
import { startedAsCommand } from '../corpus/output-path.js';
import {
  assertBandsDirUsable,
  defaultBandsDir,
  nextVersion,
  validateBandsArtifact,
  writeBandsArtifact,
} from './artifact.js';
import type { BandsArtifact } from './artifact.js';
import { evaluateMetric } from './evaluate.js';
import type { DailySample } from './evaluate.js';
import { LOOKBACK_DAYS, METRICS, WINDOW_DAYS } from './metrics.js';
import { readDays } from './query.js';
import { runEntry } from '../cli/entry.js';
import { terminalText } from '../cli/terminal-text.js';
import { humanValue } from './format.js';
import { lastCompleteDay } from '../time/day.js';

export interface BandsJobOptions {
  pool: Pool;
  /** The UTC day to report. Defaults to the most recent complete one. */
  day?: string;
  /** Artifact directory override (tests). */
  artifactDir?: URL;
}

export interface BandsJobResult {
  artifact: BandsArtifact;
}

/** Parse a day argument, or throw with what an operator should type. */
export function parseDay(value: string, now: Date = new Date()): string {
  const day = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(day.getTime())
    || day.toISOString().slice(0, 10) !== value) {
    throw new Error(`--day needs a UTC calendar day, got '${value}'. For example 2026-09-01`);
  }
  // Bounded, not merely well formed. A day that has not finished compares a
  // part of it against whole days, which is the reason the default exists —
  // and a far future day produced a versioned artifact of nulls that reads in
  // the record exactly like a real quiet day. The year bound keeps the
  // lookback inside four digits, past which an ISO string takes the expanded
  // form and Postgres refuses it with a parse error nobody can act on.
  const last = lastCompleteDay(now);
  if (value > last) {
    throw new Error(`--day ${value} has not finished. The last complete UTC day is ${last}`);
  }
  if (value < '0100-01-01') {
    throw new Error(`--day ${value} is before the ledger could hold a run`);
  }
  return value;
}

/** Midnight UTC on the day `offset` days from `day`. */
function midnight(day: string, offset: number): Date {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * 24 * 60 * 60 * 1000);
}

/**
 * Prove the connection is read-only and bounded, rather than assuming it.
 *
 * Setting `options` on the pool is not enough. `pg` merges a parsed
 * connection string over the explicit config, so a DATABASE_URL carrying its
 * own `options` — a search_path, say — replaces the whole string and takes
 * both guarantees with it, silently. Measured: an explicit read-only setting
 * plus a URL with `?options=-c search_path=public` resolves to the search
 * path alone. A pooler that does not forward startup options loses them the
 * same way.
 *
 * So the job asks the server what is actually in force, and refuses to read a
 * live ledger it cannot promise to leave alone.
 *
 * Checked here rather than in `main`, because this function is exported and
 * takes the caller's pool: a check on the command path would leave every
 * other caller unprotected.
 */
async function assertReadOnly(pool: Pool): Promise<void> {
  const { rows } = await pool.query(
    `SELECT current_setting('default_transaction_read_only') AS read_only,
            current_setting('statement_timeout')             AS timeout`,
  );
  const row = rows[0] as { read_only?: string; timeout?: string } | undefined;
  if (row?.read_only !== 'on') {
    throw new Error(
      'bands refuses to read: the connection is not read-only. A DATABASE_URL '
        + 'carrying its own options replaces the ones this job sets. Remove the '
        + 'options parameter from the URL, or set default_transaction_read_only '
        + 'on the role.',
    );
  }
  if (row.timeout === undefined || row.timeout === '0') {
    throw new Error(
      'bands refuses to read: the connection has no statement timeout, so a '
        + 'report could hold a connection open on a live ledger indefinitely.',
    );
  }
}

/** Read the ledger, evaluate the bands, write the artifact. Never writes to the ledger. */
export async function runBandsJob(options: BandsJobOptions): Promise<BandsJobResult> {
  const dir = options.artifactDir ?? defaultBandsDir();
  // Fault on an unusable directory before the query runs, like every other
  // job here: a report an operator cannot keep is a report they will re-run.
  await assertBandsDirUsable(dir);

  // Validated here, not only on the command path. This function is exported
  // and takes a caller-supplied day; an unvalidated one reached `midnight`,
  // produced an invalid Date, and surfaced as a bare RangeError from inside
  // the query that named neither the argument nor the value.
  await assertReadOnly(options.pool);

  const day = options.day === undefined ? lastCompleteDay() : parseDay(options.day);
  // The lookback plus the day itself, read in one pass so a run written
  // between two reads cannot land in one and not the other. The lookback is
  // wider than the window: a quiet day yields no sample, and the baseline
  // needs a window of samples rather than a window of calendar days.
  const rows = await readDays(options.pool, midnight(day, -LOOKBACK_DAYS), midnight(day, 1));

  const today = rows.find((row) => row.day === day);
  // Every day read, including the target. `evaluateMetric` owns the rule that
  // a baseline excludes the day it judges, and a copy of that rule here was
  // redundant: mutating it changed no result, because the evaluator filtered
  // the day out again. One implementation, pinned by one case.
  const prior = rows;
  const runs = today?.runs ?? 0;

  // Annotated, because `validateBandsArtifact` takes `unknown` and would
  // accept a misspelled or missing field here without a word. The compiler
  // checks the names; the validator checks the arithmetic between them.
  const draft: BandsArtifact = {
    artifact: 'control-bands',
    version: await nextVersion(dir),
    generated_at: new Date().toISOString(),
    role: 'observation',
    day,
    window_days: WINDOW_DAYS,
    runs,
    // The day's own provider, from the row the query answered with. Absent
    // when the day held no runs, which records honestly that nothing composed.
    provider: today?.provider ?? null,
    // DEC-49: the day's own count, from the same row. A day with no runs
    // steered none.
    assisted: today?.assisted ?? 0,
    metrics: METRICS.map((definition) => {
      // A day with no row records no provider, which is honest: nothing
      // composed, so nothing answered. It never reaches the provider check,
      // because a null value is the more basic shortfall.
      const empty: DailySample = {
        day, value: null, count: 0, notReached: runs, unrecorded: 0, pending: 0, provider: null,
      };
      const sample = today?.samples[definition.name] ?? empty;
      const evaluated = evaluateMetric(
        definition,
        sample,
        prior.map((row) => row.samples[definition.name]),
      );
      return {
        metric: evaluated.metric,
        direction: evaluated.direction,
        value: evaluated.value,
        count: evaluated.count,
        not_reached: evaluated.notReached,
        unrecorded: evaluated.unrecorded,
        pending: evaluated.pending,
        baseline: evaluated.baseline,
        band:
          evaluated.band === null
            ? null
            : {
              sigma_distance: evaluated.band.sigmaDistance,
              action: evaluated.band.action,
              toward_bad: evaluated.band.towardBad,
            },
        shortfall: evaluated.shortfall,
        shortfall_code: evaluated.shortfallCode,
      };
    }),
  };
  const artifact = validateBandsArtifact(draft);

  await writeBandsArtifact(artifact, dir);
  return { artifact };
}

/**
 * The line an operator acts on.
 *
 * The action, and which side of the mean it sits on. A distance with no side
 * is half an answer: bands.yaml names a bad direction for every metric, and
 * an excursion the other way is still worth a look — AGENTS.md records why,
 * because a gate pass rate of 1.0 is the signature of a classifier
 * temperature of zero rather than of a healthy system.
 */
export function bandLine(
  action: string,
  sigmaDistance: number,
  towardBad: boolean,
): string {
  const side = sigmaDistance >= 0 ? 'above' : 'below';
  const sense = towardBad ? 'the bad direction' : 'the good direction';
  return `${action}, ${Math.abs(sigmaDistance).toFixed(1)} sigma ${side} the mean (${sense})`;
}

// CLI entry: `pnpm run bands` executes dist/bands/run.js.
async function main(): Promise<void> {
  loadDotEnv();
  const args = process.argv.slice(2);
  const dayArg = args.indexOf('--day');
  let day: string | undefined;
  if (dayArg !== -1) {
    const value = args[dayArg + 1];
    if (value === undefined) {
      console.error('--day needs a UTC calendar day. For example --day 2026-09-01');
      process.exitCode = 1;
      return;
    }
    day = parseDay(value);
  }

  // `requireDbUrl`, never `dbUrl`. The compose fallback would let an operator
  // who lost DATABASE_URL read a versioned, plausible report about a
  // throwaway container and take it for production.
  // Read-only at the server, not merely by convention. The scan in
  // `bands.test.ts` reads source text, so it can only refuse the writes it
  // knows to look for; this makes the database refuse every one, including a
  // write issued from inside a SELECT. `statement_timeout` bounds the other
  // half of "safe against a live database": a report has no business holding
  // a connection open indefinitely on a ledger serving live traffic.
  const pool = new Pool({
    connectionString: requireDbUrl('the control-band report'),
    max: 1,
    options: '-c default_transaction_read_only=on -c statement_timeout=60000',
  });
  // An idle client that fails reaches the pool as an 'error' event, and with
  // no listener Node rethrows it outside this function's promise chain.
  pool.on('error', (error: Error & { code?: string }) => {
    console.error(`bands: database connection lost: ${terminalText(error.message)}`
      + `${error.code === undefined ? '' : ` (${error.code})`}`);
    process.exitCode = 1;
  });
  try {
    const { artifact } = await runBandsJob(day === undefined ? { pool } : { pool, day });
    console.log(`bands v${artifact.version} for ${artifact.day} over ${artifact.runs} runs:`);
    for (const metric of artifact.metrics) {
      const counts = [
        metric.not_reached > 0 ? `${metric.not_reached} not reached` : '',
        metric.unrecorded > 0 ? `${metric.unrecorded} unrecorded` : '',
        // Printed last and named plainly, because it says the value may still
        // move rather than that something was excluded from it.
        metric.pending > 0 ? `${metric.pending} still to land` : '',
      ].filter((part) => part !== '');
      console.log(
        `  ${metric.metric.padEnd(28)} ${humanValue(metric.value).padStart(8)}`
          + ` over ${metric.count} runs`
          + `${counts.length === 0 ? '' : ` (${counts.join(', ')})`}`,
      );
      console.log(
        `  ${' '.repeat(28)} ${
          metric.band === null
            ? metric.shortfall
            : bandLine(metric.band.action, metric.band.sigma_distance, metric.band.toward_bad)
        }`,
      );
    }
  } finally {
    await closeLedger(pool, 'bands');
  }
}

// The shared helper, not a copy of its comparison.
if (startedAsCommand(import.meta.url, process.argv[1])) {
  void runEntry(main);
}
