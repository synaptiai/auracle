/**
 * A synthetic traffic history, planned before anything is written (issue #23).
 *
 * Pure. It opens no connection, reads no clock and calls no model, so the
 * same seed always yields the same history. That is the whole point: a band
 * built from a history nobody can reproduce is a number nobody can check.
 *
 * ## What this models, and why it is not tuned
 *
 * Issue #25's evidence gate reads `pnpm run latency` against this history and
 * decides which correction head-of-line delay needs. So a history built to
 * make one rule fire would seed the check with the material meant to verify
 * it, and the gate would be reading its own answer back.
 *
 * Every parameter below therefore comes from the system's shape, never from a
 * wanted verdict:
 *
 * - **Service time is heavy-tailed** because a run makes nine classifier
 *   samples at a temperature above zero (section 4.5), an embedding, a
 *   composition and a groundedness check. Model latency is long-tailed, and a
 *   run that makes twelve calls inherits that tail. Drawn log-normal.
 * - **Partition depth is uniform** because `partitionOf` hashes the
 *   conversation id (DEC-36) and a hash spreads evenly. Nothing here skews it.
 * - **Arrivals are bursty**, because support traffic is. Modelled as a Poisson
 *   process, which clusters: a uniform spread never fills a poll batch, and a
 *   full batch is where the delay lives.
 * - **Queue wait is not drawn at all.** It is computed from the consumer's
 *   real loop, and three facts of that loop shape it:
 *     1. Intake signals the consumer inside the enqueue transaction and the
 *        loop wakes on it (issue #25), so a message is visible the instant
 *        it is queued. `CONSUMER_INTERVAL_MS` remains as a ceiling for a
 *        lost signal. Set `wakeOnArrival: false` for the loop before that
 *        change, where a message waited for the next tick at any load.
 *     2. `pollPartition` takes every queued message across the partitions one
 *        consumer owns, and `scanBatchSize` defaults to the whole queue.
 *     3. `processQueuedTickets` awaits each `coordinateTicket` before the
 *        next, so the batch is walked serially.
 *   So a ticket waits for every ticket ahead of it in its consumer's batch —
 *   including tickets on a *different* partition that the same consumer
 *   owns. That cross-partition wait is the head-of-line delay V2 open item 7
 *   names, and modelling one server per partition would have hidden it
 *   entirely.
 *
 * Head-of-line delay is therefore a consequence of those facts, and whatever
 * the report shows about it is a finding rather than a setting.
 *
 * ## What the figures say
 *
 * At this load the system does not queue. Utilisation is 1.37 %, and one run
 * in a hundred waits longer than one poll period. None of the design
 * document's rules R1 to R4 fires.
 *
 * `wakeOnArrival: false` models the loop before the consumer woke on an
 * arrival. There the mean wait is 2.78 s against a poll floor of 2.50 s, so
 * ninety per cent of the wait is the sleep itself. Both regimes stay
 * expressible, because a wait figure that can only be stated one way is not
 * evidence for anything.
 *
 * `src/seed/plan.test.ts` pins every figure the register and the roadmap
 * quote.
 */
import { partitionOf } from '../coordinator/coordinator.js';

/** Deterministic PRNG, the same one `scripts/generate-fixtures.mjs` uses. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A v4-shaped identifier from the PRNG.
 *
 * `randomUUID` would make the history irreproducible, and a run id is a
 * primary key a second run must reproduce exactly for the ledger contents to
 * match. The version and variant nibbles are set so the value is a valid
 * UUID and Postgres accepts it in a `uuid` column.
 */
export function seededUuid(rng: () => number): string {
  const hex: string[] = [];
  for (let i = 0; i < 32; i += 1) hex.push(Math.floor(rng() * 16).toString(16));
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Milliseconds in one day. */
const DAY_MS = 86_400_000;

/**
 * A log-normal draw, by the Box-Muller transform.
 *
 * Log-normal because a duration cannot be negative and a run's total is a
 * product of several call latencies rather than a sum of them. `sigma`
 * controls the tail: at 0.9 roughly one run in a hundred takes five times the
 * median, which is the shape a twelve-call run has.
 */
export function logNormal(rng: () => number, medianMs: number, sigma: number): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.round(medianMs * Math.exp(sigma * z));
}

