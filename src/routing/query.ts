// What the routing screen shows: what each product may do without a person,
// read from what the running system recorded.
//
// The console holds neither the calibration artifact nor a consumer's action
// profile. Every gate records the threshold in force for its run and the rule
// that decided it (DEC-41, DEC-05), and the gate step keeps the latest of
// those for each product and intent in `gate_latest` (src/routing/latest.ts).
// So the read costs one row for each product and intent, whatever the
// history. An intent no run of the product reached has no row, and the
// screen names that absence rather than a default.
import type { Pool } from 'pg';

import { boundedRead, type BoundedQuery } from '../db/bounded-read.js';
import type { RiskTier } from '../domain/capabilities.js';
import { normalizeIntentId, type PolicyReason } from '../policy/policy.js';

/** How long the screen's read may run. */
export const ROUTING_TIMEOUT_MS = 2_000;

/**
 * The rules that stop an action whatever the gates read (DEC-06, DEC-12,
 * DEC-13, DEC-34). A run decided by one of these could not act on its own.
 */
const STOPS: Readonly<Record<PolicyReason, boolean>> = {
  no_idempotency: true,
  no_read_back: true,
  customer_visible: true,
  irreversible: true,
  high_risk: true,
  agreement: false,
  groundedness_block: false,
  groundedness_review: false,
  auto: false,
};

/** What the latest gate row of one product and intent recorded. */
export interface GateRecord {
  /** When that run started, as an ISO instant. */
  readonly at: string;
  /** The rule that decided that run. */
  readonly reason: PolicyReason;
  /**
   * Whether the product may act on this intent without a person. False when
   * a rule stopped the run before the gates were read; true when the gates
   * decided, since both passing lets it act.
   */
  readonly mayAct: boolean;
  /**
   * The agreement threshold in force for that run. A run a stop decided was
   * never compared against it.
   */
  readonly threshold: number;
  /** Whether that threshold was fitted for this intent (DEC-41). */
  readonly fitted: boolean;
}

export interface RoutingIntent {
  readonly id: string;
  /** The tier a person set in the taxonomy (DEC-13). */
  readonly risk: RiskTier;
  /** The latest gate row, or null when no run of the product reached one. */
  readonly gate: GateRecord | null;
  /**
   * Gate rows of this product and intent whose reason or thresholds are not
   * the shape the gate writes: those newer than `gate`, or every one when
   * `gate` is null. They are counted, never read.
   */
  readonly unreadable: number;
  /**
   * True when `unreadable` is a bound, not a count: two spellings of one
   * intent merged, and some of one spelling's unread rows can be older than
   * the record shown.
   */
  readonly unreadableAtMost: boolean;
}

/** What the ledger records about where a product's cases come from. */
export interface ChannelSignals {
  /**
   * When the newest run or waiting message of the product arrived, or null.
   * A run with no arrival time recorded counts from its start.
   */
  readonly lastArrival: string | null;
  /** Messages of the product waiting for a consumer. */
  readonly waiting: number;
  /** When the oldest of those arrived, or null. */
  readonly oldestWaiting: string | null;
  /** Waiting messages a consumer failed to process at least once. */
  readonly retried: number;
}

export interface RoutingProduct {
  /** The product, or null for a channel that maps to none. */
  readonly product: string | null;
  readonly intents: readonly RoutingIntent[];
  /**
   * Intents the gate recorded for this product that the taxonomy does not
   * list, such as one renamed or removed since. They are counted, not shown.
   */
  readonly unlisted: number;
  readonly channels: ChannelSignals;
}

export interface RoutingReport {
  /** Each product any run, gate row or waiting message names. */
  readonly products: readonly RoutingProduct[];
}

interface GateRow {
  readonly product: string | null;
  readonly intent_id: string;
  /** Null when no gate row of this product and intent could be read. */
  readonly gate_at: Date | null;
  readonly reason: unknown;
  readonly thresholds: unknown;
  readonly unreadable: number;
  /** The newest run whose gate row this record considered. */
  readonly run_created_at: Date;
}

