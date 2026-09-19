import { describe, expect, it } from 'vitest';
import { ImapSmtpAdapter } from './imap-smtp.js';
import { WebhookAdapter } from './webhook.js';
import type { IngressAdapter } from './types.js';

const adapter = new WebhookAdapter();

function baseEvent(): Record<string, unknown> {
  return {
    eventId: 'evt-1',
    ticket: { id: 't-100', subject: 'Refund', queue: 'billing', status: 'open' },
    message: {
      id: 'm-1',
      author: 'customer',
      from: 'dana.doe@example.test',
      body: 'I need a refund.',
      createdAt: '2025-01-01T12:00:00Z',
    },
  };
}

function normalize(rawEvent: unknown) {
  return adapter.normalize({ sourceId: 'wh-evt-1', raw: rawEvent });
}

describe('one port, many adapters (section 4.1)', () => {
  it('holds every reference adapter in one IngressAdapter[]', () => {
    const adapters: IngressAdapter[] = [new ImapSmtpAdapter(), new WebhookAdapter()];
    expect(adapters.map((entry) => entry.name)).toEqual(['imap-smtp', 'webhook']);
    for (const entry of adapters) {
      expect(Object.keys(entry.capabilities).sort()).toEqual([
        'supportsDraftState',
        'supportsIdempotencyKey',
        'supportsLedgerReply',
        'supportsReadBack',
        'supportsStructuredFields',
        'supportsThreading',
      ]);
    }
  });
});

describe('WebhookAdapter capabilities', () => {
  it('declares no guarantee a bare webhook does not give (DEC-06)', () => {
    expect(adapter.capabilities).toEqual({
      supportsIdempotencyKey: false,
      supportsReadBack: false,
      supportsDraftState: false,
      supportsStructuredFields: false,
      supportsThreading: false,
      supportsLedgerReply: false,
    });
  });

  it('freezes the declaration so callers cannot widen autonomy', () => {
    expect(() => {
      (adapter.capabilities as Record<string, unknown>).supportsIdempotencyKey = true;
    }).toThrow();
    expect(adapter.capabilities.supportsIdempotencyKey).toBe(false);
  });
});

describe('WebhookAdapter.normalize', () => {
  it('changes an inbound event into a Ticket and a Message', () => {
    const result = normalize(baseEvent());

    expect(result.ticket).toEqual({
      ticketId: 't-100',
      subject: 'Refund',
      queue: 'billing',
      status: 'open',
      customerAddress: 'dana.doe@example.test',
    });
    expect(result.message).toEqual({
      messageId: 'm-1',
      inReplyTo: null,
      references: [],
      author: 'customer',
      fromAddress: 'dana.doe@example.test',
      toAddresses: [],
      ccAddresses: [],
      subject: 'Refund',
      sentAt: '2025-01-01T12:00:00Z',
      bodyText: 'I need a refund.',
      attachments: [],
    });
    expect(result.eventId).toBe('evt-1');
  });

  it('normalizes a JSON text payload and an event with only required fields', () => {
    const result = adapter.normalize({
      sourceId: 'wh-2',
      raw: JSON.stringify({
        ticket: { id: 't-200', status: 'closed' },
        message: {
          id: 'm-2',
          author: 'system',
          body: 'Closed.',
          createdAt: '2025-01-02T00:00:00Z',
        },
      }),
    });

    expect(result.ticket).toEqual({
      ticketId: 't-200',
      subject: '',
      queue: null,
      status: 'closed',
      customerAddress: null,
    });
    expect(result.message.messageId).toBe('m-2');
    expect(result.eventId).toBeUndefined();
  });

  it.each([
    ['payload is not an object', null],
    ['ticket is missing', { message: {} }],
    ['ticket.id is empty', { ticket: { id: '', status: 'open' }, message: {} }],
    ['ticket.status is unknown', { ticket: { id: 't', status: 'done' }, message: {} }],
    [
      'message.createdAt is not ISO 8601',
      {
        ticket: { id: 't', status: 'open' },
        message: { id: 'm', author: 'customer', body: 'x', createdAt: 'yesterday' },
      },
    ],
    [
      'message.author is unknown',
      {
        ticket: { id: 't', status: 'open' },
        message: { id: 'm', author: 'robot', body: 'x', createdAt: '2025-01-01T12:00:00Z' },
      },
    ],
    ['raw text is not valid JSON', '{not json'],
  ])('throws on malformed input: %s', (_label, rawEvent) => {
    expect(() =>
      adapter.normalize({ sourceId: 'wh-x', raw: rawEvent }),
    ).toThrow(TypeError);
  });
});

describe('conversation linkage (DEC-35)', () => {
  it('offers no linkage, because the contract carries no reply chain', () => {
    const result = normalize(baseEvent());

    // The adapter declares supportsThreading false, so autonomy matches the
    // capability it really has (DEC-06). The ticket id still groups a thread.
    expect(adapter.capabilities.supportsThreading).toBe(false);
    expect(result.linkage).toBeNull();
    expect(result.sourceId).toBe('wh-evt-1');
  });
});
