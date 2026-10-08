// End-to-end suite for the IMAP ingress daemon against the ephemeral test
// Postgres: real ImapSmtpAdapter normalization, real intake-table writes,
// a fake IMAP mailbox behind the fetcher seam. Covers the three behaviors
// the card requires: mail in -> intake row, per-message failure isolation,
// redeliver-on-crash (mail stays UNSEEN until intake resolved AND \Seen was
// written). Synthetic data only (DEC-18).
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SIMPLE_TEXT_EMAIL } from '../adapters/fixtures.js';
import { dbUrl } from '../db/config.js';
import type { IntakeHandler } from '../ingress/types.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { parseProducts } from '../config/products.js';
import { toIntakeTicket } from '../intake/adapter.js';
import { pollCycle } from './daemon.js';
import type { ImapDaemonLogEntry } from './daemon.js';
import { ImapPoller } from '../ingress/imap-poller.js';

const PARTITION_COUNT = 8;

/** The channel map these cases enqueue through (DEC-47). */
const CATALOGUE = parseProducts({
  products: [
    { id: 'aurora', label: 'Aurora' },
    { id: 'ledger', label: 'Ledger' },
  ],
  channels: { shipping: 'aurora', billing: 'ledger' },
});

const pool = new Pool({ connectionString: dbUrl(), max: 5 });
// src/test-support/db-global-setup.ts guarantees a reachable database before
// the workers fork: it starts a container, or probes an explicit
// DATABASE_URL and fails the run. A failure here is therefore a fault, and
// a suite that skipped itself instead would report success while proving
// nothing.
await pool.query('SELECT 1');