/** One planned run, with every value the writer needs. */
export interface PlannedRun {
  runId: string;
  ticketId: string;
  conversationId: string;
  partition: number;
  /** When the message arrived. */
  enqueuedAt: Date;
  /** When the consumer picked it up: arrival plus everything ahead of it. */
  createdAt: Date;
  /**
   * The work itself, which is what occupies the consumer.
   *
   * Distinct from `finishedAt - createdAt`. A run parked for approval holds
   * no consumer while it waits, so the serial walk releases the consumer
   * after this and not after the person answers.
   */
  serviceMs: number;
  /**
   * When it reached a terminal state, or null when it has not reached one.
   *
   * Null for `awaiting_approval`: that run is waiting for a person and has
   * not finished, so the ledger stores no finish and the latency reader
   * counts it under `unfinished`. The clock seam refuses a finish for a
   * non-terminal state, which is how this was found.
   */
  finishedAt: Date | null;
  state: string;
  /** The compose step's outcome. */
  abstained: boolean;
  /**
   * The gate step's reason, or null for a run that never gated.
   *
   * Null when the composer abstained: `coordinateTicket` journals the
   * abstain and escalates before the gate step starts, so such a run has no
   * gate row at all. Writing one produced a shape the system cannot make,
   * and it drove the bands report's `gate_never` count to zero on every day
   * where a real ledger with a 17 per cent abstain rate shows at least that.
   */
  reason: string | null;
  /** What answered this run's model calls. */
  provider: string;
  /** Set only when a person approved a draft. */
  editDistance: number | null;
  /** Outbox rows to attach, by status. */
  outbox: readonly string[];
}

export interface PlanOptions {
  seed: number;
  /** UTC calendar days to write, oldest first. */
  days: number;
  /** The last day of the history, `YYYY-MM-DD`. */
  endDay: string;
  /** Consumer partitions, as CONSUMER_PARTITIONS would name them. */
  partitions: number;
  /**
   * Consumer processes. Each owns `partitions / consumers` of them and walks
   * their combined queue in one serial batch, which is what
   * `pollPartition` plus `processQueuedTickets` do.
   */
  consumers?: number;
  /** Mean tickets a day. Poisson, so the realised count varies. */
  arrivalsPerDay?: number;
  /** The consumer's poll period, CONSUMER_INTERVAL_MS. */
  pollIntervalMs?: number;
  /**
   * Whether the consumer wakes on arrival (issue #25). True models the loop
   * that ships: intake signals on enqueue and the consumer scans at once,
   * with the poll period left as a ceiling. False models the loop before it,
   * where a message was invisible until the next tick.
   *
   * Both regimes stay expressible on purpose. The wait figures this planner
   * produces are the evidence for what the poll floor costs, and evidence
   * that can only be stated one way is not evidence.
   */
  wakeOnArrival?: boolean;
  /** What answered the bulk history's model calls. */
  provider: string;
}

/**
 * The reasons a healthy day produces, with the weight each carries.
 *
 * Taken from `PolicyReason`, so `bands` recognises every one of them. A
 * reason it no longer knows lands in `gate_obsolete`, which would report the
 * seeded history as a ledger the reader cannot interpret.
 *
 * `customer_visible` dominates because DEC-12 sends every customer reply to a
 * person, and that is most of this system's traffic.
 */
const HEALTHY_REASONS: readonly (readonly [string, number])[] = [
  ['customer_visible', 0.46],
  ['auto', 0.24],
  ['groundedness_review', 0.10],
  ['agreement', 0.08],
  ['high_risk', 0.06],
  ['groundedness_block', 0.03],
  ['irreversible', 0.02],
  ['no_idempotency', 0.01],
];

/**
 * The degraded day: the classifier disagrees with itself more often.
 *
 * Only `agreement` and `auto` move, and they move against each other, so the
 * day's degradation is one metric falling rather than a reshaped ledger.
 * `gate_pass_rate` is the metric bands.yaml calls low_is_bad, and agreement
 * is the reason that fails it (section 4.5).
 */
