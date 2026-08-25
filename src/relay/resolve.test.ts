// Unit suite for the section 4.4 failure-resolution matrix, pinned as a
// pure function (resolveSendFailure) so every cell is testable without
// Postgres. The database-level behaviour of each resolution lives in
// relay.db.test.ts.
import { describe, expect, it } from 'vitest';

import type { AdapterCapabilities, DeliveryState } from '../adapters/types.js';
import { resolveSendFailure } from './relay.js';

function caps(flags: {
  idempotency: boolean;
  readBack: boolean;
}): AdapterCapabilities {
  return Object.freeze({
    supportsIdempotencyKey: flags.idempotency,
    supportsReadBack: flags.readBack,
    supportsDraftState: false,
    supportsStructuredFields: false,
    supportsThreading: false,
  });
}

const DELIVERED: DeliveryState = { state: 'delivered', externalId: 'ext-1' };
const NOT_FOUND: DeliveryState = { state: 'not_found' };

describe('section 4.4 failure-resolution matrix', () => {
  it('keeps retrying an idempotency-honoring adapter whatever the delivery rule says', () => {
    // Row 1 of the table: supported -> at-least-once, retry. The key
    // dedupes repeats, so even at_most_once records may retry safely.
    const capsIdem = caps({ idempotency: true, readBack: false });
    expect(resolveSendFailure(capsIdem, 'at_least_once', null)).toEqual({
      action: 'leave_pending',
    });
    expect(resolveSendFailure(capsIdem, 'at_most_once', null)).toEqual({
      action: 'leave_pending',
    });
    expect(resolveSendFailure(capsIdem, 'at_least_once', NOT_FOUND)).toEqual({
      action: 'leave_pending',
    });
  });

  it('reconciles to sent whenever read-back proves delivery, whatever the other flags say', () => {
    // DEC-30: reconcile instead of escalate. Delivered is a result, so no
    // combination of the remaining flags changes this cell.
    const combos = [
      caps({ idempotency: true, readBack: true }),
      caps({ idempotency: false, readBack: true }),
    ];
    for (const c of combos) {
      expect(resolveSendFailure(c, 'at_least_once', DELIVERED)).toEqual({
        action: 'mark_sent',
        reconciled: true,
      });
      expect(resolveSendFailure(c, 'at_most_once', DELIVERED)).toEqual({
        action: 'mark_sent',
        reconciled: true,
      });
    }
  });

  it('escalates on an unknown state without idempotency support and never retries', () => {
    // DEC-30 / AGENTS.md: unknown means delivery_unknown and escalate.
    // Neither delivery rule licenses a blind retry (DEC-29: rule from the
    // record; DEC-30: escalation beats both failure modes).
    const capsBare = caps({ idempotency: false, readBack: false });
    expect(resolveSendFailure(capsBare, 'at_most_once', null)).toEqual({
      action: 'escalate',
    });
    expect(resolveSendFailure(capsBare, 'at_least_once', null)).toEqual({
      action: 'escalate',
    });
  });

  it('splits the not_found cell on the record delivery rule: loss-costs-more retries, duplicate-costs-more escalates', () => {
    // Row 2 of the table, once read-back makes the state known:
    // nothing was delivered, so at_least_once may retry — but at_most_once
    // forbids a second attempt under any circumstance.
    const capsReadBackOnly = caps({ idempotency: false, readBack: true });
    expect(resolveSendFailure(capsReadBackOnly, 'at_least_once', NOT_FOUND)).toEqual({
      action: 'leave_pending',
    });
    expect(resolveSendFailure(capsReadBackOnly, 'at_most_once', NOT_FOUND)).toEqual({
      action: 'escalate',
    });
  });
});
