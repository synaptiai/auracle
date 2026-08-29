// Unit tests for the intake wiring (D3-A). The adapter half is pure; the
// enqueuer is checked against a stub pool so no database is needed here.
// Partition routing itself is covered by the coordinator suites and the
// webhook integration test.
import { describe, expect, it } from 'vitest';

import type { NormalizedEvent } from '../adapters/types.js';

import { intakeEnqueuer, toIntakeTicket } from './adapter.js';

function event(overrides?: {
  ticketSubject?: string;
  messageSubject?: string | null;
  bodyText?: string;
  ticketId?: string;
}): NormalizedEvent {
  return {
    sourceId: 'src-1',
    linkage: null,
    ticket: {
      ticketId: overrides?.ticketId ?? 't-1',
      subject: overrides?.ticketSubject ?? 'Order damaged',
      queue: null,
      status: 'open',
      customerAddress: 'dana.doe@example.test',
    },
    message: {
      messageId: 'm-1',
      inReplyTo: null,
      references: [],
      author: 'customer',
      fromAddress: 'dana.doe@example.test',
      toAddresses: [],
      ccAddresses: [],
      subject: overrides?.messageSubject === undefined ? 'Order damaged' : overrides.messageSubject,
      sentAt: '2025-01-01T00:00:00Z',
      bodyText: overrides?.bodyText ?? 'The box arrived crushed.',
      attachments: [],
    },
  };
}

describe('toIntakeTicket', () => {
  it('joins subject and bodyText with a blank line', () => {
    expect(toIntakeTicket(event())).toEqual({
      ticketId: 't-1',
      // The source's own message identity keys the queue row (DEC-24).
      messageId: 'm-1',
      linkage: null,
      // DEC-35: the sender the conversation check reads.
      customerAddress: 'dana.doe@example.test',
      ticketText: 'Order damaged\n\nThe box arrived crushed.',
    });
  });

  it('derives a content identity when the source names no message', () => {
    const base = event();
    const withoutId = { ...base, message: { ...base.message, messageId: null } };

    const derived = toIntakeTicket(withoutId).messageId;

    expect(derived).toMatch(/^no-id-[0-9a-f]{32}$/);
    // Never the delivery id. That used to stand in, and DEC-38 made it
    // unsafe: a redelivery under a new UID would take a fresh turn, derive a
    // different key, and the action would run a second time.
    expect(derived).not.toBe('src-1');
  });

  it('keeps that identity stable when only the delivery id changes (DEC-38)', () => {
    const base = event();
    const withoutId = { ...base, message: { ...base.message, messageId: null } };
    const redelivered = { ...withoutId, sourceId: 'src-2-after-uidvalidity-change' };

    expect(toIntakeTicket(redelivered).messageId).toBe(toIntakeTicket(withoutId).messageId);
  });

  it('separates two different messages that both name no message id', () => {
    const base = event();
    const first = { ...base, message: { ...base.message, messageId: null } };
    const second = {
      ...base,
      message: { ...base.message, messageId: null, bodyText: 'A different problem.' },
    };

    expect(toIntakeTicket(second).messageId).not.toBe(toIntakeTicket(first).messageId);
  });

  it('prefers the message subject over the ticket subject', () => {
    const result = toIntakeTicket(event({ messageSubject: 'Re: Order damaged' }));
    expect(result.ticketText).toBe('Re: Order damaged\n\nThe box arrived crushed.');
  });

  it('falls back to the ticket subject when the message has none', () => {
    const result = toIntakeTicket(event({ messageSubject: null }));
    expect(result.ticketText).toBe('Order damaged\n\nThe box arrived crushed.');
  });

  it('emits only the body when both subjects are empty', () => {
    const result = toIntakeTicket(event({ ticketSubject: '', messageSubject: '' }));
    expect(result.ticketText).toBe('The box arrived crushed.');
  });

  it('keeps the ticket id unchanged', () => {
    expect(toIntakeTicket(event({ ticketId: 't-42' })).ticketId).toBe('t-42');
  });
});

describe('intakeEnqueuer', () => {
  // The enqueue runs in one transaction (DEC-35), so a pool stub has to hand
  // out a client. What lands in the table is covered against a real database
  // in src/intake/webhook.db.test.ts; this file owns the seam's contract.
  function stubPool(connect?: () => Promise<never>) {
    return {
      connect: connect ?? (async () => ({
        query: async () => ({ rows: [], rowCount: 1 }),
        release: () => {},
      })),
    };
  }

  it('rejects when the enqueue rejects, so the driver answers 500', async () => {
    const pool = stubPool(async () => {
      throw new Error('intake down');
    });

    await expect(intakeEnqueuer(pool as never, 8)(event())).rejects.toThrow('intake down');
  });
});
