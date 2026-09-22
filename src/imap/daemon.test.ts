// Issue #114: the mail daemon's own log path, with a value from inbound mail
// in it. A message that fails intake is logged with the fault, and intake's
// fault quotes what it refused — as a Postgres constraint violation quotes the
// key it saw — so the subject the sender wrote reaches the line.
import { describe, expect, it, vi } from 'vitest';

import { SIMPLE_TEXT_EMAIL } from '../adapters/fixtures.js';
import { expectEscaped, HOSTILE } from '../test-support/raw-log.js';

import { startImapDaemon } from './daemon.js';

describe('the mail daemon log', () => {
  it('escapes a value from an inbound message, and the line parses back', async () => {
    const raw = SIMPLE_TEXT_EMAIL.replace(
      'Subject: Order 4471 arrived damaged',
      `Subject: ${HOSTILE}`,
    );
    expect(raw).toContain(HOSTILE);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    let failed = false;
    try {
      const daemon = startImapDaemon({
        fetcher: {
          fetchUnseen: async () => (failed ? [] : [{ sourceId: 'uid-1', rfc5322Text: raw }]),
          markSeen: async () => {},
        },
        onEvent: (event) => {
          failed = true;
          throw new Error(`duplicate key: Key (subject)=(${event.message.subject ?? ''})`);
        },
        intervalMs: 60_000,
      });
      // One cycle is enough: the first poll fails the message and logs it.
      await vi.waitFor(() => {
        expect(lines.some((line) => line.includes('message_failed'))).toBe(true);
      });
      await daemon.stop();
    } finally {
      spy.mockRestore();
    }
    const carrier = expectEscaped(lines, HOSTILE);
    expect(carrier['event']).toBe('message_failed');
  });
});
