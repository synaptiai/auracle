// Unit tests for the intake wiring (D3-A). The adapter half is pure; the
// enqueuer is checked against a stub pool so no database is needed here.
// Partition routing itself is covered by the coordinator suites and the
// webhook integration test.
import { describe, expect, it, vi } from 'vitest';
import type { QueryResult } from 'pg';

import type { NormalizedEvent } from '../adapters/types.js';
import { partitionOf } from '../coordinator/coordinator.js';

import { intakeEnqueuer, toIntakeTicket } from './adapter.js';

function event(overrides?: {
  ticketSubject?: string;
  messageSubject?: string | null;
  bodyText?: string;
  ticketId?: string;
}): NormalizedEvent {
  return {
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
      ticketText: 'Order damaged\n\nThe box arrived crushed.',
    });
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
  function stubPool() {
    const query = vi.fn(
      async (): Promise<QueryResult> =>
        ({ rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] }) as QueryResult,
    );
    return { query };
  }

  it('inserts the adapted ticket with its DEC-27 partition', async () => {
    const pool = stubPool();
    await intakeEnqueuer(pool as never, 8)(event({ ticketId: 'wh-ticket-4471' }));

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO intake');
    expect(params).toEqual([
      'wh-ticket-4471',
      partitionOf('wh-ticket-4471', 8),
      'Order damaged\n\nThe box arrived crushed.',
    ]);
  });

  it('rejects when the insert rejects, so the driver answers 500', async () => {
    const pool = stubPool();
    pool.query.mockRejectedValueOnce(new Error('intake down'));

    await expect(intakeEnqueuer(pool as never, 8)(event())).rejects.toThrow('intake down');
  });
});
