import { describe, expect, it, vi } from 'vitest';

import { ImapSmtpAdapter, deriveTicketId } from '../adapters/imap-smtp.js';
import type { NormalizedEvent } from '../adapters/types.js';
import {
  NO_IDS_EMAIL,
  QUOTED_PRINTABLE_EMAIL,
  SIMPLE_TEXT_EMAIL,
} from '../adapters/fixtures.js';
import { ImapPoller } from './imap-poller.js';

const adapter = new ImapSmtpAdapter();

function collector(): { received: NormalizedEvent[]; onEvent: (event: NormalizedEvent) => Promise<void> } {
  const received: NormalizedEvent[] = [];
  return {
    received,
    onEvent: async (event) => {
      received.push(event);
    },
  };
}

describe('imap ingress driver', () => {
  it('hands each fetched message to the intake seam normalized', async () => {
    const { received, onEvent } = collector();
    const poller = new ImapPoller({
      fetchMessages: async () => [
        { sourceId: 'uid-1', rfc5322Text: SIMPLE_TEXT_EMAIL },
        { sourceId: 'uid-2', rfc5322Text: QUOTED_PRINTABLE_EMAIL },
      ],
      onEvent,
      onError: () => {},
    });

    const result = await poller.pollOnce();

    expect(result.normalizedCount).toBe(2);
    expect(result.failures).toHaveLength(0);
    expect(received).toEqual([
      adapter.normalize({ sourceId: 'uid-1', raw: SIMPLE_TEXT_EMAIL }),
      adapter.normalize({ sourceId: 'uid-2', raw: QUOTED_PRINTABLE_EMAIL }),
    ]);
    // Ticket identity comes from the thread root Message-ID the source
    // guarantees, not from anything the driver made up.
    expect(received[0]?.ticket.ticketId).toBe('order-4471-damaged@example.test');
    expect(received[0]?.message.bodyText).toContain('crushed corner');
  });

  it('never invents an eventId for inbound mail (DEC-24)', async () => {
    const { received, onEvent } = collector();
    const poller = new ImapPoller({
      fetchMessages: async () => [
        { sourceId: 'uid-7', rfc5322Text: SIMPLE_TEXT_EMAIL },
      ],
      onEvent,
      onError: () => {},
    });

    await poller.pollOnce();

    expect(received[0]?.eventId).toBeUndefined();
  });

  it('keeps ticket identity stable across polls of the same message', async () => {
    const { received, onEvent } = collector();
    const fetchMessages = async () => [
      { sourceId: 'uid-9', rfc5322Text: NO_IDS_EMAIL },
    ];
    const first = new ImapPoller({ fetchMessages, onEvent, onError: () => {} });
    const second = new ImapPoller({ fetchMessages, onEvent, onError: () => {} });

    await first.pollOnce();
    await second.pollOnce();

    expect(received).toHaveLength(2);
    expect(received[0]?.ticket.ticketId).toBe(received[1]?.ticket.ticketId);
    expect(received[0]?.ticket.ticketId).toBe(
      deriveTicketId(null, 'uid-9'),
    );
  });

  it('isolates one failing intake hand-off and still delivers the rest', async () => {
    const received: NormalizedEvent[] = [];
    const poller = new ImapPoller({
      fetchMessages: async () => [
        { sourceId: 'uid-poison', rfc5322Text: SIMPLE_TEXT_EMAIL },
        { sourceId: 'uid-good', rfc5322Text: QUOTED_PRINTABLE_EMAIL },
      ],
      onEvent: async (event) => {
        if (event.message.messageId === 'order-4471-damaged@example.test') {
          throw new Error('intake seam refused the event');
        }
        received.push(event);
      },
      onError: () => {},
    });

    const result = await poller.pollOnce();

    expect(result.normalizedCount).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.sourceId).toBe('uid-poison');
    expect((result.failures[0]?.error as Error).message).toContain('refused');
    expect(received.map((event) => event.message.messageId)).toEqual([
      'qp-cafe-missing@example.test',
    ]);
  });

  it('propagates fetch failures to the caller', async () => {
    const poller = new ImapPoller({
      fetchMessages: async () => {
        throw new Error('IMAP connection refused');
      },
      onEvent: async () => {},
      onError: () => {},
    });

    await expect(poller.pollOnce()).rejects.toThrow('IMAP connection refused');
  });

  it('polls repeatedly while started and stops when stopped', async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const poller = new ImapPoller({
        fetchMessages: async () => {
          polls++;
          return [];
        },
        onEvent: async () => {},
        intervalMs: 100,
        onError: () => {},
      });

      poller.start();
      poller.start(); // idempotent while running
      await vi.advanceTimersByTimeAsync(350);
      const pollsWhileRunning = polls;
      expect(pollsWhileRunning).toBeGreaterThanOrEqual(3);

      poller.stop();
      await vi.advanceTimersByTimeAsync(500);
      expect(polls).toBe(pollsWhileRunning);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports tick errors through onError instead of crashing', async () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      const poller = new ImapPoller({
        fetchMessages: async () => {
          throw new Error('mailbox gone');
        },
        onEvent: async () => {},
        intervalMs: 50,
        onError: (error) => {
          errors.push(error);
        },
      });

      poller.start();
      await vi.advanceTimersByTimeAsync(120);

      expect(errors.length).toBeGreaterThanOrEqual(2);
      poller.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