/**
 * The routing screen's figures, for the intents of the taxonomy.
 *
 * One read-only transaction. Read-only. Safe against a live database.
 */
export async function readRouting(
  pool: Pool,
  options: {
    readonly intents: readonly { readonly id: string; readonly risk_tier: RiskTier }[];
    readonly products?: readonly string[];
    readonly timeoutMs?: number;
    readonly clientTimeoutMs?: number;
  },
): Promise<RoutingReport> {
  const timeoutMs = options.timeoutMs ?? ROUTING_TIMEOUT_MS;
  return boundedRead(pool, 'readRouting', timeoutMs, options.clientTimeoutMs ?? timeoutMs + 1_000, (query) =>
    routingIn(query, options.intents, options.products ?? []));
}

async function routingIn(
  query: BoundedQuery,
  intents: readonly { readonly id: string; readonly risk_tier: RiskTier }[],
  configured: readonly string[],
): Promise<RoutingReport> {
  const gates = await query<GateRow>(
    'SELECT product, intent_id, run_created_at, gate_at, reason, thresholds, unreadable FROM gate_latest',
  );
  // The products runs name, one index probe each rather than a scan of every
  // run: the next product above the last, then its newest arrival (db/038).
  // The runs of no product are probed on their own, since `>` never reaches
  // a null.
  const arrivals = await query<{ product: string | null; last_arrival: Date }>(
    `WITH RECURSIVE named AS (
       SELECT min(product) AS product FROM run
       UNION ALL
       SELECT (SELECT min(r.product) FROM run r WHERE r.product > n.product)
         FROM named n WHERE n.product IS NOT NULL
     ), last AS (
       SELECT n.product,
              (SELECT max(COALESCE(r.enqueued_at, r.created_at)) FROM run r WHERE r.product = n.product)
                AS last_arrival
         FROM named n WHERE n.product IS NOT NULL
       UNION ALL
       -- Its own partial index (db/038): the planner does not read the
       -- product index in order under IS NULL, and a ledger that maps no
       -- product holds nothing else.
       SELECT NULL, (SELECT COALESCE(r.enqueued_at, r.created_at) FROM run r WHERE r.product IS NULL
                      ORDER BY COALESCE(r.enqueued_at, r.created_at) DESC LIMIT 1)
     )
     SELECT product, last_arrival FROM last WHERE last_arrival IS NOT NULL`,
  );
  // Messages waiting for a consumer. The queue holds what has not been
  // processed yet, so this reads a backlog, not the history.
  const waiting = await query<{
    product: string | null; last_arrival: Date; waiting: string; oldest: Date; retried: string;
  }>(
    `SELECT product, max(enqueued_at) AS last_arrival, count(*) AS waiting, min(enqueued_at) AS oldest,
            count(*) FILTER (WHERE attempts > 0) AS retried
       FROM intake GROUP BY product`,
  );

  const listed = new Set(intents.map((intent) => normalizeIntentId(intent.id)));
  const latest = new Map<string, { gate: GateRecord | null; unreadable: number; atMost: boolean }>();
  const merged = new Map<string, { record: GateRecord | null; unreadable: number; through: Date }[]>();
  const unlistedKeys = new Map<string | null, Set<string>>();
  for (const row of gates) {
    const intent = normalizeIntentId(row.intent_id);
    if (!listed.has(intent)) {
      unlistedKeys.set(row.product, (unlistedKeys.get(row.product) ?? new Set()).add(intent));
      continue;
    }
    // A row with a readable record that the reader still refuses counts as
    // one more unread row, and shows no record.
    const record = row.gate_at === null ? null : recordOf(row, row.gate_at);
    const unreadable = row.unreadable + (row.gate_at !== null && record === null ? 1 : 0);
    const key = pairKey(row.product, intent);
    const spellings = merged.get(key) ?? [];
    spellings.push({ record, unreadable, through: row.run_created_at });
    merged.set(key, spellings);
  }
  // The backfill keeps the classifier's own spelling, and the gate keys an
  // intent as the policy engine does, so one intent can hold two rows. The
  // newest record shows. A row's unread rows lie after its own record and at
  // or before the newest run it read, so they count only when that run is
  // newer than the record shown.
  for (const [key, spellings] of merged) {
    const gate = spellings
      .map((spelling) => spelling.record)
      .filter((record): record is GateRecord => record !== null)
      .reduce<GateRecord | null>((newest, record) => (newest === null || record.at > newest.at ? record : newest), null);
    const counted = spellings
      .filter((spelling) => gate === null || spelling.record === gate || spelling.through.toISOString() > gate.at);
    const unreadable = counted.reduce((sum, spelling) => sum + spelling.unreadable, 0);
    // Another spelling's unread rows lie between its own record and its
    // newest run, and the record shown can fall between the two.
    const atMost = counted.some((spelling) => spelling.record !== gate && spelling.unreadable > 0
      && gate !== null && (spelling.record === null || spelling.record.at < gate.at));
    latest.set(key, { gate, unreadable, atMost });
  }
  const unlisted = new Map([...unlistedKeys].map(([product, keys]) => [product, keys.size]));

  const arrived = new Map(arrivals.map((row) => [row.product, row.last_arrival]));
  const queued = new Map(waiting.map((row) => [row.product, row]));
  const names = new Set<string | null>([
    ...configured, ...gates.map((row) => row.product), ...arrived.keys(), ...queued.keys(),
  ]);
  const products = [...names].sort(byProductName).map((product): RoutingProduct => {
    const queue = queued.get(product);
    const lastRun = arrived.get(product);
    const lastArrival = [lastRun, queue?.last_arrival]
      .filter((at): at is Date => at !== undefined)
      .reduce<Date | null>((newest, at) => (newest === null || at > newest ? at : newest), null);
    return {
      product,
      intents: intents.map((intent) => {
        const held = latest.get(pairKey(product, normalizeIntentId(intent.id)));
        return {
          id: intent.id,
          risk: intent.risk_tier,
          gate: held?.gate ?? null,
          unreadable: held?.unreadable ?? 0,
          unreadableAtMost: held?.atMost ?? false,
        };
      }),
      unlisted: unlisted.get(product) ?? 0,
      channels: {
        lastArrival: lastArrival?.toISOString() ?? null,
        waiting: Number(queue?.waiting ?? 0),
        oldestWaiting: queue?.oldest.toISOString() ?? null,
        retried: Number(queue?.retried ?? 0),
      },
    };
  });
  return { products };
}

