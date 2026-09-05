// The planner is pure and its output is fully determined by its seed.
//
// A band built from a history nobody can reproduce is a number nobody can
// check, so determinism is the first property and it is asserted directly:
// two plans from one seed are identical, and two seeds differ.
import { describe, expect, it } from 'vitest';

import {
  POLICY_REASONS,
  evaluatePolicyDetailed,
  passedAgreementGate,
  reachedAgreementGate,
  type PolicyReason,
} from '../policy/policy.js';
import { partitionOf } from '../coordinator/coordinator.js';
import {
  dayBefore,
  logNormal,
  mulberry32,
  planHistory,
  seededUuid,
  stateFor,
} from './plan.js';

const OPTIONS = {
  seed: 0x41726361, days: 45, endDay: '2026-06-30', partitions: 4, provider: 'stub',
};

/** The queue wait of every run in a plan, sorted. */
function waitsOf(options: Parameters<typeof planHistory>[0]): number[] {
  return planHistory(options)
    .map((r) => r.createdAt.getTime() - r.enqueuedAt.getTime())
    .sort((a, b) => a - b);
}

function mean(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** The value at `p` of a sorted list. */
function quantile(sorted: readonly number[], p: number): number {
  return sorted[Math.floor(sorted.length * p)] ?? 0;
}

describe('the planner is deterministic', () => {
  it('gives byte-identical plans from one seed', () => {
    expect(JSON.stringify(planHistory(OPTIONS))).toBe(JSON.stringify(planHistory(OPTIONS)));
  });

  it('gives a different plan from a different seed', () => {
    const other = planHistory({ ...OPTIONS, seed: OPTIONS.seed + 1 });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(planHistory(OPTIONS)));
  });

  it('reads no wall clock, so the plan does not depend on when it ran', () => {
    const first = planHistory(OPTIONS);
    const second = planHistory(OPTIONS);
    expect(first[0]!.createdAt.toISOString()).toBe(second[0]!.createdAt.toISOString());
    expect(first.at(-1)!.finishedAt?.toISOString()).toBe(second.at(-1)!.finishedAt?.toISOString());
  });
});