describe('imap daemon intake', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM intake');
  });

  afterEach(async () => {
    await pool.query('DELETE FROM intake');
  });

  /** A mailbox whose UNSEEN state lives in memory; markSeen flips it. */
  function fakeMailbox(messages: readonly { uid: number; rfc5322Text: string }[]): {
    fetcher: {
      fetchUnseen(): Promise<readonly { sourceId: string; rfc5322Text: string }[]>;
      markSeen(sourceIds: readonly string[]): Promise<void>;
    };
    markedSeen: string[];
    failMarkSeenOnce: () => void;
  } {
    const state = new Map(messages.map((m) => [m.uid, { text: m.rfc5322Text, seen: false }]));
    const markedSeen: string[] = [];
    let breakNextMarkSeen = false;
    return {
      markedSeen,
      failMarkSeenOnce: () => {
        breakNextMarkSeen = true;
      },
      fetcher: {
        async fetchUnseen() {
          return [...state.entries()]
            .filter(([, mail]) => !mail.seen)
            .sort(([a], [b]) => a - b)
            .map(([uid, mail]) => ({ sourceId: String(uid), rfc5322Text: mail.text }));
        },
        async markSeen(sourceIds: readonly string[]) {
          if (breakNextMarkSeen) {
            breakNextMarkSeen = false;
            throw new Error('imap connection lost before STORE');
          }
          markedSeen.push(...sourceIds);
          for (const id of sourceIds) {
            const mail = state.get(Number(id));
            if (mail !== undefined) mail.seen = true;
          }
        },
      },
    };
  }

  function makePoller(
    fetcher: ReturnType<typeof fakeMailbox>['fetcher'],
    onEvent: IntakeHandler,
  ): ImapPoller {
    return new ImapPoller({
      fetchMessages: () => fetcher.fetchUnseen(),
      onEvent,
      onError: () => {},
    });
  }

  it('delivers mail to an intake row and marks it seen afterwards', async () => {
    const mailbox = fakeMailbox([
      { uid: 1, rfc5322Text: SIMPLE_TEXT_EMAIL },
      { uid: 2, rfc5322Text: SIMPLE_TEXT_EMAIL.replace('order-4471', 'order-4472') },
    ]);
    const logs: ImapDaemonLogEntry[] = [];
    const log = (entry: ImapDaemonLogEntry): void => {
      logs.push(entry);
    };

    await pollCycle({
      fetcher: mailbox.fetcher,
      poller: makePoller(mailbox.fetcher, async (event) => {
        await enqueueTicket(pool, toIntakeTicket(event, CATALOGUE), PARTITION_COUNT);
      },
      ),
      log,
    });

    const rows = await pool.query<{
      ticket_id: string;
      ticket_text: string;
      partition: number;
    }>('SELECT ticket_id, ticket_text, partition FROM intake ORDER BY ticket_id');
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.ticket_id).toBe('order-4471-damaged@example.test');
    expect(rows.rows[0]?.ticket_text).toContain('crushed corner');
    // DEC-27: enqueued under its hash partition.
    for (const row of rows.rows) {
      // DEC-36 routes on the conversation id, which intake generates, so the
      // partition is no longer a function of the ticket id. It must still be
      // a partition of the ring.
      expect(row.partition).toBeGreaterThanOrEqual(0);
      expect(row.partition).toBeLessThan(PARTITION_COUNT);
    }
    // \Seen was written only after intake resolved.
    expect(mailbox.markedSeen.sort()).toEqual(['1', '2']);
    expect(logs.some((e) => e.event === 'mail_fetched' && e.count === 2)).toBe(true);
    expect(logs.some((e) => e.event === 'mail_intaked' && e.count === 2)).toBe(true);
  });

  it('isolates one failing message: others reach intake, failure stays unseen', async () => {
    const poisonEmail = [
      'From: customer@customer.example\r\n',
      'To: support@acme.example\r\n',
      'Subject: Poison pill\r\n',
      'Message-ID: <poison-' + randomUUID() + '@customer.example>\r\n',
      '\r\n',
      'POISON',
    ].join('');
    const mailbox = fakeMailbox([
      { uid: 1, rfc5322Text: SIMPLE_TEXT_EMAIL },
      { uid: 2, rfc5322Text: poisonEmail },
    ]);

    await pollCycle({
      fetcher: mailbox.fetcher,
      poller: makePoller(mailbox.fetcher, async (event) => {
        if (event.message.bodyText.includes('POISON')) {
          throw new Error('intake exploded');
        }
        await enqueueTicket(pool, toIntakeTicket(event, CATALOGUE), PARTITION_COUNT);
      }),
      log: () => {},
    });

    // The healthy message still reached intake.
    const rows = await pool.query<{ ticket_id: string }>('SELECT ticket_id FROM intake');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.ticket_id).toBe('order-4471-damaged@example.test');
    // Only the delivered message loses its UNSEEN flag.
    expect(mailbox.markedSeen).toEqual(['1']);
  });

  it('redelivers after a crash between intake and markSeen', async () => {
    const mailbox = fakeMailbox([{ uid: 7, rfc5322Text: SIMPLE_TEXT_EMAIL }]);
    // Awaited, not discarded: pollCycle marks \Seen after the poller resolves,
    // so a handler that returns undefined lets markSeen race the enqueue and
    // the ordering this case is named for is never exercised.
    const onEvent: IntakeHandler = async (event) => {
      await enqueueTicket(pool, toIntakeTicket(event, CATALOGUE), PARTITION_COUNT);
    };
    const runCycle = (): Promise<void> =>
      pollCycle({
        fetcher: mailbox.fetcher,
        poller: makePoller(mailbox.fetcher, onEvent),
        log: () => {},
      });

    // Cycle 1: intake succeeds, then the process "crashes" before \Seen
    // is stored (the flag write fails).
    mailbox.failMarkSeenOnce();
    await runCycle();
    expect(await pool.query('SELECT * FROM intake')).toHaveProperty('rows.length', 1);

    // Cycle 2: the same UID is still unseen, so it is delivered again.
    await runCycle();
    expect(mailbox.markedSeen).toEqual(['7']);
    // The re-enqueue was a no-op: the same mail carries the same Message-ID,
    // so it deduplicates on (ticket_id, message_id) and the queue holds one
    // copy. A genuinely new message on this thread would enqueue instead.
    expect(await pool.query('SELECT * FROM intake')).toHaveProperty('rows.length', 1);
  });

  it('does nothing on an empty mailbox', async () => {
    const mailbox = fakeMailbox([]);

    await pollCycle({
      fetcher: mailbox.fetcher,
      poller: makePoller(mailbox.fetcher, () => {
        throw new Error('intake must not be called');
      }),
      log: () => {},
    });

    expect(mailbox.markedSeen).toEqual([]);
    expect(await pool.query('SELECT * FROM intake')).toHaveProperty('rows.length', 0);
  });
});
