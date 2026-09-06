// The console entry point (issue #27). Run with `pnpm --filter @auracle/console start`.
//
// This is where the surfaces meet the ledger, and it is the only file that
// holds a pool. Every read goes through a query module the jobs already use —
// `listRuns` and `listEscalations` from the escalations module, `readDays`
// from bands, `readLatency` from latency — so a metric has one definition and
// the console displays what those jobs publish rather than a second opinion.
//
// The one write is `approveFromConsole`, which hands off to `approveRun`.
//
// Configuration:
// - DATABASE_URL      the ledger (required; the console refuses to guess)
// - CONSOLE_PORT      the port to listen on (default: 8787)
// - CONSOLE_HOST      the interface to bind (default: 127.0.0.1)
//
// The default bind is loopback on purpose. This console approves customer
// replies, and DEC-11's boundary is about what an adopter installs, not about
// who can reach it; an operator who wants it on a network puts it behind
// something that authenticates.
import { Pool } from 'pg';

import { approveRun } from 'auracle/dist/approval/approve.js';
import { readDays } from 'auracle/dist/bands/query.js';
import { evaluateMetric } from 'auracle/dist/bands/evaluate.js';
import { lastCompleteDay } from 'auracle/dist/bands/run.js';
import { LOOKBACK_DAYS, METRICS } from 'auracle/dist/bands/metrics.js';
import { humanValue } from 'auracle/dist/bands/run.js';
import { probeLedger, requireDbUrl } from 'auracle/dist/db/config.js';
import { LEDGER_STATES, listEscalations, listRuns, readRun } from 'auracle/dist/escalations/query.js';
import { readLatency } from 'auracle/dist/latency/query.js';
import { humanMs } from 'auracle/dist/latency/run.js';

import { approveFromConsole } from './approve.js';
import { CONSOLE_CSS } from './css.js';
import { createConsole } from './server.js';
import type { BandRow, LatencyRow, RunDetail, RunRow } from './surfaces.js';

/** Every ledger state, so the runs surface shows the whole ledger. */
/**
 * Runs the list surface shows. Named, because the page says so: a list
 * silently truncated reads as the whole ledger.
 */
const RUNS_PAGE = 200;

function toRow(item: {
  runId: string; ticketId: string; state: string; promptVer: string;
  reason: string | null; costMicros: number; stepsUsed: number;
}): RunRow {
  return {
    runId: item.runId,
    ticketId: item.ticketId,
    state: item.state,
    promptVer: item.promptVer,
    reason: item.reason,
    stepsUsed: item.stepsUsed,
  };
}

/**
 * A run's two gate values.
 *
 * Not read here. The escalation module reports what a person needs to work
 * the queue, and it does not carry the gate numbers; showing them would need
 * a journal read this console has no module for, so they render as "not
 * reached" rather than as an invented zero. That is the same rule the bands
 * surface follows, and it is why `renderGates` takes nulls.
 */
const GATES_NOT_READ = { agreement: null, coverage: null } as const;

function toDetail(item: Parameters<typeof toRow>[0] & { draftExternalId: string | null }): RunDetail {
  return { ...toRow(item), ...GATES_NOT_READ, draftExternalId: item.draftExternalId };
}

/**
 * The port, validated rather than coerced.
 *
 * `Number('abc')` is NaN, and `listen(NaN)` binds an ephemeral port. The
 * console then started, logged a null port and refused every request, because
 * the allowlist it derived held `127.0.0.1:NaN`. It looked healthy throughout.
 * `parseDay` in the bands job is the precedent: name the variable and the
 * value that was wrong.
 */
