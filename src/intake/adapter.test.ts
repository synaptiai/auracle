// Unit tests for the intake wiring (D3-A). The adapter half is pure; the
// enqueuer is checked against a stub pool so no database is needed here.
// Partition routing itself is covered by the coordinator suites and the
// webhook integration test.
import { describe, expect, it } from 'vitest';

import type { NormalizedEvent } from '../adapters/types.js';
import { parseProducts } from '../config/products.js';

import { intakeEnqueuer, toIntakeTicket } from './adapter.js';

/**
 * The catalogue these cases map through (DEC-47). Two products, and a
 * channel that serves neither, which is what tells a mapped channel from an
 * unmapped one.
 */
const CATALOGUE = parseProducts({
  products: [
    { id: 'aurora', label: 'Aurora' },
    { id: 'ledger', label: 'Ledger' },
  ],
  channels: { shipping: 'aurora', billing: 'ledger' },
});

function event(overrides?: {
  ticketSubject?: string;
  messageSubject?: string | null;
  bodyText?: string;
  ticketId?: string;
  /** The source's queue field, which DEC-47 reads as the channel. */
  queue?: string | null;
}): NormalizedEvent {
  return {
    sourceId: 'src-1',
    linkage: null,
    ticket: {
      ticketId: overrides?.ticketId ?? 't-1',
      subject: overrides?.ticketSubject ?? 'Order damaged',
      queue: overrides?.queue ?? null,
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
    expect(toIntakeTicket(event(), CATALOGUE)).toEqual({
      ticketId: 't-1',
      // The source's own message identity keys the queue row (DEC-24).
      messageId: 'm-1',
      linkage: null,
      // DEC-35: the sender the conversation check reads.
      customerAddress: 'dana.doe@example.test',
      ticketText: 'Order damaged\n\nThe box arrived crushed.',
      // DEC-47: this event names no channel, so no product is mapped.
      product: null,
    });
  });

  // DEC-47: "each run records the product of the channel its message arrived
  // on". The channel is what the source reported on the ticket, mapped
  // through the catalogue, and the row carries the product id.
  it('maps the channel the source reported to the product that serves it', () => {
    const result = toIntakeTicket(event({ queue: 'shipping' }), CATALOGUE);
    expect(result.product).toBe('aurora');
  });

  it('maps each channel to its own product', () => {
    expect(toIntakeTicket(event({ queue: 'billing' }), CATALOGUE).product).toBe('ledger');
  });

  // Null, never an empty string: a product named `''` is a product the
  // retrieval filter would look for, and no document declares it.
  it('records no product for a channel the catalogue does not name', () => {
    expect(toIntakeTicket(event({ queue: 'returns' }), CATALOGUE).product).toBeNull();
  });

  it('records no product when the source named no channel', () => {
    expect(toIntakeTicket(event({ queue: null }), CATALOGUE).product).toBeNull();
  });

  it('derives a content identity when the source names no message', () => {
    const base = event();
    const withoutId = { ...base, message: { ...base.message, messageId: null } };

    const derived = toIntakeTicket(withoutId, CATALOGUE).messageId;

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

    expect(toIntakeTicket(redelivered, CATALOGUE).messageId)
      .toBe(toIntakeTicket(withoutId, CATALOGUE).messageId);
  });

  it('separates two different messages that both name no message id', () => {
    const base = event();
    const first = { ...base, message: { ...base.message, messageId: null } };
    const second = {
      ...base,
      message: { ...base.message, messageId: null, bodyText: 'A different problem.' },
    };

    expect(toIntakeTicket(second, CATALOGUE).messageId)
      .not.toBe(toIntakeTicket(first, CATALOGUE).messageId);
  });

  it('prefers the message subject over the ticket subject', () => {
    const result = toIntakeTicket(event({ messageSubject: 'Re: Order damaged' }), CATALOGUE);
    expect(result.ticketText).toBe('Re: Order damaged\n\nThe box arrived crushed.');
  });

  it('falls back to the ticket subject when the message has none', () => {
    const result = toIntakeTicket(event({ messageSubject: null }), CATALOGUE);
    expect(result.ticketText).toBe('Order damaged\n\nThe box arrived crushed.');
  });

  it('emits only the body when both subjects are empty', () => {
    const result = toIntakeTicket(event({ ticketSubject: '', messageSubject: '' }), CATALOGUE);
    expect(result.ticketText).toBe('The box arrived crushed.');
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

    await expect(intakeEnqueuer(pool as never, 8, CATALOGUE)(event())).rejects.toThrow('intake down');
  });
});
