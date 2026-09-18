// The console entry point (issue #27). Run with `pnpm --filter @auracle/console start`.
//
// This is where the surfaces meet the ledger, and it is the only file that
// holds a pool. Every read goes through a query module the jobs already use —
// `listRuns` and `listEscalations` from the escalations module, `readDays`
// from bands, `readLatency` from latency — so a metric has one definition and
// the console displays what those jobs publish rather than a second opinion.
//
// The writes are the approval `approvalFor` builds, which hands off to
// `approveRun`, and the four case-hold calls wired below (DEC-46).
// `select-only.test.ts` names every one of them.
//
// Configuration:
// - DATABASE_URL      the ledger (required; the console refuses to guess)
// - CONSOLE_PORT      the port to listen on (default: 8787)
// - CONSOLE_HOST      the interface to bind (default: 127.0.0.1)
// - APPROVE_ADAPTER   the adapter an approval reads the parked draft back
//                     through: imap-smtp or freescout, with that adapter's
//                     own variables. Unset or helpdesk reads nothing back.
// - CONSOLE_IDENTITY_HEADER  the header a trusted proxy sets to name the
//                     reviewer. Unset means no proxy names anyone.
// - CONSOLE_DEV_REVIEWER     an identity to serve as, run from source on
//                     loopback (see `dev-reviewer.ts`). Never in an image.
//
// The default bind is loopback on purpose. This console approves customer
// replies, and DEC-11's boundary is about what an adopter installs, not about
// who can reach it; an operator who wants it on a network puts it behind
// something that authenticates. DEC-45 makes that something load-bearing:
// every request is refused unless the roster holds the reviewer it resolves.
import { Pool } from 'pg';

import {
  activeReviewer, approveRun, handoverHold, readHold, readHolds, releaseHold,
  reviewerProducts, selectReadBackAdapter, takeHold,
} from 'auracle/ledger-read';
import { productCatalogueFromEnv } from 'auracle/ledger-read';
import { requireHoldLapse } from './hold-lapse.js';
import { reviewerResolver } from './reviewer.js';
import { readDays } from 'auracle/ledger-read';
import { evaluateMetric } from 'auracle/domain';
import { lastCompleteDay } from 'auracle/format';
import { LOOKBACK_DAYS, METRICS } from 'auracle/domain';
import { humanValue } from 'auracle/format';
import { probeLedger, requireDbUrl } from 'auracle/ledger-read';
import { LEDGER_STATES, listEscalations, listRuns, readQueueToday, readRun } from 'auracle/ledger-read';
import { readRunJournal } from 'auracle/ledger-read';
import { conversationOfRun, readConversation, turnAnsweredBy } from 'auracle/ledger-read';
import { readDocument } from 'auracle/ledger-read';
import { readLatency } from 'auracle/ledger-read';
import { humanMs } from 'auracle/format';
// Every log line this process writes, so a value from a request cannot break
// one line into two.
import { logLine } from 'auracle/format';

import { approvalFor } from './approve.js';
import { developmentReviewer } from './dev-reviewer.js';
import { readBackFor } from './read-back.js';
import { SHUTDOWN_GRACE_MS } from './shutdown.js';
import { CONSOLE_CSS } from './css.js';
import { allowedHosts, identityHeader } from './hosts.js';
import { ledgerName } from './ledger-name.js';
import {
  agreementDetail, evidenceOf, latencyCaveats, percentileShare, stepSays, toDetail, toRow,
} from './views.js';
import { cachedDaily } from './daily-cache.js';
import { consolePoolConfig } from './pool.js';
import { createConsole, RUNS_PAGE } from './server.js';
import type {
  BandRow, LatencyRow, Percentile, RequestView, RunDetail, RunRow, RunView,
} from './surfaces.js';
import { runEntry } from 'auracle/cli';
import { errorMessage } from 'auracle/cli';