describe('seededUuid', () => {
  it('is a valid v4-shaped uuid', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 200; i += 1) {
      expect(seededUuid(rng)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it('does not repeat across a history', () => {
    const plan = planHistory(OPTIONS);
    const ids = new Set(plan.map((r) => r.runId));
    expect(ids.size).toBe(plan.length);
  });
});

describe('the history it plans', () => {
  const plan = planHistory(OPTIONS);

  it('covers the requested number of UTC days', () => {
    const days = new Set(plan.map((r) => r.createdAt.toISOString().slice(0, 10)));
    // A run started late can finish after midnight, and its pickup day is
    // what bands keys on, so the count is over pickups.
    expect(days.size).toBeGreaterThanOrEqual(45);
  });

  it('ends on the requested day', () => {
    const days = [...new Set(plan.map((r) => r.createdAt.toISOString().slice(0, 10)))].sort();
    expect(days.at(-1)).toBe('2026-06-30');
  });

  // A reason bands no longer knows lands in gate_obsolete, and the seeded
  // history would read as a ledger the reader cannot interpret.
  it('uses only reasons the policy engine still knows', () => {
    for (const run of plan) {
      // Null is a run that never gated, which is what an abstain produces.
      if (run.reason !== null) expect(POLICY_REASONS).toContain(run.reason);
    }
  });

  it('routes every run to the partition the real hash gives it', () => {
    for (const run of plan) {
      expect(run.partition).toBe(partitionOf(run.conversationId, OPTIONS.partitions));
    }
  });

  // The timing must be a timeline, or the ledger refuses it and the reader
  // labels it unordered.
  it('plans a timeline the ledger will accept', () => {
    for (const run of plan) {
      expect(run.createdAt.getTime()).toBeGreaterThanOrEqual(run.enqueuedAt.getTime());
      if (run.finishedAt !== null) {
        expect(run.finishedAt.getTime()).toBeGreaterThanOrEqual(run.createdAt.getTime());
      }
    }
  });
});

// The queue wait is the property issue #25 reads, and it is not drawn. It is
// what the serial walk produces, so these cases assert the walk rather than
// a number.
describe('the queue wait the serial walk produces', () => {
  const plan = planHistory(OPTIONS);

  it('never starts a run before its message arrived', () => {
    for (const run of plan) {
      expect(run.createdAt.getTime()).toBeGreaterThanOrEqual(run.enqueuedAt.getTime());
    }
  });

  // One consumer walks its whole batch serially, across every partition it
  // owns, so two runs of one CONSUMER never overlap. Asserted per consumer
  // and not per partition, because the cross-partition case is precisely the
  // head-of-line delay open item 7 names — a model with one server per
  // partition cannot produce it at all.
  it('never overlaps two runs of one consumer', () => {
    const owner = (partition: number): number => Math.floor(partition / (4 / 2));
    const byConsumer = new Map<number, { start: number; end: number }[]>();
    for (const run of plan) {
      const key = owner(run.partition);
      const list = byConsumer.get(key) ?? [];
      // A run awaiting a person occupies the consumer only for its own work,
      // not for the wait. The serial walk released it when the work ended.
      list.push({
        start: run.createdAt.getTime(),
        end: run.createdAt.getTime() + run.serviceMs,
      });
      byConsumer.set(key, list);
    }
    expect(byConsumer.size).toBe(2);
    for (const spans of byConsumer.values()) {
      spans.sort((a, b) => a.start - b.start);
      for (let i = 1; i < spans.length; i += 1) {
        expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
      }
    }
  });

  // The two regimes, measured side by side.
  //
  // These are the figures issue #25 turns on, so both are pinned and neither
  // is quoted from the other. `wakeOnArrival: false` is the loop that the
  // #23 reading measured: intake queued a row and the consumer did not look
  // until its next tick. True is the loop that ships after #25.
  //
  // The pair is what makes each number evidence. A wake that did nothing
  // would leave the two columns equal, and every assertion below that names
  // a difference would fail. The figures the shipped documents quote are
  // pinned separately, in `pins the figures the register and the roadmap
  // quote` — a bound loose enough to survive any draw pins no document.
  it('removes the poll floor from the wait when it wakes on arrival', () => {
    const polled = waitsOf({ ...OPTIONS, wakeOnArrival: false });
    const woken = waitsOf({ ...OPTIONS, wakeOnArrival: true });

    // The reading that decided the correction: a mean sitting within a
    // whisker of half a poll period, which is what a message arriving at a
    // uniform instant waits when nothing is ahead of it.
    expect(mean(polled)).toBeGreaterThan(2_400);
    expect(mean(polled)).toBeLessThan(3_200);
    expect(quantile(polled, 0.5)).toBeGreaterThan(2_000);
    expect(quantile(polled, 0.95)).toBeGreaterThan(4_000);

    // With the signal, almost every message is picked up the instant it is
    // queued, so the median and the 95th are both zero rather than small.
    expect(quantile(woken, 0.5)).toBe(0);
    expect(quantile(woken, 0.95)).toBe(0);
    expect(woken.filter((w) => w === 0).length / woken.length).toBeGreaterThan(0.95);

    // The mean falls by an order of magnitude, and the assertion is on the
    // ratio rather than on either figure, so it survives a reseed.
    expect(mean(woken)).toBeLessThan(mean(polled) / 5);
  });

  // What the wake does not touch, stated as plainly as what it does.
  //
  // The residual tail is a message waiting behind the batch ahead of it —
  // real queueing, and the head-of-line delay open item 7 names. A signal
  // cannot shorten a run that is already under way, so removing the tick
  // cannot remove that wait. Reporting the wake as a fix for head-of-line
  // delay would be the same overstatement this suite exists to prevent.
  //
  // The property is an inequality, and it is asserted across seeds. An
  // earlier version asserted equality and passed only on the committed seed:
  // it held on 0x41726361 and failed on seven of the next eight, always in
  // the same direction. Waking does shave a little queueing, because a
  // message picked up a tick earlier also frees the consumer a tick earlier.
  // A little is not none, and a number that is true of one draw is not a
  // property.
  it('leaves the queueing behind a batch where it was, or slightly below', () => {
    const beyond = (waits: number[]): number =>
      waits.filter((w) => w > 5_000).length / waits.length;

    for (let seed = OPTIONS.seed; seed < OPTIONS.seed + 6; seed += 1) {
      const polled = beyond(waitsOf({ ...OPTIONS, seed, wakeOnArrival: false }));
      const woken = beyond(waitsOf({ ...OPTIONS, seed, wakeOnArrival: true }));

      // Never above: the wake removes the tick and adds no queueing.
      expect(woken).toBeLessThanOrEqual(polled);
      // And never a correction: it removes at most a small part of it.
      expect(woken).toBeGreaterThan(polled * 0.5);
      // Both stay near one run in a hundred, which is why no head-of-line
      // rule fires at this load.
      expect(polled).toBeLessThan(0.03);
    }

    // The tail keeps its order of magnitude. One poll period leaves it.
    const polledWaits = waitsOf({ ...OPTIONS, wakeOnArrival: false });
    const wokenWaits = waitsOf({ ...OPTIONS, wakeOnArrival: true });
    expect(Math.max(...wokenWaits)).toBeGreaterThan(Math.max(...polledWaits) - 5_000);
  });

  // Under two per cent busy, in either regime. A queue forms near
  // saturation, not here, and the wake changes no run's service time.
  it('stays far from saturation, which is why no rule R1 to R4 fires', () => {
    const totalWork = plan.reduce((sum, r) => sum + r.serviceMs, 0);
    const consumers = 2;
    const utilisation = totalWork / (consumers * OPTIONS.days * 11 * 3_600_000);
    expect(utilisation).toBeLessThan(0.02);
  });

  // Every figure the shipped documents quote, pinned to the value they
  // quote.
  //
  // This case exists because the suite claimed the numbers were pinned and
  // they were not. `docs/v1-architecture.md` and `docs/v2-roadmap.md` name a
  // utilisation of 1.37 per cent, a depth ratio of 1.14 and a prior wait of
  // 2.4 to 2.7 s at the median. Loose bounds like "under two per cent" and
  // "above two seconds" let every one of those move in silence, which is the
  // failure the surrounding comments say the suite prevents.
  it('pins the figures the register and the roadmap quote', () => {
    const totalWork = plan.reduce((sum, r) => sum + r.serviceMs, 0);
    const utilisation = totalWork / (2 * OPTIONS.days * 11 * 3_600_000);
    // "1.37 per cent utilisation".
    expect(utilisation).toBeGreaterThan(0.0130);
    expect(utilisation).toBeLessThan(0.0145);

    const depth = new Map<number, number>();
    for (const run of plan) depth.set(run.partition, (depth.get(run.partition) ?? 0) + 1);
    const counts = [...depth.values()];
    // "a depth ratio of 1.14, which is what a hash gives".
    expect(counts).toHaveLength(OPTIONS.partitions);
    expect(Math.max(...counts) / Math.min(...counts)).toBeLessThan(1.2);

    // "2.4 to 2.7 s and 4.7 to 4.8 s before", per partition, on the loop
    // this change replaced.
    const polled = planHistory({ ...OPTIONS, wakeOnArrival: false });
    for (const partition of counts.keys()) {
      const waits = polled
        .filter((r) => r.partition === partition)
        .map((r) => r.createdAt.getTime() - r.enqueuedAt.getTime())
        .sort((a, b) => a - b);
      expect(quantile(waits, 0.5)).toBeGreaterThan(2_400);
      expect(quantile(waits, 0.5)).toBeLessThan(2_700);
      expect(quantile(waits, 0.95)).toBeGreaterThan(4_700);
      expect(quantile(waits, 0.95)).toBeLessThan(4_900);
    }

    // "the maximum wait barely moves". The documents rest the
    // no-correction claim on this figure, so it is pinned across seeds
    // rather than on one draw. A 0.95 bound passed the committed seed and
    // failed two of the next eleven, which is a figure quoted rather than
    // pinned — the defect this whole case exists to remove.
    // The ratio, not the value. The worst wait itself runs from 40 s to
    // 191 s across seeds, so `2.3 minutes` is one history's reading and the
    // documents attribute it to that history. What holds everywhere is that
    // the wake leaves the tail almost untouched: it keeps at least 90 per
    // cent of its value, and never grows.
    for (let seed = OPTIONS.seed; seed < OPTIONS.seed + 6; seed += 1) {
      const worst = Math.max(...waitsOf({ ...OPTIONS, seed, wakeOnArrival: false }));
      const after = Math.max(...waitsOf({ ...OPTIONS, seed, wakeOnArrival: true }));
      expect(after).toBeGreaterThan(worst * 0.9);
      expect(after).toBeLessThanOrEqual(worst);
    }

    // And the reading the documents quote, from the committed seed.
    const quoted = Math.max(...waitsOf({ ...OPTIONS, wakeOnArrival: false }));
    expect(quoted).toBeGreaterThan(130_000);
    expect(quoted).toBeLessThan(140_000);
  });

  // Poisson, so the gaps are exponential and the day carries clusters. A
  // uniform spread never fills a poll batch, and a full batch is where the
  // delay lives.
  it('clusters arrivals rather than spreading them evenly', () => {
    const gaps = plan
      .filter((r) => r.createdAt.toISOString().slice(0, 10) === '2026-06-20')
      .map((r) => r.enqueuedAt.getTime())
      .sort((a, b) => a - b)
      .map((t, i, all) => (i === 0 ? null : t - all[i - 1]!))
      .filter((g): g is number => g !== null)
      .sort((a, b) => a - b);
    // An exponential gap has a standard deviation equal to its mean, so the
    // spread is wide. A uniform spread would put every gap near the mean.
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(gaps[0]!).toBeLessThan(mean * 0.35);
    expect(gaps.at(-1)!).toBeGreaterThan(mean * 2);
  });

  // Uniform by construction: the hash spreads, and nothing here skews it.
  // Asserted so a later change that did skew it announces itself, because
  // depth is exactly what tells rule R1 and R2 apart from R3.
  it('spreads depth evenly across partitions', () => {
    const counts = new Map<number, number>();
    for (const run of plan) counts.set(run.partition, (counts.get(run.partition) ?? 0) + 1);
    const values = [...counts.values()];
    expect(values).toHaveLength(OPTIONS.partitions);

    // The bound is derived, not chosen to fit. Assignment is a hash, so each
    // partition's count is binomial: about n/4 with a standard deviation of
    // sqrt(n * (1/4) * (3/4)). Over roughly 2400 runs that is about 600 give
    // or take 21, so the extremes of four draws sit a few deviations apart
    // and a ratio near 1.16 is ordinary. Four deviations either way gives
    // 1.30, and anything past that is a skew somebody introduced.
    //
    // Tightening this until the current seed passes would be tuning the
    // seeder against its own check, and depth is exactly what tells rules R1
    // and R2 apart from R3.
    const n = plan.length;
    const expected = n / OPTIONS.partitions;
    const sigma = Math.sqrt(n * 0.25 * 0.75);
    for (const count of values) {
      expect(Math.abs(count - expected)).toBeLessThan(4 * sigma);
    }
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(1.3);
  });

  // Heavy-tailed because a run makes twelve model calls. Asserted as a shape,
  // not as a wanted verdict: the p99 of a log-normal at this sigma sits well
  // above its median, and a change that flattened it would change what issue
  // #25 reads.
  it('draws a heavy-tailed service time', () => {
    // The work, not `finished_at - created_at`. An approved run's stored
    // service time includes the wait for the person, which is a different
    // quantity and a much larger one.
    const service = plan.map((r) => r.serviceMs).sort((a, b) => a - b);
    const at = (q: number): number => service[Math.floor(service.length * q)]!;
    expect(at(0.99) / at(0.5)).toBeGreaterThan(4);
  });
});

describe('the degraded day', () => {
  const plan = planHistory(OPTIONS);
  const rateOn = (day: string): number => {
    const runs = plan.filter((r) => r.createdAt.toISOString().slice(0, 10) === day);
    // Derived from the engine, never a second copy of its partition.
    // `policy.ts` exports these two so a reader cannot drift from the
    // precedence order, and `bands/query.ts` builds its lists the same way.
    const reached = runs.filter(
      (r) => r.reason !== null && reachedAgreementGate(r.reason as PolicyReason),
    );
    const passed = reached.filter((r) => passedAgreementGate(r.reason as PolicyReason));
    return passed.length / reached.length;
  };

  it('drops the gate pass rate well below an ordinary day', () => {
    // Against the median of every other day, not one sampled day. One day
    // can land anywhere in the ordinary spread, and comparing against it
    // makes the case a coin toss rather than a statement about the history.
    const days = [...new Set(plan.map((r) => r.createdAt.toISOString().slice(0, 10)))].sort();
    const degradedDay = dayBefore(OPTIONS.endDay, 4);
    const ordinary = days
      .filter((d) => d !== degradedDay)
      .map(rateOn)
      .sort((a, b) => a - b);
    const median = ordinary[Math.floor(ordinary.length / 2)]!;
    expect(rateOn(degradedDay)).toBeLessThan(median - 0.25);
  });

  it('degrades exactly one day', () => {
    const days = [...new Set(plan.map((r) => r.createdAt.toISOString().slice(0, 10)))].sort();
    const low = days.filter((d) => rateOn(d) < 0.6);
    expect(low).toEqual([dayBefore(OPTIONS.endDay, 4)]);
  });
});

// The mapping from a gate reason to the state a run ends in. Read off the
// engine rather than restated, so a reason that changed decision would fail
// here instead of quietly writing a shape the system never produces.
//
// Nothing pinned this before. Flipping groundedness_block to 'resolved', or
// dropping the abstain rule, left the whole suite green — and the earlier
// version of this seeder marked all 2397 runs 'resolved', including 1112
// customer replies DEC-12 routes to a person.
describe('the reason each run ends under', () => {
  const thresholds = { agreement: 0.6, groundednessBlock: 0.7, groundednessReview: 0.8 };

  /** The engine's own decision for a reason, driven to produce that reason. */
  function decisionFor(reason: PolicyReason): string {
    const base = {
      capabilities: {
        supportsIdempotencyKey: true,
        supportsReadBack: true,
        supportsDraft: true,
        supportsDraftState: true,
        supportsStructuredFields: true,
        supportsThreading: true,
        supportsAttachments: true,
      },
      action: { isWrite: true, isCustomerVisible: false, isIrreversible: false },
      riskTier: 'low' as const,
      agreement: 1,
      groundedness: 1,
      thresholds,
    };
    const input = { ...base };
    switch (reason) {
      case 'no_idempotency':
        input.capabilities = { ...base.capabilities, supportsIdempotencyKey: false };
        break;
      case 'no_read_back':
        input.capabilities = { ...base.capabilities, supportsReadBack: false };
        break;
      case 'customer_visible':
        input.action = { ...base.action, isCustomerVisible: true };
        break;
      case 'irreversible':
        input.action = { ...base.action, isIrreversible: true };
        break;
      case 'high_risk':
        input.riskTier = 'high' as never;
        break;
      case 'agreement':
        input.agreement = 0.1;
        break;
      case 'groundedness_block':
        input.groundedness = 0.1;
        break;
      case 'groundedness_review':
        input.groundedness = 0.75;
        break;
      default:
        break;
    }
    const outcome = evaluatePolicyDetailed(input);
    expect(outcome.reason).toBe(reason);
    return outcome.decision;
  }

  it('ends every reason in the state the engine implies', () => {
    for (const reason of POLICY_REASONS) {
      const decision = decisionFor(reason);
      const unapproved = stateFor(reason, false);
      if (decision === 'auto') expect(unapproved).toBe('resolved');
      else if (decision === 'escalate') expect(unapproved).toBe('escalated');
      else expect(unapproved).toBe('awaiting_approval');
    }
  });

  it('resolves a parked run once a person approves it', () => {
    for (const reason of POLICY_REASONS) {
      if (decisionFor(reason) !== 'gated') continue;
      expect(stateFor(reason, true)).toBe('resolved');
    }
  });

  // An approval cannot rescue a run the engine escalated, and cannot change
  // one it never gated.
  it('leaves an escalated or automatic run where the engine put it', () => {
    for (const reason of POLICY_REASONS) {
      const decision = decisionFor(reason);
      if (decision === 'gated') continue;
      expect(stateFor(reason, true)).toBe(stateFor(reason, false));
    }
  });
});

describe('the shapes the planner refuses to write', () => {
  const plan = planHistory(OPTIONS);

  // An abstain escalates before the gate step starts, so it has no gate row.
  it('gives an abstained run no gate reason and escalates it', () => {
    const abstained = plan.filter((r) => r.abstained);
    expect(abstained.length).toBeGreaterThan(0);
    for (const run of abstained) {
      expect(run.reason).toBeNull();
      expect(run.state).toBe('escalated');
    }
  });

  // A run waiting for a person has not finished, and the clock seam refuses
  // a finish for a state that has not finished.
  it('gives a parked run no finish', () => {
    const parked = plan.filter((r) => r.state === 'awaiting_approval');
    expect(parked.length).toBeGreaterThan(0);
    for (const run of parked) expect(run.finishedAt).toBeNull();
  });

  it('gives every terminal run a finish', () => {
    for (const run of plan) {
      if (run.state !== 'awaiting_approval') expect(run.finishedAt).not.toBeNull();
    }
  });

  // DEC-30 makes an unknown delivery terminal and escalating.
  it('escalates every run carrying an unknown delivery', () => {
    const unknown = plan.filter((r) => r.outbox.includes('delivery_unknown'));
    expect(unknown.length).toBeGreaterThan(0);
    for (const run of unknown) expect(run.state).toBe('escalated');
  });

  // The customer replies DEC-12 routes to a person. An earlier version marked
  // every one of them resolved.
  it('parks or resolves a customer reply, never escalates it', () => {
    const replies = plan.filter((r) => r.reason === 'customer_visible');
    expect(replies.length).toBeGreaterThan(0);
    for (const run of replies) {
      expect(['awaiting_approval', 'resolved']).toContain(run.state);
    }
    expect(replies.some((r) => r.state === 'awaiting_approval')).toBe(true);
  });
});

describe('logNormal', () => {
  it('never returns a negative duration', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 5000; i += 1) expect(logNormal(rng, 14_000, 0.9)).toBeGreaterThanOrEqual(0);
  });

  it('has a median near the one it was given', () => {
    const rng = mulberry32(7);
    const draws = Array.from({ length: 20_000 }, () => logNormal(rng, 14_000, 0.9))
      .sort((a, b) => a - b);
    expect(draws[10_000]!).toBeGreaterThan(13_000);
    expect(draws[10_000]!).toBeLessThan(15_000);
  });
});
