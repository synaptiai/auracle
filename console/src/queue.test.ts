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

import { groupQueue, queueGroupOf, workOrder } from './queue.js';
import type { Groupable } from './queue.js';

const CLEAN = {
  gateReason: 'customer_visible',
  riskTier: 'medium',
  actionClass: 'customer_reply',
  agreement: 0.91,
  agreementThreshold: 0.8,
  gateCoverage: 0.86,
  coverageReviewThreshold: 0.8,
  draftExternalId: 'hd-draft-0001',
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

  // #123: the one-press batch holds each reply for an undo (DEC-51), and an
  // internal write parks no reply and takes no hold (DEC-34). So a parked
  // write never joins the group the batch confirms, however clean its gates.
  it('never calls an internal write clean, however its gates read', () => {
    expect(queueGroupOf({ ...CLEAN, actionClass: 'route_ticket', draftExternalId: null })).toBe('rest');
    expect(queueGroupOf({ ...CLEAN, draftExternalId: null })).toBe('rest');
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
});

describe('the queue in groups', () => {
  const at = (iso: string): Date => new Date(iso);

  /**
   * One waiting run, as this suite builds them.
   *
   * Declared rather than inferred, so a predicate over a row is one type
   * and applies to every case here. The fields are the ones the grouping
   * reads, plus the product it orders by (DEC-47).
   */
  interface QueueRun {
    readonly runId: string;
    readonly product: string | null;
    readonly createdAt: Date | null;
    readonly gateReason: string;
    readonly riskTier: string | null;
    readonly actionClass: string;
    readonly agreement: number | null;
    readonly agreementThreshold: number | null;
    readonly gateCoverage: number | null;
    readonly coverageReviewThreshold: number | null;
    readonly draftExternalId: string | null;
  }
  const run = (runId: string, over: Partial<QueueRun> = {}): QueueRun => ({
    ...CLEAN, runId, product: null, createdAt: at('2026-09-14T10:00:00Z'), ...over,
  });

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

  // DEC-47: the reader's own products come first inside each group. It is an
  // order and not a filter: every case is still on the page, and the groups
  // themselves do not move — a case the reader covers and that a hold puts
  // in the last group stays in the last group.
  it('sorts the reader\'s own products first, inside the group', () => {
    const runs = [
      run('clean-ledger', { product: 'ledger', createdAt: at('2026-09-14T12:00:00Z') }),
      run('clean-aurora', { product: 'aurora', createdAt: at('2026-09-14T08:00:00Z') }),
      run('clean-nobody', { product: null, createdAt: at('2026-09-14T07:00:00Z') }),
      run('risky-aurora', { gateReason: 'irreversible', product: 'aurora', createdAt: at('2026-09-14T06:00:00Z') }),
    ];
    const mine = (r: QueueRun): boolean => r.product === 'ledger';
    const groups = groupQueue(runs, undefined, mine);

    expect(groups.map((g) => [g.group, g.runs.map((r) => r.runId)])).toEqual([
      // The risky case is aurora, which this reader does not cover, so it
      // keeps its own order — the preference reorders a group, never the
      // groups. And the covered case leads its group though it is newest.
      ['first', ['risky-aurora']],
      // Then age, inside the half the reader does not cover: 07:00 then
      // 08:00. The preference moves a case to the front of its group; it
      // does not lift one case above another the reader covers.
      ['clean', ['clean-ledger', 'clean-nobody', 'clean-aurora']],
    ]);

    // Age still decides inside each half: two covered cases keep their order.
    const two = groupQueue(
      [
        run('older-covered', { product: 'ledger', createdAt: at('2026-09-14T08:00:00Z') }),
        run('newer-covered', { product: 'ledger', createdAt: at('2026-09-14T12:00:00Z') }),
      ],
      undefined,
      mine,
    );
    expect(two[0]!.runs.map((r) => r.runId)).toEqual(['older-covered', 'newer-covered']);
  });

  // A reader who declares no products sees the queue exactly as it was. The
  // predicate is the caller's, so this is also what every caller before
  // DEC-47 gets.
  it('orders by age alone when the reader covers nothing', () => {
    const runs = [
      run('new', { product: 'aurora', createdAt: at('2026-09-14T12:00:00Z') }),
      run('old', { product: 'ledger', createdAt: at('2026-09-14T08:00:00Z') }),
    ];
    expect(groupQueue(runs, undefined, () => false)[0]!.runs.map((r) => r.runId))
      .toEqual(['old', 'new']);
    expect(groupQueue(runs)[0]!.runs.map((r) => r.runId)).toEqual(['old', 'new']);
  });

  // Issue #154: the sort a reviewer picks. Its failures, written first:
  //   - oldest reorders inside each group only, so it draws as risk first;
  //   - oldest or my products lists a case somebody else holds as work;
  //   - my products drops age inside each half;
  //   - the work order takes a held case, or loses the order the page drew.
  describe('the sort a reviewer picks', () => {
    const queue = [
      run('rest-old', { gateCoverage: 0.5, product: 'ledger', createdAt: at('2026-09-14T06:00:00Z') }),
      run('risk-new', { gateReason: 'irreversible', product: 'aurora', createdAt: at('2026-09-14T11:00:00Z') }),
      run('clean-mid', { product: 'aurora', createdAt: at('2026-09-14T09:00:00Z') }),
      run('held-oldest', { gateReason: 'high_risk', product: 'aurora', createdAt: at('2026-09-14T05:00:00Z') }),
      run('rest-newest', { gateCoverage: 0.5, product: 'aurora', createdAt: at('2026-09-14T12:00:00Z') }),
    ];
    const held = (r: QueueRun): boolean => r.runId.startsWith('held-');
    const mine = (r: QueueRun): boolean => r.product === 'aurora';
    const shape = (sort: 'risk' | 'oldest' | 'mine') => groupQueue(queue, held, mine, sort)
      .map((g) => [g.group, g.runs.map((r) => r.runId)]);

    it('keeps the groups under risk first, as the queue has always drawn', () => {
      expect(shape('risk')).toEqual([
        ['first', ['risk-new']],
        ['clean', ['clean-mid']],
        // The reader covers aurora, so the newest aurora case leads its group.
        ['rest', ['rest-newest', 'rest-old']],
        ['held', ['held-oldest']],
      ]);
    });

    // The rest case from 06:00 is older than the risk case from 11:00. Risk
    // first puts the risk case ahead; oldest must not.
    it('lists every case nobody else holds oldest first, then the held ones', () => {
      expect(shape('oldest')).toEqual([
        ['waiting', ['rest-old', 'clean-mid', 'risk-new', 'rest-newest']],
        ['held', ['held-oldest']],
      ]);
    });

    it('lists the reader\'s products first and then the rest, each oldest first', () => {
      expect(shape('mine')).toEqual([
        ['waiting', ['clean-mid', 'risk-new', 'rest-newest', 'rest-old']],
        ['held', ['held-oldest']],
      ]);
    });

    it('orders the held group by age under every sort', () => {
      const two = [
        run('held-new', { createdAt: at('2026-09-14T09:00:00Z') }),
        run('held-old', { createdAt: at('2026-09-14T04:00:00Z') }),
      ];
      for (const sort of ['risk', 'oldest', 'mine'] as const) {
        const held = groupQueue(two, () => true, mine, sort).find((g) => g.group === 'held')!;
        expect(held.runs.map((r) => r.runId), sort).toEqual(['held-old', 'held-new']);
      }
    });

    it('works through the cases in the order the page drew them, and never a held one', () => {
      expect(workOrder(groupQueue(queue, held, mine, 'risk')).map((r) => r.runId))
        .toEqual(['risk-new', 'clean-mid', 'rest-newest', 'rest-old']);
      expect(workOrder(groupQueue(queue, held, mine, 'oldest')).map((r) => r.runId))
        .toEqual(['rest-old', 'clean-mid', 'risk-new', 'rest-newest']);
    });
  });
});