/**
 * A gate row as a record, or null when its reason or thresholds are not the
 * shape the gate writes. A row the reader cannot trust is never a verdict.
 */
function recordOf(row: GateRow, at: Date): GateRecord | null {
  const reason = row.reason;
  if (typeof reason !== 'string' || !Object.hasOwn(STOPS, reason)) return null;
  const thresholds = row.thresholds;
  if (thresholds === null || typeof thresholds !== 'object' || Array.isArray(thresholds)) return null;
  const agreement = (thresholds as { agreement?: unknown }).agreement;
  if (!isThreshold(agreement)) return null;
  const perIntent = (thresholds as { perIntent?: unknown }).perIntent;
  let fitted: number | undefined;
  if (perIntent !== undefined && perIntent !== null) {
    if (typeof perIntent !== 'object' || Array.isArray(perIntent)) return null;
    const key = normalizeIntentId(row.intent_id);
    if (Object.hasOwn(perIntent, key)) {
      const value = (perIntent as Record<string, unknown>)[key];
      if (!isThreshold(value)) return null;
      fitted = value;
    }
  }
  const policyReason = reason as PolicyReason;
  return {
    at: at.toISOString(),
    reason: policyReason,
    mayAct: !STOPS[policyReason],
    threshold: fitted ?? agreement,
    fitted: fitted !== undefined,
  };
}

function isThreshold(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
}

function pairKey(product: string | null, intent: string): string {
  return JSON.stringify([product, intent]);
}

/** Products by name, with the cases of no product last. */
function byProductName(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}
