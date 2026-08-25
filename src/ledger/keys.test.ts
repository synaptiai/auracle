import { describe, expect, it } from 'vitest';

import { deriveIdemKey } from './keys.js';

describe('deriveIdemKey (DEC-24, section 3.4)', () => {
  it('gives the same key for the same action twice, regardless of run identity', () => {
    // The function takes no run_id or timestamp; calling it from two distinct
    // runs with identical semantics must produce one key.
    const first = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 5000, currency: 'USD' },
    });
    const second = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 5000, currency: 'USD' },
    });
    expect(first).toBe(second);
  });

  it('gives different keys for a refund of 50 and a refund of 100', () => {
    const refund50 = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 5000 },
    });
    const refund100 = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 10000 },
    });
    expect(refund50).not.toBe(refund100);
  });

  it('is independent of payload key order', () => {
    const a = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 5000, currency: 'USD' },
    });
    const b = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { currency: 'USD', amount_cents: 5000 },
    });
    expect(a).toBe(b);
  });

  it('separates actions by action class', () => {
    const refund = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 5000 },
    });
    const close = deriveIdemKey({
      actionClass: 'close_ticket',
      ticketId: 'T-1',
      payload: { amount_cents: 5000 },
    });
    expect(refund).not.toBe(close);
  });

  it('separates actions by ticket id', () => {
    const t1 = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 5000 },
    });
    const t2 = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-2',
      payload: { amount_cents: 5000 },
    });
    expect(t1).not.toBe(t2);
  });

  it('treats array order as semantic', () => {
    const a = deriveIdemKey({
      actionClass: 'merge_tickets',
      ticketId: 'T-1',
      payload: { sources: ['A', 'B'] },
    });
    const b = deriveIdemKey({
      actionClass: 'merge_tickets',
      ticketId: 'T-1',
      payload: { sources: ['B', 'A'] },
    });
    expect(a).not.toBe(b);
  });

  it('throws when the payload carries run identity (DEC-24 assertion)', () => {
    expect(() =>
      deriveIdemKey({
        actionClass: 'refund',
        ticketId: 'T-1',
        payload: { amount_cents: 5000, run_id: 'some-run' },
      }),
    ).toThrow(/run-identity/);
    expect(() =>
      deriveIdemKey({
        actionClass: 'refund',
        ticketId: 'T-1',
        payload: { nested: { timestamp: Date.now() } },
      }),
    ).toThrow(/run-identity/);
  });

  it('produces keys usable as outbox idem_key text values', () => {
    const key = deriveIdemKey({
      actionClass: 'refund',
      ticketId: 'T-1',
      payload: { amount_cents: 5000 },
    });
    expect(key).toMatch(/^refund:T-1:[0-9a-f]{64}$/);
  });
});
