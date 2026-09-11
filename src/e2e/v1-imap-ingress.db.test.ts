// End-to-end integration test for the IMAP ingress daemon (D1-A) against a
// real mailbox: GreenMail in Docker provides IMAP (3143) and SMTP (3025).
//
// The suite proves the done criterion "mail in -> intake row" over real IMAP
// infrastructure, with no seams replaced on the mail path:
//
//   1. A customer mail lands in the support INBOX via SMTP.
//   2. A real ImapMailboxFetcher (imapflow, UID search, RFC 5322 source)
//      feeds one pollCycle through the real ImapSmtpAdapter into the
//      intake table via enqueueTicket.
//   3. The message gained \Seen only after intake resolved (markSeen path).
//   4. A second poll finds nothing: seen mail is never redelivered.
//
// Skipped when Docker or the ledger is unavailable. Synthetic data only
// (DEC-18): example.test addresses throughout.

import { Pool } from 'pg';
import { createTransport } from 'nodemailer';
import { afterAll, beforeEach, describe, expect, it, inject } from 'vitest';

import { dbUrl } from '../db/config.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { toIntakeTicket } from '../intake/adapter.js';
import { ImapPoller } from '../ingress/imap-poller.js';
import { pollCycle } from '../imap/daemon.js';
import type { ImapDaemonLogEntry } from '../imap/daemon.js';
import { ImapMailboxFetcher, imapFlowFactory } from '../imap/fetcher.js';

const PARTITION_COUNT = 8;
// One GreenMail server now serves every mail suite, so each suite owns its
// own mailboxes. Sharing `support@acme.example` with the duplex suite let
// its delivered mail count as this suite's unseen mail. Synthetic reserved
// domains throughout (DEC-18).
const SUPPORT_USER = 'support-ingress@acme.example';
const CUSTOMER_ADDRESS = 'dana.ingress@example.test';
/** The thread root message-id; also the ticket id the adapter derives. */
const TICKET_ID = 'order-4471-ingress@example.test';
const TICKET_TEXT = 'The box arrived with a crushed corner. Two tiles are broken.';

const pool = new Pool({ connectionString: dbUrl(), max: 5 });

// src/test-support/mail-global-setup.ts guarantees a reachable database before
// the workers fork: it starts a container, or probes an explicit
// DATABASE_URL and fails the run. A failure here is therefore a fault, and
// a suite that skipped itself instead would report success while proving
// nothing.
await pool.query('SELECT 1');

// The GreenMail server is shared: src/test-support/mail-global-setup.ts starts one
// per run, waits until it answers IMAP, and provides its mapped address. This
// suite used to start its own and guard itself with describe.skipIf, so a
// container that failed to start produced a green run.
const greenmail = inject('mail');

afterAll(async () => {
  await pool.end();
});


function realFetcher(): ImapMailboxFetcher {
  return new ImapMailboxFetcher(
    {
      host: greenmail.host,
      port: greenmail.imapPort,
      secure: false,
      user: SUPPORT_USER,
      pass: 'synthetic-password',
    },
    imapFlowFactory({
      host: greenmail.host,
      port: greenmail.imapPort,
      secure: false,
      user: SUPPORT_USER,
      pass: 'synthetic-password',
    }),
    () => {},
  );
}

/** One daemon poll against the real mailbox, intake writing to Postgres. */
function runCycle(fetcher: ImapMailboxFetcher, logs: ImapDaemonLogEntry[]): Promise<void> {
  const poller = new ImapPoller({
    fetchMessages: () => fetcher.fetchUnseen(),
    onEvent: async (event) => {
      await enqueueTicket(pool, toIntakeTicket(event), PARTITION_COUNT);
    },
    onError: () => {},
  });
  return pollCycle({
    fetcher,
    poller,
    log: (entry) => {
      logs.push(entry);
    },
  });
}

async function waitFor(condition: () => Promise<boolean>, what: string): Promise<void> {
  // The shared server is already answering IMAP before any suite runs, so
  // this budget covers one delivery rather than a JVM start. It stays
  // generous because a loaded Docker host slows every round trip.
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await condition()) return;
    } catch (err) {
      // GreenMail creates users and mailboxes lazily; early polls may fail.
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${what}${lastError ? ` (last error: ${String(lastError)})` : ''}`);
}

describe('imap ingress daemon end to end', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM intake');
  });

  it('delivers real mail to an intake row, marks it seen, never redelivers', async () => {
    const fetcher = realFetcher();
    const logs: ImapDaemonLogEntry[] = [];

    // 1. Customer mail arrives at the support account over SMTP.
    const inbound = createTransport({
      host: greenmail.host,
      port: greenmail.smtpPort,
      secure: false,
    });
    await inbound.sendMail({
      from: `Dana Doe <${CUSTOMER_ADDRESS}>`,
      to: SUPPORT_USER,
      subject: 'Order 4471 arrived damaged',
      text: TICKET_TEXT,
      messageId: `<${TICKET_ID}>`,
    });

    // Wait until the real fetcher sees exactly one UNSEEN message. The
    // fetch path is read-only (BODY.PEEK), so polling never sets \Seen.
    await waitFor(
      async () => (await fetcher.fetchUnseen()).length === 1,
      'greenmail to hold one unseen message',
    );

    // 2. One daemon cycle: fetch -> normalize -> intake -> markSeen.
    await runCycle(fetcher, logs);

    const rows = await pool.query<{ ticket_id: string; ticket_text: string; partition: number }>(
      'SELECT ticket_id, ticket_text, partition FROM intake',
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.ticket_id).toBe(TICKET_ID);
    expect(rows.rows[0]!.ticket_text).toContain('crushed corner');
    // DEC-36: the row sits under its conversation's partition, which intake
    // generates, so it is not a function of the ticket id.
    expect(rows.rows[0]!.partition).toBeGreaterThanOrEqual(0);
    expect(rows.rows[0]!.partition).toBeLessThan(PARTITION_COUNT);
    expect(logs.some((e) => e.event === 'mail_intaked' && e.count === 1)).toBe(true);

    // 3. The message gained \Seen only after intake resolved.
    await expect(fetcher.fetchUnseen()).resolves.toEqual([]);

    // 4. A second poll finds nothing new: seen mail is not redelivered.
    const intakeCount = logs.filter((e) => e.event === 'mail_intaked').length;
    await runCycle(fetcher, logs);
    expect(await pool.query('SELECT * FROM intake')).toHaveProperty('rows.length', 1);
    expect(logs.filter((e) => e.event === 'mail_intaked').length).toBe(intakeCount);

    fetcher.stop();
  }, 120_000);
});
