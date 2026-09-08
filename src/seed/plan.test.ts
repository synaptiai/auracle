// The planner is pure and its output is fully determined by its seed.
//
// A band built from a history nobody can reproduce is a number nobody can
// check, so determinism is the first property and it is asserted directly:
// two plans from one seed are identical, and two seeds differ.
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  GATE_AGREEMENT,
  GROUNDEDNESS_BLOCK,
  GROUNDEDNESS_REVIEW,
  POLICY_REASONS,
  SEED_THRESHOLDS,
  evaluatePolicyDetailed,
  passedAgreementGate,
  reachedAgreementGate,
  type PolicyReason,
} from '../policy/policy.js';
import { partitionOf } from '../coordinator/coordinator.js';
import { CLASSIFIER_K } from '../classifier/classifier.js';
import { loadTaxonomy } from '../fixtures/load.js';
import {
  SEED_DOCUMENTS,
  SEED_INTENTS,
  COURTESY_CLOSINGS,
  COURTESY_OPENINGS,
  UNSUPPORTED_CLAIMS,
  dayBefore,
  logNormal,
  logNormalUnit,
  mulberry32,
  planHistory,
  policyInputFor,
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

describe('the claims a planned run makes', () => {
  const plan = planHistory({ seed: 0x41726361, days: 3, endDay: '2026-06-30', partitions: 4, provider: 'stub' });

  it('cites only documents the run retrieved (DEC-07)', () => {
    for (const run of plan) {
      for (const claim of run.claims) {
        expect(run.docIds, run.runId).toContain(claim.docId);
      }
    }
  });

  it('makes exactly the number of claims the compose row reports', () => {
    for (const run of plan) {
      expect(run.claims.length, run.runId).toBe(run.claimCount);
    }
  });

  // The invariant the whole change rests on. The gate row records one
  // fraction and the verdicts record the same fact claim by claim. A reader
  // that recounts them must reach the number the policy engine read, or the
  // ledger holds two answers and says nothing about which one decided.
  it('supports exactly the share of claims the coverage records', () => {
    let checked = 0;
    for (const run of plan) {
      if (run.gate === null) continue;
      const supported = run.claims.filter((claim) => claim.supported).length;
      expect(supported / run.claims.length, run.runId).toBeCloseTo(run.gate.groundedness, 10);
      checked += 1;
    }
    // Non-vacuity: a plan with no gated run would pass the loop above having
    // compared nothing.
    expect(checked).toBeGreaterThan(0);
  });

  // `src/composer/composer.ts` builds a draft as `claims.map(c => c.text)
  // .join(' ')`. A seeder that wrote the two independently produced a ledger
  // the system cannot: the park row said one thing, the compose row another,
  // and every surface that renders the claims showed text the draft did not
  // contain.
  it('makes the draft the whole partition joined, as the composer does', () => {
    let checked = 0;
    for (const run of plan) {
      if (run.park === null || run.claims.length === 0) continue;
      expect(run.park.body, run.runId).toBe(run.sentences.map((s) => s.text).join(' '));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  // DEC-43. The claims are the cited subset, in draft order, which is what
  // makes a gate verdict recorded by position sound.
  it('keeps the claims as the cited sentences, in draft order', () => {
    let checked = 0;
    for (const run of plan) {
      if (run.claims.length === 0) continue;
      expect(
        run.sentences.filter((s) => s.docId !== null).map((s) => ({
          text: s.text, docId: s.docId, supported: s.supported,
        })),
        run.runId,
      ).toEqual(run.claims.map((c) => ({
        text: c.text, docId: c.docId, supported: c.supported,
      })));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  // The shape the composer's parser accepts: one optional courtesy sentence,
  // the claims, one optional courtesy sentence. A seeded run outside it would
  // model a ledger the system cannot produce, which is the defect this whole
  // change came from.
  it('drafts only replies the composer could have composed (DEC-43)', () => {
    for (const run of plan) {
      if (run.sentences.length === 0) continue;
      const shape = run.sentences.map((s) => (s.docId === null ? 'c' : 'd')).join('');
      expect(shape, run.runId).toMatch(/^c?d+c?$/);
    }
  });

  // All four shapes, because a console that only ever met one of them proves
  // nothing about the other three.
  it('draws a reply that opens, one that closes, one that does both and one that does neither', () => {
    const shapes = new Set<string>();
    for (const run of plan) {
      if (run.sentences.length === 0) continue;
      const opens = run.sentences[0]?.docId === null;
      const closes = run.sentences[run.sentences.length - 1]?.docId === null;
      shapes.add(`${opens ? 'o' : '-'}${closes ? 'c' : '-'}`);
    }
    expect([...shapes].sort()).toEqual(['--', '-c', 'o-', 'oc']);
  });

  // An opening opens and a closing closes. The membership check elsewhere
  // tests the union of the two lists, so a seeder that swapped them would
  // pass it while every reply ended "Thanks for getting in touch about this."
  it('opens from the openings and closes from the closings', () => {
    let opened = 0;
    let closed = 0;
    for (const run of plan) {
      if (run.sentences.length === 0) continue;
      const first = run.sentences[0]!;
      const last = run.sentences[run.sentences.length - 1]!;
      if (first.docId === null) {
        expect(COURTESY_OPENINGS, run.runId).toContain(first.text);
        expect(COURTESY_CLOSINGS, run.runId).not.toContain(first.text);
        opened += 1;
      }
      if (last.docId === null && last !== first) {
        expect(COURTESY_CLOSINGS, run.runId).toContain(last.text);
        expect(COURTESY_OPENINGS, run.runId).not.toContain(last.text);
        closed += 1;
      }
    }
    expect(opened).toBeGreaterThan(0);
    expect(closed).toBeGreaterThan(0);
  });

  // The lists exist so a console meets more than one of each. A seeder that
  // always took the first entry would pass every other check here.
  it('varies the opening and the closing across the history', () => {
    const openings = new Set<string>();
    const closings = new Set<string>();
    for (const run of plan) {
      if (run.sentences.length === 0) continue;
      const first = run.sentences[0]!;
      const last = run.sentences[run.sentences.length - 1]!;
      if (first.docId === null) openings.add(first.text);
      if (last.docId === null && last !== first) closings.add(last.text);
    }
    expect(openings.size).toBeGreaterThan(1);
    expect(closings.size).toBeGreaterThan(1);
  });

  // A courtesy sentence states nothing about the customer, the account, the
  // policy or the outcome, so it can never be a sentence of a document. One
  // that was would be a claim drawn without its citation.
  it('grounds no courtesy sentence in any document', () => {
    for (const run of plan) {
      for (const sentence of run.sentences) {
        if (sentence.docId !== null) continue;
        for (const doc of SEED_DOCUMENTS) {
          expect(doc.body, `${run.runId} ${sentence.text}`).not.toContain(sentence.text);
        }
      }
    }
  });

  // An abstain drafts no reply. A courtesy sentence on one would be a run
  // that greeted the customer and then said nothing (DEC-07).
  it('drafts nothing at all for a run that abstained', () => {
    let checked = 0;
    for (const run of plan) {
      if (!run.abstained) continue;
      expect(run.sentences, run.runId).toEqual([]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  // A supported claim is a sentence of the document it cites. That is what
  // grounding is, and it is what gives an operator something to check a
  // citation against.
  it('grounds a supported claim in the document it cites', () => {
    let checked = 0;
    for (const run of plan) {
      for (const claim of run.claims) {
        if (!claim.supported) continue;
        const doc = SEED_DOCUMENTS.find((d) => d.docId === claim.docId)!;
        expect(doc.body, `${run.runId} ${claim.docId}`).toContain(claim.text.replace(/\.$/, ''));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  // And an unsupported one is a concrete promise no document makes, which is
  // the failure the groundedness gate exists to catch.
  it('grounds an unsupported claim in nothing at all', () => {
    let checked = 0;
    for (const run of plan) {
      for (const claim of run.claims) {
        if (claim.supported) continue;
        for (const doc of SEED_DOCUMENTS) {
          expect(doc.body, `${run.runId} ${doc.docId}`).not.toContain(claim.text.replace(/\.$/, ''));
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  // A run citing one document three times said the same sentence three times
  // before this, which reads as a bug to anyone opening the run.
  it('does not repeat a sentence within one reply', () => {
    for (const run of plan) {
      if (run.claims.length === 0) continue;
      const texts = run.claims.map((claim) => claim.text);
      expect(new Set(texts).size, run.runId).toBe(texts.length);
    }
  });

  it('composes no claim when the run abstained', () => {
    const abstains = plan.filter((run) => run.abstained);
    expect(abstains.length).toBeGreaterThan(0);
    for (const run of abstains) {
      expect(run.claims, run.runId).toEqual([]);
      expect(run.gate, run.runId).toBeNull();
    }
  });
});

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

// The steps a run journals, and the numbers that have to agree with them.
//
// A gate reason is a claim about two numbers. Drawn apart from them, the
// claim and the numbers disagree on some fraction of the history, and a
// console that renders a reason beside its agreement and its coverage shows
// the disagreement on screen with nothing to say which side is wrong. So the
// engine itself is the assertion here: every run is fed back through
// `evaluatePolicyDetailed` and must come out with the reason it was planned
// under.
describe('the steps each run journals', () => {
  const plan = planHistory(OPTIONS);

  it('gets the planned reason back out of the policy engine', () => {
    let gated = 0;
    for (const run of plan) {
      const input = policyInputFor(run);
      if (input === null) {
        // An abstain reaches no engine: the coordinator escalates before the
        // gate step starts.
        expect(run.abstained).toBe(true);
        expect(run.reason).toBeNull();
        continue;
      }
      gated += 1;
      const outcome = evaluatePolicyDetailed(input);
      expect(outcome.reason).toBe(run.reason);
      expect(outcome.decision).toBe(run.gate!.decision);
    }
    // Every reason in the tables, not just the common ones.
    expect(gated).toBeGreaterThan(0);
    const seen = new Set(plan.map((r) => r.reason).filter((r) => r !== null));
    expect(seen.size).toBe(POLICY_REASONS.length - 1);
    // `no_read_back` is the one reason no table draws: every shipped adapter
    // declares read-back, so a history that produced it would describe an
    // adapter this repository does not have.
    expect(seen.has('no_read_back')).toBe(false);
  });

  // The thresholds recorded are the engine's own exported set, so a reader
  // sees the seed pair rather than a pair invented for the seeder.
  it('judges every run against the policy engine\'s own seed thresholds', () => {
    for (const run of plan) {
      const input = policyInputFor(run);
      if (input === null) continue;
      expect(input.thresholds).toBe(SEED_THRESHOLDS);
    }
    expect(SEED_THRESHOLDS.agreement).toBe(GATE_AGREEMENT);
    expect(SEED_THRESHOLDS.groundednessBlock).toBe(GROUNDEDNESS_BLOCK);
    expect(SEED_THRESHOLDS.groundednessReview).toBe(GROUNDEDNESS_REVIEW);
  });

  // Agreement is a count of agreeing samples over CLASSIFIER_K. Any other
  // value is a number the classifier cannot report, and a console rendering
  // it as "0.63 of nine samples" would be describing an impossible run.
  it('reports an agreement the classifier could have counted', () => {
    for (const run of plan) {
      const agreement = run.classification.agreement;
      expect(Number.isInteger(agreement * CLASSIFIER_K)).toBe(true);
      expect(agreement).toBeGreaterThan(0);
      expect(agreement).toBeLessThanOrEqual(1);
    }
  });

  // Coverage is `supported / claims.length`, so it is a ratio over the claim
  // count journaled beside it. A coverage drawn free of that count is a value
  // no composition could have produced.
  it('reports a coverage the claim count beside it could produce', () => {
    for (const run of plan) {
      if (run.gate === null) {
        expect(run.claimCount).toBe(0);
        continue;
      }
      expect(run.claimCount).toBeGreaterThan(0);
      const supported = run.gate.groundedness * run.claimCount;
      expect(Math.abs(supported - Math.round(supported))).toBeLessThan(1e-9);
      expect(run.gate.groundedness).toBeGreaterThanOrEqual(0);
      expect(run.gate.groundedness).toBeLessThanOrEqual(1);
    }
  });

  // DEC-13 keeps a high-risk intent off the automatic path whatever the gates
  // read, so a run that got past the risk check cannot carry one. The reasons
  // that return before that check can carry any intent, and must: DEC-12
  // sends every customer reply to a person, and a refund reply is a customer
  // reply first.
  it('carries an intent the risk check allows', () => {
    const tiers = new Map(SEED_INTENTS.map((intent) => [intent.id, intent.riskTier]));
    let highTierReplies = 0;
    for (const run of plan) {
      const tier = tiers.get(run.classification.intentId);
      expect(tier).toBe(run.classification.riskTier);
      if (run.reason === 'high_risk') expect(tier).toBe('high');
      if (run.reason !== null && reachedAgreementGate(run.reason)) expect(tier).not.toBe('high');
      if (run.reason === 'customer_visible' && tier === 'high') highTierReplies += 1;
    }
    expect(highTierReplies).toBeGreaterThan(0);
  });

  // The documents a run cites must be documents the index holds, or a reader
  // joins five identifiers to nothing.
  it('cites documents the seeded index holds, without repeating one', () => {
    const known = new Set(SEED_DOCUMENTS.map((doc) => doc.docId));
    for (const run of plan) {
      expect(run.docIds.length).toBeGreaterThanOrEqual(3);
      // Five is the coordinator's own retrieval limit.
      expect(run.docIds.length).toBeLessThanOrEqual(5);
      expect(new Set(run.docIds).size).toBe(run.docIds.length);
      for (const docId of run.docIds) expect(known.has(docId)).toBe(true);
    }
  });

  // A park record `approveRun` refuses is a park record that leaves the run
  // stuck: `parkRecordFrom` demands a non-empty body and either a draft
  // handle or an action payload.
  it('parks a record the approval path can read back', () => {
    let drafts = 0;
    let ledgerOnly = 0;
    for (const run of plan) {
      if (run.gate?.decision !== 'gated') {
        expect(run.park).toBeNull();
        continue;
      }
      const park = run.park!;
      expect(typeof park.body).toBe('string');
      expect(park.body.length).toBeGreaterThan(0);
      expect(park.actionClass.length).toBeGreaterThan(0);
      expect(['at_least_once', 'at_most_once']).toContain(park.delivery);
      expect(Number.isInteger(park.turnNumber)).toBe(true);
      if (run.reason === 'customer_visible') {
        // DEC-11: the draft lives in the helpdesk, and the handle is what the
        // relay sends against.
        expect(park.draftExternalId).toMatch(/^SYN-DRAFT-/);
        drafts += 1;
      } else {
        // DEC-34: a gated write with no draft parks in the ledger alone, and
        // approval relays the journaled payload.
        expect(park.draftExternalId).toBeUndefined();
        expect(park.payload).toBeDefined();
        ledgerOnly += 1;
      }
    }
    expect(drafts).toBeGreaterThan(0);
    expect(ledgerOnly).toBeGreaterThan(0);
  });

  // DEC-29 binds the delivery rule to the action class, and the coordinator
  // refuses a compensation that declares anything else: a duplicate refund
  // costs money, so an uncertain send escalates rather than retries (DEC-30).
  it('pairs each action class with the delivery rule it declares', () => {
    const performable = new Set(['route_ticket', 'close_ticket', 'compensate']);
    for (const run of plan) {
      if (run.actionClass === 'compensate') {
        expect(run.delivery).toBe('at_most_once');
        expect(run.reason === 'irreversible' || run.abstained).toBe(true);
      } else {
        expect(run.delivery).toBe('at_least_once');
      }
      if (run.actionClass === 'customer_reply') {
        expect(run.reason === 'customer_visible' || run.abstained).toBe(true);
      } else {
        // Everything else rides `performAction`, and the helpdesk adapter
        // refuses a class it cannot perform.
        expect(performable.has(run.actionClass)).toBe(true);
      }
      // Each class carries the field its adapter demands.
      if (run.actionClass === 'route_ticket') {
        expect(typeof run.actionPayload['queue']).toBe('string');
      }
      if (run.actionClass === 'compensate') {
        expect(typeof run.actionPayload['reason']).toBe('string');
      }
    }
  });

  // DEC-18. The draft is the one field a person reads, so it is the one that
  // would carry a real address or a real name if anything did.
  it('writes no address, no telephone number and no account identifier', () => {
    let checked = 0;
    for (const run of plan) {
      if (run.park === null) continue;
      checked += 1;
      const body = run.park.body;
      // Every sentence of a draft comes from one of three closed sets: the
      // bodies of `SEED_DOCUMENTS`, `UNSUPPORTED_CLAIMS`, or the courtesy
      // sentences (DEC-43). Asserted as membership rather than as an absence,
      // because a pattern that hunts for an address cannot say what a body
      // may contain.
      expect(body).toBe(run.sentences.map((sentence) => sentence.text).join(' '));
      for (const sentence of run.sentences) {
        const grounded = SEED_DOCUMENTS.some(
          (doc) => doc.body.includes(sentence.text.replace(/\.$/, '')),
        );
        const written = UNSUPPORTED_CLAIMS.includes(sentence.text)
          || COURTESY_OPENINGS.includes(sentence.text)
          || COURTESY_CLOSINGS.includes(sentence.text);
        expect(grounded || written, sentence.text).toBe(true);
      }
      expect(run.ticketId).toMatch(/^T-[0-9a-f]{8}$/);
      expect(body).not.toMatch(/@/);
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// Why a run stopped, which is a different question from which policy rule
// decided and is answered in a different vocabulary.
//
// `src/escalations/query.ts` reads the reason from the `escalate` step alone,
// and that statement serves both `pnpm run escalations` and the operator
// console's runs list. A seeded escalation that journals no such row reports
// a null reason to the person working the queue.
describe('why a seeded run escalated', () => {
  const plan = planHistory(OPTIONS);

  it('names a reason for every escalated run, and for no other run', () => {
    let escalated = 0;
    for (const run of plan) {
      if (run.state === 'escalated') {
        expect(run.escalation).not.toBeNull();
        escalated += 1;
      } else {
        expect(run.escalation).toBeNull();
      }
    }
    expect(escalated).toBeGreaterThan(0);
  });

  // Derived from what the run did, never drawn. A run that abstained at
  // compose cannot report a policy escalation, and a console rendering the
  // state beside the reason would show that contradiction on screen.
  it('names the reason the run\'s own path produces', () => {
    const seen = new Set<string>();
    for (const run of plan) {
      if (run.escalation === null) continue;
      seen.add(run.escalation);
      switch (run.escalation) {
        case 'composer_abstained':
          // DEC-07: an abstain is a correct output. It escalates before the
          // gate step starts, so the run carries no gate row at all.
          expect(run.abstained).toBe(true);
          expect(run.reason).toBeNull();
          expect(run.gate).toBeNull();
          break;
        case 'policy_escalated':
          // The engine's `escalate` verdict, and nothing else.
          expect(run.abstained).toBe(false);
          expect(run.gate!.decision).toBe('escalate');
          expect(evaluatePolicyDetailed(policyInputFor(run)!).decision).toBe('escalate');
          break;
        case 'relay_delivery_unknown':
          // DEC-30: the relay could not establish the delivery state, so it
          // escalated rather than retry blind. Only an automatic write
          // reaches the relay at all.
          expect(run.reason).toBe('auto');
          expect(run.gate!.decision).toBe('auto');
          expect(run.outbox).toEqual(['delivery_unknown']);
          break;
        default:
          throw new Error(`unplanned escalation reason ${run.escalation}`);
      }
    }
    expect([...seen].sort()).toEqual(
      ['composer_abstained', 'policy_escalated', 'relay_delivery_unknown'],
    );
  });

  // Two vocabularies, and the ledger holds both. A `PolicyReason` on an
  // escalate row would land the run in a column no reader recognises, and an
  // `EscalationReason` on a gate row would do the same to the control band.
  it('keeps the escalation vocabulary out of the gate vocabulary', () => {
    for (const run of plan) {
      if (run.escalation !== null) {
        expect(POLICY_REASONS).not.toContain(run.escalation);
      }
      if (run.reason !== null) {
        expect(['composer_abstained', 'policy_escalated', 'relay_delivery_unknown'])
          .not.toContain(run.reason);
      }
    }
  });
});

// The taxonomy the planner copies must be the taxonomy the system curates.
//
// The planner reads no file, because a history that changed when somebody
// edited a fixture is not reproducible from its seed. That copy is only safe
// while something proves it is still a copy.
describe('the seeded taxonomy', () => {
  it('matches the curated taxonomy entry for entry', () => {
    const curated = loadTaxonomy().intents.map((intent) => ({
      id: intent.id,
      riskTier: intent.risk_tier,
    }));
    expect(SEED_INTENTS).toEqual(curated);
  });
});

// The knowledge base a run retrieves from.
describe('the seeded documents', () => {
  it('declares every column db/002 requires, with a synthetic identifier', () => {
    for (const doc of SEED_DOCUMENTS) {
      expect(doc.docId).toMatch(/^SYN-DOC-\d\d$/);
      // DEC-22: the DDL CHECK refuses every other kind.
      expect(['document', 'canonical_resolution']).toContain(doc.kind);
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.body.length).toBeGreaterThan(0);
      // DEC-23: an owner answers for the content, and a review date bounds it.
      expect(doc.owner).toMatch(/^[a-z-]+$/);
      expect(doc.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(doc.body).not.toMatch(/@/);
    }
    expect(new Set(SEED_DOCUMENTS.map((d) => d.docId)).size).toBe(SEED_DOCUMENTS.length);
  });

  // The coordinator calls `hybridSearch` with no `includeStale`, so its query
  // filters on `review_by >= CURRENT_DATE`. A stale document could never
  // reach a run this seeder models, so a stale document in the corpus would
  // be an identifier no `retrieve` row can ever name.
  it('holds no document a coordinator run could not retrieve', () => {
    for (const doc of SEED_DOCUMENTS) {
      expect(Date.parse(`${doc.reviewBy}T00:00:00Z`)).toBeGreaterThan(Date.now());
    }
  });
});

// The approval-edit distance, on the scale the column declares.
describe('the approval-edit distance', () => {
  const plan = planHistory(OPTIONS);

  // db/003 stores a normalized token-level Levenshtein distance in [0, 1],
  // which is what `approvalEditDistance` returns. The seeder drew a median of
  // 24 and rounded it, which is a token count: `pnpm run bands` then reported
  // a mean near 24 for a metric whose worst possible value is 1, and no band
  // built from it could be compared with a live approval.
  it('stays inside the range the column declares', () => {
    const measured = plan.map((r) => r.editDistance).filter((d): d is number => d !== null);
    expect(measured.length).toBeGreaterThan(0);
    for (const distance of measured) {
      expect(distance).toBeGreaterThanOrEqual(0);
      expect(distance).toBeLessThanOrEqual(1);
    }
    // Most drafts survive nearly intact, and the tail is long because a
    // person who rewrites a draft rewrites most of it. Both halves are the
    // shape, not a wanted verdict.
    const sorted = [...measured].sort((a, b) => a - b);
    expect(quantile(sorted, 0.5)).toBeLessThan(0.15);
    expect(quantile(sorted, 0.95)).toBeGreaterThan(0.25);
  });

  // The correction had to keep the shape and move only the scale, so the two
  // draws stay the same two draws. A version of `logNormalUnit` that folded
  // them into one would leave every later value in the stream shifted, which
  // moves the reason and the abstain flag of every run after it.
  it('takes the same two draws the millisecond version takes', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    logNormal(a, 24, 1.1);
    logNormalUnit(b, 0.06, 1.1);
    for (let i = 0; i < 8; i += 1) expect(b()).toBe(a());
  });

  it('clamps to the range rather than escaping it', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 5_000; i += 1) {
      const value = logNormalUnit(rng, 0.9, 3);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

// Everything the control band publishes, pinned to the value it had before
// this journal detail existed.
//
// `pnpm run bands` reads the compose step's `abstained` and `provider` and
// the gate step's `reason`; `docs/v1-architecture.md` quotes a mean service
// time off the finish stamps. All of them come out of one shared draw
// sequence, so a draw inserted anywhere but the end moves every one of them —
// silently, and for a change that was only supposed to add detail.
//
// The digest is of the planner at commit d7d860e, the parent of this change,
// taken by running that planner against these options rather than by copying
// numbers out of a report. It covers, in order: run id, ticket id,
// conversation id, partition, service time, enqueue stamp, pickup stamp,
// finish stamp, state, abstain flag, gate reason and provider. Only
// `editDistance` is left out, because correcting its scale is the point.
//
// So this case is evidence about those twelve fields and not about the bands
// report, and the difference matters because a reader will reach for it as
// the second. Three of the four control-band metrics are covered here:
// `abstain_rate` through the abstain flag, `gate_pass_rate` through the gate
// reason, and `relay_delivery_unknown_count` through the state, which the
// unknown-delivery draw also sets. The fourth is `approval_edit_distance`,
// which this digest cannot see by construction. `stays inside the range the
// column declares` is what pins that one: a tenfold move in its mean passes
// the digest and fails that case.
describe('the history this change was not allowed to move', () => {
  it('reproduces the planner it replaced, field for field', () => {
    const plan = planHistory(OPTIONS);
    const line = (r: typeof plan[number]): string => [
      r.runId, r.ticketId, r.conversationId, r.partition, r.serviceMs,
      r.enqueuedAt.toISOString(), r.createdAt.toISOString(),
      r.finishedAt?.toISOString() ?? '',
      r.state, String(r.abstained), r.reason ?? '', r.provider,
    ].join('|');
    expect(plan).toHaveLength(2397);
    expect(createHash('sha256').update(plan.map(line).join('\n')).digest('hex'))
      .toBe('af82ca6822be986d22b694c51e24edb90a70c4aaef314bc4c208fa2201198fda');
  });
});