function requirePort(raw: string | undefined): number {
  if (raw === undefined) return 8787;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CONSOLE_PORT must be a port from 1 to 65535, got '${raw}'`);
  }
  return port;
}

/**
 * The `Host` values this console answers to.
 *
 * Derived from the bind, plus whatever `CONSOLE_ALLOWED_HOSTS` names. The
 * derivation alone is not enough, and each gap refused every request while
 * the console looked healthy:
 *
 *   - a reverse proxy forwards its own name, and the runbook recommends one;
 *   - an IPv6 bind produced `:::8787` where a browser sends `[::1]:8787`;
 *   - `0.0.0.0` is a bind address and never a `Host`;
 *   - on port 80 or 443 the browser omits the port entirely.
 */
export function allowedHosts(host: string, port: number): string[] {
  const names = new Set<string>();
  const add = (name: string): void => {
    names.add(`${name}:${port}`);
    // The browser omits the default port for the scheme.
    if (port === 80 || port === 443) names.add(name);
  };
  for (const name of ['127.0.0.1', 'localhost', '[::1]']) add(name);
  // A wildcard bind is not a name anyone sends.
  if (host !== '0.0.0.0' && host !== '::') {
    add(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);
  }
  for (const extra of (process.env['CONSOLE_ALLOWED_HOSTS'] ?? '').split(',')) {
    const name = extra.trim();
    if (name === '') continue;
    // A `Host` header is a name and a port, never a URL. An entry carrying a
    // scheme or a path matches nothing, so every request is refused while the
    // console reports itself healthy — the same silent failure the derived
    // names above are commented for twice. Refuse it by name instead.
    if (/[\/\s]/.test(name)) {
      throw new Error(
        `CONSOLE_ALLOWED_HOSTS takes a host and a port, not a URL; got '${name}'`,
      );
    }
    names.add(name.toLowerCase());
  }
  return [...names];
}

async function main(): Promise<void> {
  // Every configuration value is read and refused before a socket is opened.
  //
  // The order is the point, not the tidiness. `allowedHosts` throws on a
  // `CONSOLE_ALLOWED_HOSTS` entry that can never match a `Host`, and it used
  // to run after the probe. The probe leaves an idle client in the pool, and
  // an idle pg client keeps the event loop alive, so the refusal printed and
  // the process then ran forever: a supervisor saw a live console serving
  // nothing. That is the failure class this file exists to close, introduced
  // by the code closing it.
  const port = requirePort(process.env['CONSOLE_PORT']);
  const host = process.env['CONSOLE_HOST'] ?? '127.0.0.1';
  const hosts = allowedHosts(host, port);
  const connectionString = requireDbUrl('the operator console');

  const pool = new Pool({ connectionString, max: 4 });

  // `pool.end()` rejects when it is called twice, and two paths call it: the
  // bind-failure handler and the signal shutdown. A bind failure followed by
  // a SIGTERM reached both, and the second rejection is unhandled — fatal in
  // Node, and it replaces the exit path it was meant to take.
  let ended = false;
  const endPool = async (): Promise<void> => {
    if (ended) return;
    ended = true;
    try {
      await pool.end();
    } catch (error) {
      console.error(JSON.stringify({
        event: 'console_pool_end_failed',
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  // An idle client that fails reaches the pool as an 'error' event, and with
  // no listener Node rethrows it outside every promise chain. The route's
  // catch-all cannot see it, because it is emitted rather than thrown. The
  // offline jobs guard the same edge, and they run for seconds; this console
  // runs for as long as an operator keeps it open, so the exposure is its
  // whole uptime.
  pool.on('error', (error: Error & { code?: string }) => {
    console.error(JSON.stringify({
      event: 'console_pool_error',
      error: error.message,
      code: error.code ?? null,
    }));
  });

  // The pool connects lazily, so a wrong `DATABASE_URL` starts cleanly and
  // fails one request at a time as a 500 page. The operator reads "console
  // listening" and believes it. One probe turns that into a refusal at
  // startup, which is where a configuration fault belongs.
  //
  // Through the core helper, because the console names no SQL. A `SELECT 1`
  // written here would be the package's first statement, and the structural
  // guard refuses it — which is how this line came to be written twice.
  // From here to `listen`, any throw must close the pool, or it hangs the
  // same way. One `catch` over the whole span rather than one per statement.
  try {
    await probeLedger(pool, 'the operator console');
  } catch (error) {
    await endPool();
    throw error;
  }

  const server = createConsole({
    listRuns: async (): Promise<RunRow[]> =>
      (await listRuns(pool, LEDGER_STATES, RUNS_PAGE)).map(toRow),

    readRun: async (runId): Promise<RunDetail | null> => {
      const found = await readRun(pool, runId, LEDGER_STATES);
      return found === null ? null : toDetail(found);
    },

    // Unbounded on purpose, and it is the one surface that should be.
    //
    // The runs list is a browsing surface, so `RUNS_PAGE` caps it. This is a
    // work queue: every row is a customer reply waiting for a person
    // (DEC-12). Capping it would drop the oldest waiting replies off the end
    // and show an operator a queue they had finished, which is a worse fault
    // than a slow page. The read is therefore not bounded either — it runs
    // the same two statements `pnpm run escalations` runs.
    listApprovals: async (): Promise<RunDetail[]> =>
      (await listEscalations(pool, { state: 'awaiting_approval' })).map(toDetail),

    readBands: async (): Promise<BandRow[]> => {
      // The job's own judgement, on the job's own day, over the job's own
      // window. Three things differ if any of them is improvised, and a first
      // version improvised all three.
      //
      // `readDays` emits no row for a day that held no runs, so the newest row
      // is the newest day with traffic and not the last complete day. After a
      // quiet weekend that renders Friday's verdict while `pnpm run bands`
      // reports `day_unmeasured` for Sunday. The day is chosen, then found.
      //
      // The lookback is wider than the window on purpose: a quiet day yields
      // no sample, and the baseline needs a window of samples rather than of
      // calendar days. 31 days gave at most 30 rows, so one quiet day inside
      // it reported `thin_window` where the job produced a verdict.
      //
      // And the prior set is every row read, the target included.
      // `evaluateMetric` owns the rule that a baseline excludes the day it
      // judges; slicing it off here would apply that rule twice.
      const day = lastCompleteDay();
      const at = (offset: number): Date =>
        new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * 86_400_000);
      const rows = await readDays(pool, at(-LOOKBACK_DAYS), at(1));
      const today = rows.find((row) => row.day === day);
      const runs = today?.runs ?? 0;

      return METRICS.map((definition) => {
        // A day with no row is not an absent day: it is a measured absence,
        // and the job builds exactly this sample for it.
        const empty = {
          day, value: null, count: 0, notReached: runs, unrecorded: 0,
          pending: 0, provider: null,
        };
        const sample = today?.samples[definition.name] ?? empty;
        const evaluation = evaluateMetric(
          definition,
          sample,
          rows.map((row) => row.samples[definition.name]),
        );
        return {
          day,
          metric: definition.name,
          // Through the job's own formatter, so a rate reads 0.667 here and
          // in `pnpm run bands` rather than 0.6666666666666666 in one of
          // them. The latency surface already routes through `humanMs`.
          sample: {
            value: evaluation.value === null ? null : humanValue(evaluation.value),
            shortfall: evaluation.shortfallCode,
          },
          // The action the job would take, with how far out the day sits.
          verdict: evaluation.band === null
            ? null
            : `${evaluation.band.action} at ${evaluation.band.sigmaDistance.toFixed(2)} sigma`
              + `${evaluation.band.towardBad ? ', toward bad' : ''}`,
        };
      });
    },

    readLatency: async (): Promise<LatencyRow[]> => {
      const report = await readLatency(pool);
      return report.partitions.map((p) => ({
        partition: p.partition,
        waitP50: humanMs(p.wait.p50Ms),
        waitP95: humanMs(p.wait.p95Ms),
        serviceP50: humanMs(p.service.p50Ms),
        serviceP95: humanMs(p.service.p95Ms),
        runs: p.wait.count,
      }));
    },

    approve: async (runId): Promise<string> => {
      const outcome = await approveFromConsole({ pool, approveRun }, { runId });
      return outcome.outcome;
    },
  }, CONSOLE_CSS, { allowedHosts: hosts });

  // `listen` reports a bind failure by event, after `main`'s promise has
  // already resolved, so the catch below never sees it. Without this the
  // operator gets a raw stack for a busy port rather than the named-variable
  // message every other fault here produces.
  server.on('error', (error: Error & { code?: string }) => {
    console.error(JSON.stringify({
      event: 'console_listen_failed',
      error: error.message,
      code: error.code ?? null,
      CONSOLE_HOST: host,
      CONSOLE_PORT: port,
    }));
    process.exitCode = 1;
    void endPool();
  });

  server.listen(port, host, () => {
    console.log(JSON.stringify({ event: 'console_listening', host, port }));
  });

  // Stop accepting, let an in-flight approval finish, close the pool. The
  // other four long-running processes each do this, and the approval is the
  // reason it matters here: a POST cut off mid-flight leaves the operator
  // unable to tell whether the reply went, which is the state DEC-30 says a
  // person must resolve.
  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      server.close(() => {
        void endPool().then(() => {
          resolve();
        });
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
