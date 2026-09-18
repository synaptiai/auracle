// Which group a waiting case belongs to, and in what order (issue #101).
//
// The maintainer's rulings, 2026-09-14:
// - First: the gate rule is `irreversible` or `high_risk`, the gate recorded
//   the intent's risk tier as high, or the run parked a compensation.
//   Delivery alone does not promote a case.
// - Both gates clean: agreement at or above its own line, and coverage at or
//   above the review line, each compared on its own (DEC-05). A value or a
//   line that was not recorded is not clean.
// - Everything else waits in a third group.
import { COMPENSATION_ACTION_CLASS } from 'auracle/domain';
import { describe, expect, it } from 'vitest';

import { groupQueue, queueGroupOf } from './queue.js';
import type { Groupable } from './queue.js';

const CLEAN = {
  gateReason: 'customer_visible',
  riskTier: 'medium',
  actionClass: 'customer_reply',
  agreement: 0.91,
  agreementThreshold: 0.8,
  gateCoverage: 0.86,
  coverageReviewThreshold: 0.8,
} as const;

describe('the group a waiting case belongs to', () => {
  it('puts an irreversible or high-risk rule first', () => {
    expect(queueGroupOf({ ...CLEAN, gateReason: 'irreversible' })).toBe('first');
    expect(queueGroupOf({ ...CLEAN, gateReason: 'high_risk' })).toBe('first');
  });

  // A compensation gates as `no_idempotency` on an adapter that declares no
  // key, before the irreversible rule is read. It still cannot be undone.
  it('puts a compensation first whatever rule stopped it', () => {
    expect(queueGroupOf({ ...CLEAN, gateReason: 'no_idempotency', actionClass: COMPENSATION_ACTION_CLASS })).toBe('first');
  });

  // At-most-once is the default delivery for every action, so it would
  // promote the whole queue. The guard is that grouping cannot read it: a
  // waiting run with a delivery field is not a shape the rule accepts, and
  // the compiler refuses this line if `Groupable` ever gains one.
  it('reads no delivery rule', () => {
    // @ts-expect-error -- delivery is not a field the grouping reads.
    const withDelivery: Groupable = { ...CLEAN, delivery: 'at_most_once' };
    expect(queueGroupOf(withDelivery)).toBe('clean');
  });

  // A customer reply is gated before the high-risk rule is read, so its rule
  // never says high risk. The tier the gate recorded does (DEC-13).
  it('puts a case first when the gate recorded its intent as high risk', () => {
    expect(queueGroupOf({ ...CLEAN, riskTier: 'high' })).toBe('first');
    expect(queueGroupOf({ ...CLEAN, riskTier: 'low' })).toBe('clean');
    expect(queueGroupOf({ ...CLEAN, riskTier: null })).toBe('clean');
  });

  // Clean says another rule sent the case to a person. A run whose rule the
  // ledger never recorded, or recorded outside the engine's vocabulary, cannot
  // say that, and may have been stopped as high risk.
  it('does not call a case clean when its rule is missing or unknown', () => {
    expect(queueGroupOf({ ...CLEAN, gateReason: null })).toBe('rest');
    expect(queueGroupOf({ ...CLEAN, gateReason: 'a_rule_nobody_wrote' })).toBe('rest');
  });

  it('calls a case clean when each value clears its own line', () => {
    expect(queueGroupOf(CLEAN)).toBe('clean');
    // Exactly on the line clears it.
    expect(queueGroupOf({ ...CLEAN, agreement: 0.8, gateCoverage: 0.8 })).toBe('clean');
  });

  // The two gates are never blended. A high agreement cannot carry a low
  // coverage, and the mean of 0.99 and 0.7 (0.845) would clear both lines.
  it('does not let one strong gate carry a weak one', () => {
    expect(queueGroupOf({ ...CLEAN, agreement: 0.99, gateCoverage: 0.7 })).toBe('rest');
    expect(queueGroupOf({ ...CLEAN, agreement: 0.7, gateCoverage: 0.99 })).toBe('rest');
  });

  // Both gates are fractions. A hand-written 1.4 is carried as recorded, and
  // it clears no line.
  it('does not call a case clean on a value outside [0, 1]', () => {
    expect(queueGroupOf({ ...CLEAN, agreement: 1.4 })).toBe('rest');
    expect(queueGroupOf({ ...CLEAN, gateCoverage: 1.5 })).toBe('rest');
    expect(queueGroupOf({ ...CLEAN, agreement: 1, gateCoverage: 1 })).toBe('clean');
  });

  it('does not call a case clean when a value or its line was not recorded', () => {
    expect(queueGroupOf({ ...CLEAN, agreement: null })).toBe('rest');
    expect(queueGroupOf({ ...CLEAN, agreementThreshold: null })).toBe('rest');
    expect(queueGroupOf({ ...CLEAN, gateCoverage: null })).toBe('rest');
    expect(queueGroupOf({ ...CLEAN, coverageReviewThreshold: null })).toBe('rest');
  });

  // Risk outranks clean: an irreversible case with clean gates is still work
  // to do first.
  it('keeps a risky case first even when both gates are clean', () => {
    expect(queueGroupOf({ ...CLEAN, gateReason: 'high_risk' })).toBe('first');
  });
});

