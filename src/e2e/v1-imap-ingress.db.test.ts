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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Pool } from 'pg';
import { createTransport } from 'nodemailer';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { enqueueTicket } from '../coordinator/intake.js';
import { partitionOf } from '../coordinator/coordinator.js';
import { ImapPoller } from '../ingress/imap-poller.js';
import { pollCycle } from '../imap/daemon.js';
import type { ImapDaemonLogEntry } from '../imap/daemon.js';
import { ImapMailboxFetcher, imapFlowFactory } from '../imap/fetcher.js';

const PARTITION_COUNT = 8;
const SUPPORT_USER = 'support@acme.example';
const CUSTOMER_ADDRESS = 'dana.doe@example.test';
/** The thread root message-id; also the ticket id the adapter derives. */
const TICKET_ID = 'order-4471-damaged@example.test';
const TICKET_TEXT = 'The box arrived with a crushed corner. Two tiles are broken.';

const pool = new Pool({ connectionString: dbUrl(), max: 5 });

let dbUp = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbUp = false;
}

let greenmail: StartedTestContainer | undefined;
try {
  greenmail = await new GenericContainer('greenmail/standalone:2.1.12')
    .withEnvironment({
      GREENMAIL_OPTS:
        '-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled',
    })
    .withExposedPorts(3025, 3143)
    .withStartupTimeout(300_000)
    .start();
} catch {
  greenmail = undefined;
}

afterAll(async () => {
  await greenmail?.stop();
  await pool.end();
});

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');
const INTAKE_DDL = readFileSync(path.join(dbDir, '004_intake.sql'), 'utf8');

function realFetcher(): ImapMailboxFetcher {
  if (!greenmail) throw new Error('greenmail container not started');
  return new ImapMailboxFetcher(
    {
      host: greenmail.getHost(),
      port: greenmail.getMappedPort(3143),
      secure: false,
      user: SUPPORT_USER,
      pass: 'synthetic-password',
    },
    imapFlowFactory({
      host: greenmail.getHost(),
      port: greenmail.getMappedPort(3143),
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
    onEvent: (event) =>
      enqueueTicket(
        pool,
        { ticketId: event.ticket.ticketId, ticketText: event.message.bodyText },
        PARTITION_COUNT,
      ),
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
  const deadline = Date.now() + 15_000;
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

describe.skipIf(!dbUp || !greenmail)('imap ingress daemon end to end', () => {
  beforeEach(async () => {
    await pool.query(INTAKE_DDL);
    await pool.query('DELETE FROM intake');
  });

  it('delivers real mail to an intake row, marks it seen, never redelivers', async () => {
    const fetcher = realFetcher();
    const logs: ImapDaemonLogEntry[] = [];

    // 1. Customer mail arrives at the support account over SMTP.
    const inbound = createTransport({
      host: greenmail!.getHost(),
      port: greenmail!.getMappedPort(3025),
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
    // DEC-27: the row sits under its hash partition.
    expect(rows.rows[0]!.partition).toBe(partitionOf(TICKET_ID, PARTITION_COUNT));
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
