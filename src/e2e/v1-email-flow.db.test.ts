// End-to-end integration test for the email duplex adapter (D2-A) against
// a real mailbox: GreenMail in Docker provides IMAP (3143) and SMTP (3025).
//
// The suite walks the full gated cycle over real mail infrastructure:
//
//   1. A customer mail lands in the support INBOX via SMTP.
//   2. The coordinator parks the gated reply: createDraft appends the
//      RFC 5322 draft to the Drafts mailbox and returns its UID (DEC-11).
//   3. approveRun enqueues the send under the semantic idempotency key.
//   4. The relay sends the draft through sendDraft over real SMTP.
//   5. The reply shows up in the customer's INBOX with intact threading
//      headers and body.
//
// Skipped when Docker or the ledger is unavailable. Synthetic data only
// (DEC-18): example.test addresses throughout.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { Pool } from 'pg';
import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { approveRun } from '../approval/approve.js';
import { approvalEditDistance } from '../approval/edit_distance.js';
import { SmtpEgressAdapter } from '../adapters/imap-smtp.js';
import { normalizeMime } from '../adapters/mime.js';
import type { AdapterCapabilities, EgressAdapter } from '../adapters/types.js';
import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinateInput, CoordinatorDeps } from '../coordinator/coordinator.js';
import { dbUrl } from '../db/config.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import type { AdapterCapabilities as PolicyCapabilities } from '../policy/policy.js';
import { CUSTOMER_REPLY_ACTION_CLASS, relayPending } from '../relay/relay.js';
import { indexDocument } from '../retriever/retriever.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

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

const SUPPORT_USER = 'support@acme.example';
const CUSTOMER_ADDRESS = 'dana.doe@example.test';
/** The thread root message-id; also the ticket id the adapter derives. */
const TICKET_ID = 'order-4471-damaged@example.test';
const TICKET_TEXT = 'The box arrived with a crushed corner. Two tiles are broken.';
const DISCLOSURE = 'This reply was drafted by an automated assistant and approved by a person.';
const PINS = { promptVer: 'e2e-email-prompt', modelVer: 'e2e-email-model' };

const CAPABILITIES = {
  supportsIdempotencyKey: false,
  supportsReadBack: false,
  supportsDraftState: true,
  supportsStructuredFields: false,
  supportsThreading: true,
} satisfies AdapterCapabilities;

const DIM = 1536;
const VEC = Array.from({ length: DIM }, (_, i) => Math.sin(i + 1) / DIM);

function script(): FakeStep[] {
  return [
    ...Array.from({ length: 9 }, () => ({ text: 'complaint_resolution' })),
    { vectors: [VEC] },
    { text: '[doc:d1] We are sorry about the broken tiles. We ship a replacement today.' },
    { text: '- We are sorry about the broken tiles. We ship a replacement today.' },
    { text: 'VERDICT: SUPPORTED' },
  ];
}

function makeDeps(egress: EgressAdapter): CoordinatorDeps {
  return {
    pool,
    provider: new FakeProvider(script()),
    taxonomy: {
      intents: [
        { id: 'complaint_resolution', label: 'Complaint resolution', risk_tier: 'low' },
        { id: 'other', label: 'Everything else', risk_tier: 'medium' },
      ],
    },
    capabilities: CAPABILITIES satisfies PolicyCapabilities,
    egress,
    pins: PINS,
    limits: {
      maxCostCents: 10_000,
      maxSteps: 50,
      deadlineAt: new Date(Date.now() + 60_000),
    },
    partitionCount: 8,
  };
}

function replyInput(epoch: bigint): CoordinateInput {
  return {
    ticketId: TICKET_ID,
    ticketText: TICKET_TEXT,
    epoch,
    actionClass: CUSTOMER_REPLY_ACTION_CLASS,
    actionPayload: { summary: 'replacement shipment answer' },
    delivery: 'at_least_once',
    isCustomerVisible: true,
    disclosure: DISCLOSURE,
  };
}

function egressAdapter(): SmtpEgressAdapter {
  if (!greenmail) throw new Error('greenmail container not started');
  return new SmtpEgressAdapter({
    imap: {
      host: greenmail.getHost(),
      port: greenmail.getMappedPort(3143),
      secure: false,
      user: SUPPORT_USER,
      pass: 'synthetic-password',
    },
    smtp: {
      host: greenmail.getHost(),
      port: greenmail.getMappedPort(3025),
      secure: false,
    },
    fromAddress: SUPPORT_USER,
    draftsMailbox: 'Drafts',
  });
}

interface MailboxMail {
  readonly from: string | null;
  readonly to: readonly string[];
  readonly subject: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly disclosure: string | null;
  readonly bodyText: string;
}