const DEGRADED_REASONS: readonly (readonly [string, number])[] = [
  ['customer_visible', 0.46],
  ['auto', 0.04],
  ['groundedness_review', 0.10],
  ['agreement', 0.28],
  ['high_risk', 0.06],
  ['groundedness_block', 0.03],
  ['irreversible', 0.02],
  ['no_idempotency', 0.01],
];

/**
 * The state a run ends in, given the reason its gate produced.
 *
 * Read off `evaluatePolicyDetailed` and the coordinator's own branches, not
 * chosen. `auto` is the only reason that proceeds, and it ends `resolved`.
 * Every `gated` reason parks at `awaiting_approval` — DEC-34 for a write
 * with no draft, DEC-12 for a customer reply — and reaches `resolved` only
 * when a person approves it. `agreement` and `groundedness_block` are
 * `escalate`, which ends `escalated`.
 *
 * The first version marked every run `resolved`, including 1112 customer
 * replies that DEC-12 routes to a person. The bands report's own
 * "still to land" count was then zero on every day of the history.
 */
const ESCALATING_REASONS: ReadonlySet<string> = new Set(['agreement', 'groundedness_block']);

export function stateFor(reason: string, approved: boolean): string {
  if (reason === 'auto') return 'resolved';
  if (ESCALATING_REASONS.has(reason)) return 'escalated';
  return approved ? 'resolved' : 'awaiting_approval';
}

function weighted(rng: () => number, table: readonly (readonly [string, number])[]): string {
  let roll = rng();
  for (const [value, weight] of table) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return table[table.length - 1]![0];
}

/** A UTC day string, `n` days before `endDay`. */
export function dayBefore(endDay: string, n: number): string {
  return new Date(Date.parse(`${endDay}T00:00:00.000Z`) - n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Plans the whole history.
 *
 * The degraded day sits four days before the end, so a reader has a full
 * thirty measured days behind it and several ordinary days after it.
 */
/**
 * A Poisson draw by Knuth's method.
 *
 * Arrivals to a support desk are Poisson, and Poisson clusters: the gap
 * between two arrivals is exponential, so several land close together far
 * more often than a uniform spread allows. A batch fills from a cluster.
 */
export function poisson(rng: () => number, mean: number): number {
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rng();
  } while (p > limit);
  return k - 1;
}

/** An exponential gap, which is what makes the arrival process Poisson. */
function exponentialGap(rng: () => number, meanMs: number): number {
  return -Math.log(Math.max(rng(), Number.EPSILON)) * meanMs;
}

/**
 * A day's own seed, mixed from the run seed and the day string.
 *
 * One stream for the whole history made every window that shared a seed start
 * with the same identifiers, so seeding one extra day after a long history
 * regenerated the first day's run ids and the ledger refused them on the
 * primary key. Per-day seeding keeps both properties that matter: one seed and
 * one day always give the same runs, and two different days never collide.
 */
function seedForDay(seed: number, day: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < day.length; i += 1) {
    hash ^= day.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash ^ seed) >>> 0;
}