/**
 * The conversation to link at the foot of a run detail, or null.
 *
 * Null when the request already links it. `turnAnsweredBy` returns the
 * conversation with the turn, so asking again is a second statement for an id
 * this already has — and drawing both puts two links to one thread on one
 * page.
 *
 * A run that answered no turn still belongs to a conversation when it carries
 * one: a run recorded before `db/015` has the id and no turn to join on. That
 * run has no request to carry the link, so it is asked for here.
 */
async function conversationLink(
  pool: Pool,
  runId: string,
  request: RequestView | null,
): Promise<string | null> {
  if (request !== null) return null;
  return conversationOfRun(pool, runId);
}

/**
 * The message one run answered, shaped for a surface.
 *
 * One statement for one run, read by the run detail and the case. The queue
 * reads none: it is uncapped by design, and a turn read per waiting row would
 * be a statement for each row of a list that has been 476 long.
 */
async function requestFor(pool: Pool, runId: string): Promise<RequestView | null> {
  const turn = await turnAnsweredBy(pool, runId);
  return turn === null ? null : {
    conversationId: turn.conversationId,
    turnNumber: turn.turnNumber,
    bodyText: turn.bodyText,
    absence: turn.absence,
  };
}

/** The run detail surface's view of one run, or null when there is no run. */
async function readRunView(pool: Pool, runId: string): Promise<RunView | null> {
  const found = await readRun(pool, runId, LEDGER_STATES);
  if (found === null) return null;
  // Two reads, because they answer different questions and one of them can
  // come back empty: a run that journalled nothing is still a run, and the
  // page says so rather than answering 404.
  const journal = await readRunJournal(pool, runId);
  const requested = await requestFor(pool, runId);
  const base = toDetail(found);
  if (journal === null) {
    return {
      ...base,
      steps: [], agreementThreshold: null, agreementDetail: null,
      coverageBlock: null, coverageReview: null, intentId: null,
      decision: null, policyReason: null,
      evidence: {
        draftBody: null, sentences: null, claims: null,
        documents: null, documentsMalformed: false,
      },
      conversationId: await conversationLink(pool, runId, requested),
      request: requested,
    };
  }
  const agreement = journal.agreement;
  return {
    ...base,
    agreement: agreement?.agreement ?? null,
    coverage: journal.coverage?.groundedness ?? null,
    agreementThreshold: agreement?.threshold ?? null,
    agreementDetail: agreement === null ? null : agreementDetail(agreement.agreement),
    coverageBlock: journal.coverage?.blockThreshold ?? null,
    coverageReview: journal.coverage?.reviewThreshold ?? null,
    intentId: agreement?.intentId ?? null,
    decision: journal.coverage?.decision ?? null,
    policyReason: journal.coverage?.reason ?? null,
    steps: journal.steps.map((step) => ({
      stepId: step.stepId,
      status: step.status,
      says: stepSays(step, journal),
      awaitingOutcome: step.awaitingOutcome,
      malformed: step.resultMalformed,
    })),
    evidence: evidenceOf(journal),
    conversationId: await conversationLink(pool, runId, requested),
    request: requested,
  };
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
/**
 * How long the queue header's counts are held (issue #101). A figure for the
 * day stays true enough for this long, and a reloaded page costs no count.
 */
const QUEUE_TODAY_HOLD_MS = 30_000;

/**
 * The outer limit on the page's wait for one count read. The core bounds each
 * query itself and closes a connection that outlasts that bound, and the pool
 * bounds the wait for one. This limit ends the page's wait on whatever those
 * leave, so no page waits on the count past it. The read itself runs on until
 * its own bounds end it.
 */
const QUEUE_TODAY_GIVE_UP_MS = 6_000;

/**
 * The hold period, in milliseconds (DEC-46).
 *
 * Twenty minutes unless the operator sets another. A value that is not a
 * positive whole number of milliseconds is refused rather than clamped: the
 * period decides when a case stops counting as held, and a console that
 * silently rounded a typo would hold cases for a period nobody chose.
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
 * Closes the pool, once one exists.
 *
 * Module-scoped so the top-level handler can reach it. A pool holding an idle
 * client keeps the event loop alive, so a throw anywhere after the pool is
 * built would otherwise hang the process at exit code 1 rather than ending
 * it — which is the failure the double-end guard below is written for, on a
 * path that could not call it.
 */
let closePool: (() => Promise<void>) | null = null;

/** One log line, written so a value from a request cannot break it in two. */
function log(record: Readonly<Record<string, unknown>>): void {
  console.error(logLine(record));
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
  // The header a trusted proxy sets to name the reviewer (DEC-42). Naming it
  // is the operator stating that a proxy they trust sets it and strips any
  // copy a client sent — `hosts.ts` says why that cannot be inferred.
  const identity = identityHeader();
  // The identity a console run from source on loopback may name instead
  // (DEC-45). Refused before the pool opens, so a console that cannot honour
  // it never serves a request.
  const development = developmentReviewer({
    wanting: process.env['CONSOLE_DEV_REVIEWER'],
    host,
    moduleUrl: import.meta.url,
    // The two describe different topologies, and the module refuses both at
    // once. Passed in rather than read there, so the refusal is testable.
    identityHeader: identity,
  });
  // DEC-45: a console with no identity source at all serves nothing. It
  // starts and refuses every request with that reason, and this line is what
  // says so before the first one arrives: a console that only logged
  // refusals would look like a proxy problem to whoever reads the log.
  if (identity === undefined && development === undefined) {
    log({
      event: 'console_no_identity',
      host,
      port,
      says: 'no identity source: every request is refused until CONSOLE_IDENTITY_HEADER'
        + ' names a proxy header, or CONSOLE_DEV_REVIEWER names one for local use',
    });
  } else if (development !== undefined) {
    // Named at startup, so an incident reader who finds approvals recorded
    // for this identity knows what wrote them: a console on this machine,
    // serving as one reviewer, with no proxy in front of it. Worded as the
    // intent, because the roster read below and the checks after it can
    // still refuse this start, and this line is written before them.
    log({
      event: 'console_dev_reviewer',
      host,
      port,
      reviewer: development,
      says: 'configured to serve every request as this reviewer, from source on loopback',
    });
  }
  // The adapter an approval reads the draft back through (section 4.10).
  // Built here, so a name or a configuration the adapter refuses stops the
  // console before it opens the pool, rather than on the first approval.
  const readBack = readBackFor(process.env, selectReadBackAdapter, log);
  // DEC-46: the period a case counts as held after its last take.
  const lapseMs = requireHoldLapse(process.env['CONSOLE_HOLD_LAPSE_MS']);
  const connectionString = requireDbUrl('the operator console');

  const pool = new Pool(consolePoolConfig(connectionString));

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
      console.error(logLine({
        event: 'console_pool_end_failed',
        error: errorMessage(error),
      }));
    }
  };
  closePool = endPool;

  // An idle client that fails reaches the pool as an 'error' event, and with
  // no listener Node rethrows it outside every promise chain. The route's
  // catch-all cannot see it, because it is emitted rather than thrown. The
  // offline jobs guard the same edge, and they run for seconds; this console
  // runs for as long as an operator keeps it open, so the exposure is its
  // whole uptime.
  pool.on('error', (error: Error & { code?: string }) => {
    console.error(logLine({
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
    // DEC-45: a development reviewer nobody added refuses every request, and
    // a console that listened anyway would look configured and serve nobody.
    // The roster decides, so this is the same question the gate asks, asked
    // once at startup where the operator is present to read the answer.
    if (development !== undefined && !(await activeReviewer(pool, development))) {
      throw new Error(
        `CONSOLE_DEV_REVIEWER names '${development}', which the reviewer roster`
          + ` does not hold; add it with: pnpm run reviewers -- --add ${development}`,
      );
    }
  } catch (error) {
    await endPool();
    throw error;
  }

  const server = createConsole({
    listRuns: async (states): Promise<RunRow[]> =>
      (await listRuns(pool, states, RUNS_PAGE)).map(toRow),

    readRun: async (runId): Promise<RunView | null> => readRunView(pool, runId),

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

    // Two counts for the queue header, for the UTC day the request lands in.
    // Held for a short window, because the landing page asks on every load.
    readQueueToday: cachedDaily(
      async () => readQueueToday(pool),
      QUEUE_TODAY_HOLD_MS,
      Date.now,
      QUEUE_TODAY_GIVE_UP_MS,
    ),

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
      // The window as days, so a day the ledger holds no row for still takes
      // a place on the line.
      const calendarDays: string[] = [];
      for (let offset = -LOOKBACK_DAYS; offset <= 0; offset += 1) {
        calendarDays.push(at(offset).toISOString().slice(0, 10));
      }
      const byDay = new Map(rows.map((row) => [row.day, row]));
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
          // The action alone, so the card can colour by it without parsing
          // the sentence above back apart.
          action: evaluation.band?.action ?? null,
          count: evaluation.count,
          baseline: evaluation.baseline === null ? null : {
            mean: humanValue(evaluation.baseline.mean),
            sigma: humanValue(evaluation.baseline.sigma),
            days: evaluation.baseline.days,
          },
          // One entry per calendar day in the window, not one per row.
          //
          // The samples are the ones the baseline was computed over, drawn
          // from that list rather than from a second read, so the line and
          // the verdict cannot disagree. A day that measured nothing stays
          // null, because the surface breaks the line there rather than
          // dropping it to the floor.
          //
          // `readDays` groups over `run` and emits no row at all for a day
          // that held none, so mapping the rows silently joined a quiet
          // weekend across and compressed the axis. The gap the surface
          // documents only appeared for a day that had runs and no value for
          // this metric. Every absent day is now a null of its own.
          history: calendarDays.map((iso) =>
            byDay.get(iso)?.samples[definition.name]?.value ?? null),
        };
      });
    },

    readLatency: async (): Promise<LatencyRow[]> => {
      const report = await readLatency(pool);
      // The bars compare across partitions, so they share one scale for each
      // column. Scaling each row to its own maximum would draw the slowest
      // partition and the fastest identically, which is the one comparison
      // this surface exists to make.
      const widest = (pick: (p: typeof report.partitions[number]) => (number | null)[]): number =>
        Math.max(0, ...report.partitions.flatMap(pick).filter((v): v is number => v !== null));
      const waitMax = widest((p) => [p.wait.p50Ms, p.wait.p95Ms, p.wait.p99Ms]);
      const serviceMax = widest((p) => [p.service.p50Ms, p.service.p95Ms, p.service.p99Ms]);

      const pct = (label: string, ms: number | null, max: number): Percentile =>
        ({ label, text: humanMs(ms), share: percentileShare(ms, max) });

      return report.partitions.map((p) => ({
        partition: p.partition,
        wait: [
          pct('p50', p.wait.p50Ms, waitMax),
          pct('p95', p.wait.p95Ms, waitMax),
          pct('p99', p.wait.p99Ms, waitMax),
        ],
        service: [
          pct('p50', p.service.p50Ms, serviceMax),
          pct('p95', p.service.p95Ms, serviceMax),
          pct('p99', p.service.p99Ms, serviceMax),
        ],
        // The partition's own run count, not the count of runs one
        // distribution could measure. `wait.count` is `count(wait_ms)`, so a
        // partition whose runs mostly lack an arrival time would report the
        // measured few as everything it ran.
        runs: p.runs,
        caveats: latencyCaveats(p),
      }));
    },

    readConversation: async (conversationId) => {
      const thread = await readConversation(pool, conversationId);
      if (thread === null) return null;
      return {
        conversationId: thread.conversationId,
        primaryTicketId: thread.primaryTicketId,
        state: thread.state,
        openedAt: thread.openedAt,
        participantNamed: thread.participantNamed,
        turns: thread.turns.map((turn) => ({
          turnNumber: turn.turnNumber,
          ticketId: turn.ticketId,
          createdAt: turn.createdAt,
          bodyText: turn.bodyText,
          messageAbsence: turn.messageAbsence,
          replyText: turn.replyText,
          replyAbsence: turn.replyAbsence,
          runId: turn.runId,
          runState: turn.runState,
          runAttempts: turn.runAttempts,
          outboxStatus: turn.outboxStatus,
        })),
      };
    },

    readDocument: async (docId) => readDocument(pool, docId),

    // The page says a read-back failed and nothing was sent. The fault is
    // logged beside the run and the draft it stopped.
    approve: approvalFor({ pool, approveRun, readBack, log }),

    // DEC-45: every request, read or write, is resolved against the roster
    // before any page is built. The header is the one the operator named,
    // and the roster is the ledger's.
    // DEC-47: the products this reviewer covers, for the queue's order. A
    // read of the roster, so the console can order by a preference without
    // ever being able to set one.
    readReviewerProducts: async (reviewer: string) => reviewerProducts(pool, reviewer),
    // DEC-47: what each product is called on the page. Read once, from the
    // file the ingress processes read, so a chip says `Aurora` where the
    // catalogue does.
    productLabels: new Map(
      productCatalogueFromEnv().products.map((product) => [product.id, product.label]),
    ),
    // DEC-46: the case hold. The two reads serve the case bar and the queue;
    // the three writes are the console's own, and `select-only.test.ts` names
    // them.
    readHold: async (runId: string) => readHold(pool, runId),
    readHolds: async (runIds: readonly string[]) => readHolds(pool, runIds),
    takeHold: async (runId: string, reviewer: string, over: boolean) =>
      takeHold(pool, { runId, reviewer, lapseMs, force: over }),
    releaseHold: async (runId: string, reviewer: string) =>
      releaseHold(pool, { runId, reviewer, kind: 'release' }),
    handoverHold: async (runId: string, reviewer: string, to: string) =>
      handoverHold(pool, {
        runId, from: reviewer, to, lapseMs,
        // A case handed to somebody the console would refuse at their next
        // request is a case nobody holds, so the roster decides here too.
        isReviewer: async (identity: string) => activeReviewer(pool, identity),
      }),

    reviewerFor: reviewerResolver({
      ...(identity === undefined ? {} : { identityHeader: identity }),
      ...(development === undefined ? {} : { devReviewer: development }),
      active: async (id) => activeReviewer(pool, id),
    }),
  }, CONSOLE_CSS, {
    allowedHosts: hosts,
    // The whole closed set. The filter offers every state the ledger can
    // hold, so a state with no runs today still has a link that says so —
    // an operator checking for escalations needs the empty answer too.
    states: [...LEDGER_STATES],
    ledger: ledgerName(connectionString),
    readBack: readBack?.name ?? null,
  });

  // `listen` reports a bind failure by event, after `main`'s promise has
  // already resolved, so the catch below never sees it. Without this the
  // operator gets a raw stack for a busy port rather than the named-variable
  // message every other fault here produces.
  server.on('error', (error: Error & { code?: string }) => {
    console.error(logLine({
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
    console.log(logLine({ event: 'console_listening', host, port }));
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
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        void endPool().then(() => {
          resolve();
        });
      };
      server.close(finish);
      // A keep-alive socket sitting idle holds `close` open on its own, and
      // an in-flight request holds it to Node's 300 s request timeout. The
      // supervisor's grace period expires long before that and sends SIGKILL,
      // which is the one signal that can cut an approval mid-flight — the
      // state DEC-30 says a person must resolve. So idle sockets go at once,
      // and a request still running gets a bounded wait rather than an
      // unbounded one.
      server.closeIdleConnections();
      const cutoff = setTimeout(finish, SHUTDOWN_GRACE_MS);
      // The timer must not itself keep the process alive.
      cutoff.unref();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

// The pool goes with the fault. A pool holding an idle client keeps the event
// loop alive, so a throw between the ledger probe and `listen` would hang at
// exit code 1 rather than ending.
void runEntry(main, { onFault: () => closePool?.() });