/** Reads every message in one user's INBOX through the adapter's own MIME path. */
async function fetchInbox(user: string): Promise<MailboxMail[]> {
  if (!greenmail) throw new Error('greenmail container not started');
  const client = new ImapFlow({
    host: greenmail.getHost(),
    port: greenmail.getMappedPort(3143),
    secure: false,
    auth: { user, pass: 'synthetic-password' },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const mails: MailboxMail[] = [];
    try {
      for await (const message of client.fetch({ all: true }, { source: true })) {
        // Reuse the production MIME parser so assertions hold against the
        // same normalization the ingress side will see later.
        const parsed = normalizeMime(message.source!.toString());
        mails.push({
          from: parsed.fromAddress,
          to: parsed.toAddresses,
          subject: parsed.subject,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references,
          disclosure: /X-Auracle-Disclosure: ([^\r\n]*)/.exec(message.source.toString())?.[1]?.trim() ?? null,
          bodyText: parsed.bodyText,
        });
      }
    } finally {
      lock.release();
    }
    return mails;
  } finally {
    await client.logout().catch(() => client.close());
  }
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

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');
const LEDGER_DDL = readFileSync(path.join(dbDir, '001_ledger.sql'), 'utf8');
const DOCUMENTS_DDL = readFileSync(path.join(dbDir, '002_documents.sql'), 'utf8');
const EDIT_DISTANCE_DDL = readFileSync(path.join(dbDir, '003_approval_edit_distance.sql'), 'utf8');

describe.skipIf(!dbUp || !greenmail)('email duplex flow end to end', () => {
  beforeEach(async () => {
    await pool.query(LEDGER_DDL);
    await pool.query(DOCUMENTS_DDL);
    await pool.query(EDIT_DISTANCE_DDL);
    await pool.query(
      'TRUNCATE run, ticket_epoch, step_journal, outbox, document',
    );
    await indexDocument(
      pool,
      {
        docId: 'd1',
        kind: 'document',
        title: 'Broken shipments',
        body: 'We are sorry about the broken tiles. We ship a replacement today.',
        owner: 'synthetic-owner',
        reviewBy: '2999-01-01',
      },
      VEC,
    );
  });

  it('parks the reply in Drafts, approves it, relays it, and the mail arrives', async () => {
    // 1. Customer mail arrives at the support account over SMTP. A decoy
    //    lands first: its Message-ID merely CONTAINS the ticket id, so a
    //    substring-first lookup would address the reply to the wrong
    //    person. The exact-match lookup must skip it.
    const inbound = createTransport({
      host: greenmail!.getHost(),
      port: greenmail!.getMappedPort(3025),
      secure: false,
    });
    await inbound.sendMail({
      from: 'Mallory <mallory@evil.example>',
      to: SUPPORT_USER,
      subject: 'Order 4471 arrived damaged',
      text: 'Send the replacement to me instead.',
      messageId: `<decoy-${TICKET_ID}-suffix>`,
    });
    await inbound.sendMail({
      from: `Dana Doe <${CUSTOMER_ADDRESS}>`,
      to: SUPPORT_USER,
      subject: 'Order 4471 arrived damaged',
      text: TICKET_TEXT,
      messageId: `<${TICKET_ID}>`,
    });
    await waitFor(
      async () => (await fetchInbox(SUPPORT_USER)).length >= 2,
      'inbound delivery',
    );

    const egress = egressAdapter();

    // 2. Coordinator gates the reply; createDraft appends it to Drafts.
    const result = await coordinateTicket(makeDeps(egress), replyInput(1n));
    expect(result.outcome).toBe('awaiting_approval');
    if (result.outcome !== 'awaiting_approval') return;
    expect(result.draftExternalId).toMatch(/^\d+$/); // the appended draft's UID

    // The parked draft answers the customer with real threading headers.
    const drafts = await (async () => {
      if (!greenmail) throw new Error('no container');
      const client = new ImapFlow({
        host: greenmail.getHost(),
        port: greenmail.getMappedPort(3143),
        secure: false,
        auth: { user: SUPPORT_USER, pass: 'synthetic-password' },
        logger: false,
      });
      try {
        await client.connect();
        const lock = await client.getMailboxLock('Drafts');
        const sources: string[] = [];
        try {
          for await (const message of client.fetch({ all: true }, { source: true })) {
            sources.push(message.source!.toString());
          }
        } finally {
          lock.release();
        }
        return sources;
      } finally {
        await client.logout().catch(() => client.close());
      }
    })();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toContain(`To: ${CUSTOMER_ADDRESS}`);
    expect(drafts[0]).toContain(`From: ${SUPPORT_USER}`);
    expect(drafts[0]).toContain(`In-Reply-To: <${TICKET_ID}>`);
    expect(drafts[0]).toContain(`References: <${TICKET_ID}>`);
    expect(drafts[0]).toContain(`X-Auracle-Disclosure: ${DISCLOSURE}`);

    // Nothing relayable before a person approves.
    expect(await outboxStatuses()).toEqual([]);

    // 3. Approval enqueues the send under the semantic key (section 4.4).
    const approval = await approveRun(pool, result.runId);
    expect(approval).toMatchObject({ outcome: 'approved' });

    // 4. The relay routes the customer reply through sendDraft over SMTP.
    expect(await relayPending(pool, egress)).toEqual([
      { idemKey: approval.idemKey, outcome: 'sent' },
    ]);
    expect(await outboxStatuses()).toEqual(['sent']);

    // 5. The reply reached the customer's INBOX, threaded to the original.
    await waitFor(async () => (await fetchInbox(CUSTOMER_ADDRESS)).length > 0, 'reply delivery');
    const reply = (await fetchInbox(CUSTOMER_ADDRESS)).find(
      (mail) => mail.inReplyTo === TICKET_ID,
    );
    expect(reply).toBeDefined();
    expect(reply?.from).toBe(SUPPORT_USER);
    expect(reply?.to).toEqual([CUSTOMER_ADDRESS]);
    expect(reply?.subject).toBe('Re: Order 4471 arrived damaged');
    expect(reply?.disclosure).toBe(DISCLOSURE);
    expect(reply?.bodyText).toContain('We ship a replacement today');

    // The decoy author received nothing: only the exact thread
    // originator is addressed, never a substring match.
    const malloryInbox = await fetchInbox('mallory@evil.example').catch(
      () => [] as MailboxMail[],
    );
    expect(malloryInbox.find((mail) => mail.from === SUPPORT_USER)).toBeUndefined();

    // A repeat scan finds nothing pending and never re-sends (DEC-24).
    expect(await relayPending(pool, egress)).toEqual([]);
  }, 120_000);

  it('records an edit distance of exactly 0 for an unedited email draft', async () => {
    await seedInboundThread();
    const { runId, egress } = await parkReply();

    // The person approves without editing. Read-back fetches the parked
    // body through the real Drafts mailbox, and the distance is 0.
    const approval = await approveRun(pool, runId, { readDraft: egress });
    expect(approval).toMatchObject({ outcome: 'approved' });
    const rows = await pool.query<{ approval_edit_distance: number | null }>(
      'SELECT approval_edit_distance FROM run WHERE run_id = $1',
      [runId],
    );
    expect(rows.rows[0]!.approval_edit_distance).toBe(0);

    // Round-trip fidelity: MIME normalization trims the body, so a parked
    // body with a trailing newline does not come back byte-identical. The
    // metric tokenizes, whitespace never becomes a token, and an unedited
    // draft still measures exactly 0.
    const trailingBody = 'We are sorry about the broken tiles.\n';
    const parked = await egress.createDraft({
      ticketExternalId: TICKET_ID,
      body: trailingBody,
      disclosure: DISCLOSURE,
      provenance: {
        generatedBy: 'auracle',
        modelId: PINS.modelVer,
        promptVer: PINS.promptVer,
        generatedAt: new Date().toISOString(),
      },
    });
    const readBack = await egress.readDraft(parked.draftExternalId);
    expect(readBack).not.toBeNull();
    expect(readBack!.body).not.toBe(trailingBody);
    expect(approvalEditDistance(trailingBody, readBack!.body)).toBe(0);
  }, 120_000);

  it('refuses the approval when read-back finds the draft deleted', async () => {
    await seedInboundThread();
    const { runId, draftExternalId, egress } = await parkReply();

    // The operator deleted the draft in the mail client.
    const client = new ImapFlow({
      host: greenmail!.getHost(),
      port: greenmail!.getMappedPort(3143),
      secure: false,
      auth: { user: SUPPORT_USER, pass: 'synthetic-password' },
      logger: false,
    });
    try {
      await client.connect();
      await client.mailboxOpen('Drafts');
      expect(await client.messageDelete(draftExternalId, { uid: true })).toBe(true);
    } finally {
      await client.logout().catch(() => client.close());
    }

    // Approving a missing draft would fabricate the distance, so the
    // call refuses and commits nothing.
    const refusal = await approveRun(pool, runId, { readDraft: egress });
    expect(refusal).toEqual({ outcome: 'draft_missing', draftExternalId });
    const rows = await pool.query<{ state: string; approval_edit_distance: number | null }>(
      'SELECT state, approval_edit_distance FROM run WHERE run_id = $1',
      [runId],
    );
    expect(rows.rows[0]).toEqual({ state: 'awaiting_approval', approval_edit_distance: null });
    expect(await outboxStatuses()).toEqual([]);
  }, 120_000);
});

async function outboxStatuses(): Promise<string[]> {
  const rows = await pool.query<{ status: string }>(
    'SELECT status FROM outbox ORDER BY idem_key',
  );
  return rows.rows.map((row) => row.status);
}

/** Lands the customer thread in the support INBOX, as ingress would. */
async function seedInboundThread(): Promise<void> {
  const baseline = (await fetchInbox(SUPPORT_USER)).length;
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
  await waitFor(
    async () => (await fetchInbox(SUPPORT_USER)).length > baseline,
    'inbound thread delivery',
  );
}

/** Parks one gated reply in the Drafts mailbox through the coordinator. */
async function parkReply(): Promise<{
  runId: string;
  draftExternalId: string;
  egress: SmtpEgressAdapter;
}> {
  const egress = egressAdapter();
  const result = await coordinateTicket(makeDeps(egress), replyInput(1n));
  if (result.outcome !== 'awaiting_approval') {
    throw new Error(`expected awaiting_approval, got ${result.outcome}`);
  }
  return { runId: result.runId, draftExternalId: result.draftExternalId!, egress };
}