export function planHistory(options: PlanOptions): PlannedRun[] {
  const degradedDay = dayBefore(options.endDay, 4);
  const consumers = options.consumers ?? 2;
  const meanArrivals = options.arrivalsPerDay ?? 54;
  const pollMs = options.pollIntervalMs ?? 5_000;
  const wakeOnArrival = options.wakeOnArrival ?? true;
  const planned: PlannedRun[] = [];

  // Which consumer owns which partition. CONSUMER_PARTITIONS names a set per
  // process, and the sets are contiguous in every example the runbook gives.
  const ownerOf = (partition: number): number =>
    Math.floor(partition / Math.ceil(options.partitions / consumers));

  for (let d = options.days - 1; d >= 0; d -= 1) {
    const day = dayBefore(options.endDay, d);
    const rng = mulberry32(seedForDay(options.seed, day));
    const degraded = day === degradedDay;
    const dayStartMs = Date.parse(`${day}T07:00:00.000Z`);
    const windowMs = 11 * 3_600_000;

    // Poisson arrivals: the count varies, and the gaps are exponential, so
    // the day carries clusters rather than an even spread.
    const arrivals = poisson(rng, meanArrivals);
    const gapMs = windowMs / Math.max(arrivals, 1);

    const drawn = [];
    let cursor = dayStartMs;
    for (let i = 0; i < arrivals; i += 1) {
      cursor += exponentialGap(rng, gapMs);
      const conversationId = seededUuid(rng);
      const ticketId = `T-${seededUuid(rng).slice(0, 8)}`;
      drawn.push({
        conversationId,
        ticketId,
        partition: partitionOf(conversationId, options.partitions),
        arrivedMs: Math.round(cursor),
        // Twelve model calls, so the total inherits their tail.
        serviceMs: logNormal(rng, 14_000, 0.9),
        reason: weighted(rng, degraded ? DEGRADED_REASONS : HEALTHY_REASONS),
        abstained: rng() < 0.17,
        approvalRoll: rng(),
        editRaw: logNormal(rng, 24, 1.1),
        unknownRoll: rng(),
        runId: seededUuid(rng),
      });
    }

    // The consumer loop, as consumer-main.ts and processQueuedTickets run it.
    //
    // Each consumer is one server. It wakes on its poll tick, takes every
    // message queued across the partitions it owns, and walks that batch
    // serially. So a ticket waits for the tick, then for everything ahead of
    // it in the batch — including tickets on a different partition the same
    // consumer owns, which is the head-of-line delay item 7 names.
    const freeAt = new Map<number, number>();
    const byConsumer = new Map<number, typeof drawn>();
    for (const a of drawn) {
      const owner = ownerOf(a.partition);
      const list = byConsumer.get(owner) ?? [];
      list.push(a);
      byConsumer.set(owner, list);
    }

    for (const [owner, queue] of byConsumer) {
      // Served in the order the queue filled.
      queue.sort((x, y) => x.arrivedMs - y.arrivedMs);
      for (const a of queue) {
        // When the consumer learns the message exists. With the arrival
        // signal that is the instant it was queued, because intake notifies
        // inside the same transaction. Without it, the next poll tick: a
        // message was invisible until the consumer looked, whatever the load.
        const visibleMs = wakeOnArrival
          ? a.arrivedMs
          : dayStartMs + Math.ceil((a.arrivedMs - dayStartMs) / pollMs) * pollMs;
        const free = freeAt.get(owner) ?? 0;
        const startedMs = Math.max(visibleMs, free);
        freeAt.set(owner, startedMs + a.serviceMs);

        // An abstain escalates before the gate step starts, so such a run
        // carries no gate row and no approval. DEC-07: it is a correct
        // output, not an error, and it keeps its partial work.
        const reason = a.abstained ? null : a.reason;
        // A person approves a parked run (DEC-12 for a customer reply, DEC-34
        // for a write with no draft), and the distance is what they changed.
        // Most drafts survive nearly intact.
        const approved =
          reason !== null
            && !ESCALATING_REASONS.has(reason)
            && reason !== 'auto'
            && a.approvalRoll < 0.62;
        // DEC-30 makes an unknown delivery terminal AND escalating, so a run
        // carrying one cannot also be resolved. Only an automatic write
        // reaches the relay at all.
        const unknownDelivery = reason === 'auto' && a.unknownRoll < 0.02;
        const state = a.abstained
          ? 'escalated'
          : unknownDelivery
            ? 'escalated'
            : stateFor(reason ?? 'auto', approved);

        // db/005 defines service time as finished_at - created_at, so an
        // approved run's service time includes the wait for the person. That
        // is the truth about this system: DEC-12 puts a person on every
        // customer reply, and the ledger measures the run, not the model
        // calls inside it. Drawn log-normal around three quarters of an hour.
        const approvalMs = approved ? logNormal(rng, 2_700_000, 1.0) : 0;
        const finishedAt =
          state === 'awaiting_approval'
            ? null
            : new Date(startedMs + a.serviceMs + approvalMs);
        planned.push({
          runId: a.runId,
          ticketId: a.ticketId,
          conversationId: a.conversationId,
          partition: a.partition,
          enqueuedAt: new Date(a.arrivedMs),
          createdAt: new Date(startedMs),
          serviceMs: a.serviceMs,
          finishedAt,
          state,
          abstained: a.abstained,
          reason,
          provider: options.provider,
          editDistance: approved ? Math.round(a.editRaw) : null,
          outbox: unknownDelivery ? ['delivery_unknown'] : [],
        });
      }
    }
  }
  return planned;
}