describe('the queue in groups', () => {
  const at = (iso: string): Date => new Date(iso);
  const run = (runId: string, over: Record<string, unknown>) => ({ runId, ...CLEAN, createdAt: at('2026-09-14T10:00:00Z'), ...over });

  it('orders the groups first, clean, rest, and each oldest first', () => {
    const groups = groupQueue([
      run('rest-new', { gateCoverage: 0.5, createdAt: at('2026-09-14T12:00:00Z') }),
      run('clean-new', { createdAt: at('2026-09-14T11:00:00Z') }),
      run('first-new', { gateReason: 'irreversible', createdAt: at('2026-09-14T09:30:00Z') }),
      run('clean-old', { createdAt: at('2026-09-14T08:00:00Z') }),
      run('first-old', { gateReason: 'high_risk', createdAt: at('2026-09-14T07:00:00Z') }),
      run('rest-undated', { gateCoverage: 0.5, createdAt: null }),
      run('rest-old', { gateCoverage: 0.5, createdAt: at('2026-09-14T06:00:00Z') }),
    ]);
    expect(groups.map((g) => [g.group, g.runs.map((r) => r.runId)])).toEqual([
      ['first', ['first-old', 'first-new']],
      ['clean', ['clean-old', 'clean-new']],
      // A case with no recorded time sorts last, not first.
      ['rest', ['rest-old', 'rest-new', 'rest-undated']],
    ]);
  });

  // An unreadable time is no more a date than a missing one, so it sorts with
  // the undated rather than throwing or scattering the order.
  it('sorts a case whose time is unreadable after every dated one', () => {
    const groups = groupQueue([
      run('infinite', { createdAt: Number.POSITIVE_INFINITY as unknown as Date }),
      run('missing', { createdAt: null }),
      run('invalid', { createdAt: new Date(Number.NaN) }),
      run('new', { createdAt: at('2026-09-14T11:00:00Z') }),
      run('old', { createdAt: at('2026-09-14T08:00:00Z') }),
    ]);
    // A missing time and an unreadable one rank alike, in the order they came.
    expect(groups[0]!.runs.map((r) => r.runId)).toEqual(['old', 'new', 'infinite', 'missing', 'invalid']);
  });

  it('leaves out a group with nothing in it', () => {
    const groups = groupQueue([run('only', {})]);
    expect(groups.map((g) => g.group)).toEqual(['clean']);
  });

  // Criterion 4 (DEC-46). A case somebody else holds is not work this
  // reviewer can start, so it leaves the group its gate facts put it in for
  // the last one. It returns when the hold lapses or is released.
  it('puts a case somebody else holds in its own group, after every other', () => {
    const groups = groupQueue(
      [
        run('free-first', { gateReason: 'high_risk', createdAt: at('2026-09-14T07:00:00Z') }),
        run('held-clean', { createdAt: at('2026-09-14T08:00:00Z') }),
        run('held-risky', { gateReason: 'irreversible', createdAt: at('2026-09-14T09:00:00Z') }),
        run('free-rest', { gateCoverage: 0.5, createdAt: at('2026-09-14T10:00:00Z') }),
      ],
      (held) => held.runId.startsWith('held-'),
    );
    expect(groups.map((g) => [g.group, g.runs.map((r) => r.runId)])).toEqual([
      ['first', ['free-first']],
      ['rest', ['free-rest']],
      // Oldest first here too, and a risky case is no different: the hold is
      // what this group is about.
      ['held', ['held-clean', 'held-risky']],
    ]);
  });

  // The predicate is what marks a case held. A caller that names none groups
  // by the gate facts alone, which is what every caller did before this
  // group existed.
  it('groups by the gate facts when no hold is named', () => {
    const runs = [
      run('risky', { gateReason: 'irreversible' }),
      run('said', {}),
    ];
    expect(groupQueue(runs).map((g) => [g.group, g.runs.map((r) => r.runId)]))
      .toEqual([['first', ['risky']], ['clean', ['said']]]);
  });
});
