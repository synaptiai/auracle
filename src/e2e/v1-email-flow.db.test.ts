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
// Each case ends by settling an artifact of its inputs and end state against
// src/e2e/artifacts/v1-email-flow/ (AGENTS.md, rule 3). A mailbox UID and an
// idempotency key derived from one vary between runs against a reused
// server, so the cases register them as volatile.
//
// Skipped when Docker or the ledger is unavailable. Synthetic data only
// (DEC-18): example.test addresses throughout.

import { E2eArtifact } from '../test-support/e2e-artifact.js';
import { captureRun } from '../test-support/e2e-ledger.js';
import { deriveIdemKey } from '../ledger/keys.js';
import { truncateLedger } from '../test-support/schema.js';
import { Pool } from 'pg';
import { ImapFlow } from 'imapflow';
import { createTransport } from 'nodemailer';
import { afterAll, beforeEach, describe, expect, it, inject } from 'vitest';

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
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';
import { relayPending } from '../relay/relay.js';
import { indexDocument } from '../retriever/retriever.js';
import { resetMailboxes } from '../test-support/mailbox-reset.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

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

const SUPPORT_USER = 'support@acme.example';
const CUSTOMER_ADDRESS = 'dana.doe@example.test';
/** The author of a decoy thread, who must never receive the reply. */
const DECOY_ADDRESS = 'mallory@evil.example';
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
  supportsLedgerReply: false,
} satisfies AdapterCapabilities;

const DIM = 1536;
// Integer arithmetic and one division, which IEEE 754 rounds the same way on
// every platform. Math.sin need not: its last bits differ between CI's Linux
// runners and a Mac, so the artifact's digest of this vector differed too.
const VEC = Array.from({ length: DIM }, (_, i) => ((((i + 1) * 7919) % 2003) - 1001) / (1001 * DIM));

const TAXONOMY = {
  intents: [
    { id: 'complaint_resolution', label: 'Complaint resolution', risk_tier: 'low' },
    { id: 'other', label: 'Everything else', risk_tier: 'medium' },
  ],
} as const;

const FIXTURE_DOC = {
  docId: 'd1',
  kind: 'document',
  title: 'Broken shipments',
  body: 'We are sorry about the broken tiles. We ship a replacement today.',
  owner: 'synthetic-owner',
  reviewBy: '2999-01-01',
} as const;

/** The deadline sits this far after the run starts, so the artifact names the gap. */
const DEADLINE_AFTER_MS = 60_000;
const LIMITS = { maxCostMicros: 100_000_000, maxSteps: 50 } as const;

/** The customer mail every case lands in the support INBOX first. */
const INBOUND = {
  from: `Dana Doe <${CUSTOMER_ADDRESS}>`,
  to: SUPPORT_USER,
  subject: 'Order 4471 arrived damaged',
  text: TICKET_TEXT,
  messageId: `<${TICKET_ID}>`,
} as const;

function script(): FakeStep[] {
  return [
    ...Array.from({ length: 9 }, () => ({ text: 'complaint_resolution' })),
    { vectors: [VEC] },
    { text: '[doc:d1] We are sorry about the broken tiles. We ship a replacement today.' },
    { text: 'VERDICT: SUPPORTED' },
  ];
}

function makeDeps(egress: EgressAdapter): CoordinatorDeps {
  return {
    pool,
    provider: new FakeProvider(script()),
    taxonomy: { intents: TAXONOMY.intents.map((intent) => ({ ...intent })) },
    capabilities: CAPABILITIES satisfies PolicyCapabilities,
    egress,
    pins: PINS,
    limits: { ...LIMITS, deadlineAt: new Date(Date.now() + DEADLINE_AFTER_MS) },
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

/**
 * Port 1 on the loopback refuses at once. A case points one protocol at it to
 * fail that step of a send for real, with the other step on the real server.
 */
const REFUSED = { host: '127.0.0.1', port: 1 } as const;

/** A Drafts mailbox the support account does not have, as after a rename. */
const RENAMED_DRAFTS = 'Drafts-renamed';

function egressAdapter(broken?: 'imap' | 'smtp' | 'drafts'): SmtpEgressAdapter {
  return new SmtpEgressAdapter({
    imap: {
      ...(broken === 'imap' ? REFUSED : { host: greenmail.host, port: greenmail.imapPort }),
      secure: false,
      user: SUPPORT_USER,
      pass: 'synthetic-password',
    },
    smtp: {
      ...(broken === 'smtp' ? REFUSED : { host: greenmail.host, port: greenmail.smtpPort }),
      secure: false,
    },
    fromAddress: SUPPORT_USER,
    draftsMailbox: broken === 'drafts' ? RENAMED_DRAFTS : 'Drafts',
  });
}

interface MailboxMail {
  /** The mailbox UID, as a string, so a case can register it as volatile. */
  readonly uid: string;
  readonly idemKey: string | null;
  readonly from: string | null;
  readonly to: readonly string[];
  readonly subject: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly disclosure: string | null;
  readonly bodyText: string;
}

/** Reads every message in one user's INBOX through the adapter's own MIME path. */
function fetchInbox(user: string): Promise<MailboxMail[]> {
  return fetchMailbox(user, 'INBOX');
}

/** Reads every message in one mailbox of one user, in UID order. */
async function fetchMailbox(user: string, mailbox: string): Promise<MailboxMail[]> {
  const client = new ImapFlow({
    host: greenmail.host,
    port: greenmail.imapPort,
    secure: false,
    auth: { user, pass: 'synthetic-password' },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(mailbox);
    const mails: MailboxMail[] = [];
    try {
      for await (const message of client.fetch({ all: true }, { source: true, uid: true })) {
        // Reuse the production MIME parser so assertions hold against the
        // same normalization the ingress side will see later.
        const parsed = normalizeMime(message.source!.toString());
        mails.push({
          uid: String(message.uid),
          // The header block alone: a quoted body could carry the same text.
          idemKey: /^X-Auracle-Idem-Key: ([^\r\n]*)/im.exec(message.source!.toString().split(/\r?\n\r?\n/)[0]!)?.[1]?.trim() ?? null,
          from: parsed.fromAddress,
          to: parsed.toAddresses,
          subject: parsed.subject,
          inReplyTo: parsed.inReplyTo,
          references: parsed.references,
          disclosure: /X-Auracle-Disclosure: ([^\r\n]*)/.exec(message.source!.toString())?.[1]?.trim() ?? null,
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


/** Starts the artifact of one case, recording everything the run is given. */
function emailArtifact(caseId: string, extra: Record<string, unknown> = {}): E2eArtifact {
  return new E2eArtifact(`v1-email-flow/${caseId}`, {
    // The vector is a closed form of the index, so no seed exists.
    seed: null,
    inputs: {
      ticket: replyInput(1n),
      script: script(),
      document: { ...FIXTURE_DOC, vector: VEC },
      taxonomy: TAXONOMY,
      capabilities: CAPABILITIES,
      pins: PINS,
      limits: { ...LIMITS, deadlineAfterMs: DEADLINE_AFTER_MS },
      inbound: [INBOUND],
      ...extra,
    },
  });
}

/** The properties a Drafts UID sits under anywhere in an artifact. */
const DRAFT_UID_KEYS = ['uid', 'draftExternalId', 'first', 'repeat'];

/**
 * Records the ledger for a run and the mailboxes the flow writes to. A Drafts
 * UID becomes volatile, and so does every key that embeds one. An INBOX UID is
 * dropped: UIDs count per mailbox, so it would share a token with an
 * unrelated draft, and nothing in the flow refers to it.
 */
async function observeEndState(
  artifact: E2eArtifact,
  runId: string | null,
  users: readonly string[],
): Promise<void> {
  const drafts = await fetchMailbox(SUPPORT_USER, 'Drafts');
  const inboxes: Record<string, Omit<MailboxMail, 'uid'>[]> = {};
  for (const user of users) {
    // No catch: beforeEach creates and empties each inbox this reads, so a
    // failed read is a fault, and an empty list would match the golden.
    const mails = await fetchInbox(user);
    inboxes[user] = mails.map(({ uid: _uid, ...mail }) => mail);
  }
  for (const mail of drafts) artifact.vary(mail.uid, 'uid', DRAFT_UID_KEYS);
  if (runId !== null) {
    const ledger = await captureRun(pool, runId);
    const outbox = ledger.outbox as { idem_key: string; action_class: string; payload: Record<string, unknown> }[];
    // A reply key hashes the draft UID, so it varies with the server and
    // becomes a token. The token alone would hide a key derived from the run
    // instead (DEC-24), so the artifact records the derivation check too.
    for (const row of outbox) artifact.vary(row.idem_key, 'idem', ['idem_key', 'idemKey']);
    artifact.observe(
      'idemKeysFromActionSemantics',
      outbox.map(
        (row) =>
          row.idem_key === deriveIdemKey({ actionClass: row.action_class, ticketId: TICKET_ID, payload: row.payload }),
      ),
    );
    artifact.observe('ledger', ledger);
  }
  artifact.observe('drafts', drafts);
  artifact.observe('inboxes', inboxes);
}

describe('email duplex flow end to end', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
    // The mailbox is state this system keeps outside the ledger, and the
    // compose GreenMail service outlives the run. Without this the second run
    // against it found four drafts where the case asserts one.
    await resetMailboxes(
      { host: greenmail.host, imapPort: greenmail.imapPort, user: SUPPORT_USER, pass: 'synthetic-password' },
      ['INBOX', 'Drafts'],
    );
    // The reply lands in the customer's INBOX, and the decoy's must stay
    // empty. Both outlive the run too. Without this, a second run found the
    // first run's reply there, and the delivery wait and the threading lookup
    // both passed on it, whether or not this run's reply ever arrived.
    for (const user of [CUSTOMER_ADDRESS, DECOY_ADDRESS]) {
      await resetMailboxes(
        { host: greenmail.host, imapPort: greenmail.imapPort, user, pass: 'synthetic-password' },
        ['INBOX'],
      );
    }
    await indexDocument(pool, { ...FIXTURE_DOC }, VEC);
  });

  it('parks the reply in Drafts, approves it, relays it, and the mail arrives', async () => {
    // 1. Customer mail arrives at the support account over SMTP. A decoy
    //    lands first: its Message-ID merely CONTAINS the ticket id, so a
    //    substring-first lookup would address the reply to the wrong
    //    person. The exact-match lookup must skip it.
    const decoy = {
      from: `Mallory <${DECOY_ADDRESS}>`,
      to: SUPPORT_USER,
      subject: 'Order 4471 arrived damaged',
      text: 'Send the replacement to me instead.',
      messageId: `<decoy-${TICKET_ID}-suffix>`,
    };
    const artifact = emailArtifact('park-approve-relay-deliver', { inbound: [decoy, INBOUND] });
    const inbound = createTransport({
      host: greenmail.host,
      port: greenmail.smtpPort,
      secure: false,
    });
    await inbound.sendMail(decoy);
    await inbound.sendMail({ ...INBOUND });
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
      const client = new ImapFlow({
        host: greenmail.host,
        port: greenmail.imapPort,
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
    expect(approval.outcome).toBe('approved');
    if (approval.outcome !== 'approved') return;
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
    const malloryInbox = await fetchInbox(DECOY_ADDRESS).catch(
      () => [] as MailboxMail[],
    );
    expect(malloryInbox.find((mail) => mail.from === SUPPORT_USER)).toBeUndefined();

    // A repeat scan finds nothing pending and never re-sends (DEC-24).
    expect(await relayPending(pool, egress)).toEqual([]);

    // The artifact of this case (AGENTS.md, rule 3).
    await observeEndState(artifact, result.runId, [CUSTOMER_ADDRESS, DECOY_ADDRESS]);
    artifact.observe('approval', approval);
    artifact.finish();
  }, 120_000);

  it('records an edit distance of exactly 0 for an unedited email draft', async () => {
    const artifact = emailArtifact('edit-distance-zero');
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
      // A park key of its own, so this draft is not deduplicated onto the
      // one the coordinator already parked in this test.
      idemKey: 'park:edit-distance-round-trip',
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

    // The addressing path must agree with the membership check. db/012 gives a
    // message that names another thread's Message-ID a NEW conversation, but
    // the ticket id is still that forged root — so this lookup would resolve
    // the victim as the recipient and park a reply to them. The recorded
    // participant is the check.
    await expect(
      egress.createDraft({
        ticketExternalId: TICKET_ID,
        body: 'Send the refund to my account instead.',
        disclosure: DISCLOSURE,
        idemKey: 'park:recipient-mismatch',
        expectedRecipient: 'attacker@example.test',
        provenance: {
          generatedBy: 'auracle',
          modelId: PINS.modelVer,
          promptVer: PINS.promptVer,
          generatedAt: new Date().toISOString(),
        },
      }),
    ).rejects.toThrow(/refusing to park a reply/);

    // The genuine participant still parks normally.
    const forOwner = await egress.createDraft({
      ticketExternalId: TICKET_ID,
      body: 'We are replacing the broken tiles.',
      disclosure: DISCLOSURE,
      idemKey: 'park:recipient-match',
      expectedRecipient: CUSTOMER_ADDRESS,
      provenance: {
        generatedBy: 'auracle',
        modelId: PINS.modelVer,
        promptVer: PINS.promptVer,
        generatedAt: new Date().toISOString(),
      },
    });
    expect(forOwner.draftExternalId).toBeTruthy();

    // The artifact of this case (AGENTS.md, rule 3).
    await observeEndState(artifact, runId, []);
    artifact.observe('approval', approval);
    artifact.observe('roundTrip', { parked: trailingBody, readBack: readBack!.body });
    artifact.finish();
  }, 120_000);

  it('parks one draft for a repeated park key, against a real mailbox (DEC-24)', async () => {
    // The crash window: createDraft appends to Drafts before the ledger can
    // record the UID. A retry must find the draft the previous attempt left
    // and return it, so the customer never sees two replies waiting.
    const artifact = emailArtifact('one-draft-per-park-key');
    await seedInboundThread();
    const egress = egressAdapter();

    const key = `park:${TICKET_ID}:duplicate-guard`;
    const draft = {
      ticketExternalId: TICKET_ID,
      body: 'We are sorry about the broken tiles.',
      disclosure: DISCLOSURE,
      idemKey: key,
      provenance: {
        generatedBy: 'auracle',
        modelId: PINS.modelVer,
        promptVer: PINS.promptVer,
        generatedAt: new Date().toISOString(),
      },
    };

    const first = await egress.createDraft(draft);
    const repeat = await egress.createDraft({ ...draft, body: 'A reworded retry.' });

    expect(repeat.draftExternalId).toBe(first.draftExternalId);

    // Proof at the mailbox, not just in the return value: exactly one
    // message in Drafts carries this key.
    const client = new ImapFlow({
      host: greenmail.host,
      port: greenmail.imapPort,
      secure: false,
      auth: { user: SUPPORT_USER, pass: 'synthetic-password' },
      logger: false,
    });
    let matching: number[] = [];
    try {
      await client.connect();
      const lock = await client.getMailboxLock('Drafts');
      try {
        const found = await client.search(
          { header: { 'x-auracle-idem-key': key } },
          { uid: true },
        );
        matching = Array.isArray(found) ? found : [];
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
    expect(matching).toHaveLength(1);

    // The artifact of this case (AGENTS.md, rule 3). No run exists: the case
    // drives the adapter directly.
    await observeEndState(artifact, null, []);
    artifact.observe('parks', { first: first.draftExternalId, repeat: repeat.draftExternalId });
    artifact.finish();
  }, 120_000);

  it('refuses the approval when read-back finds the draft deleted', async () => {
    const artifact = emailArtifact('read-back-draft-deleted');
    await seedInboundThread();
    const { runId, draftExternalId, egress } = await parkReply();
    // The draft leaves the mailbox, so the end state cannot register its UID.
    artifact.vary(draftExternalId, 'uid', DRAFT_UID_KEYS);

    // The operator deleted the draft in the mail client.
    await deleteDraft(draftExternalId);

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

    // The artifact of this case (AGENTS.md, rule 3).
    await observeEndState(artifact, runId, []);
    artifact.observe('refusal', refusal);
    artifact.finish();
  }, 120_000);

  // The draft read fails before SMTP sees anything, so the delivery state is
  // known: nothing went out. DEC-30 escalates an unknown state, and this one is
  // not, so the record waits for the next scan.
  it('leaves the reply pending when the draft cannot be read, and the next scan sends it once', async () => {
    const artifact = emailArtifact('draft-read-fails-then-sends', { refused: REFUSED, broken: 'imap' });
    await seedInboundThread();
    const { runId } = await parkReply();
    const approval = await approveRun(pool, runId);
    expect(approval.outcome).toBe('approved');
    if (approval.outcome !== 'approved') return;

    const failed = await relayPending(pool, egressAdapter('imap'));
    expect(failed).toEqual([
      {
        idemKey: approval.idemKey,
        outcome: 'left_pending_retry',
        sendError: expect.stringMatching(/^no SMTP send was attempted: /),
      },
    ]);
    expect(await outboxStatuses()).toEqual(['pending']);
    expect(await runStateOf(runId)).not.toBe('escalated');
    expect(await fetchInbox(CUSTOMER_ADDRESS)).toEqual([]);

    // The read works again, and the reply goes out once.
    const sent = await relayPending(pool, egressAdapter());
    expect(sent).toEqual([{ idemKey: approval.idemKey, outcome: 'sent' }]);
    expect(await outboxStatuses()).toEqual(['sent']);
    await waitFor(async () => (await fetchInbox(CUSTOMER_ADDRESS)).length > 0, 'reply delivery');
    expect(await fetchInbox(CUSTOMER_ADDRESS)).toHaveLength(1);
    expect(await relayPending(pool, egressAdapter())).toEqual([]);

    // The artifact of this case (AGENTS.md, rule 3).
    await observeEndState(artifact, runId, [CUSTOMER_ADDRESS]);
    artifact.observe('approval', approval);
    artifact.observe('scans', { failed, sent });
    artifact.finish();
  }, 120_000);

  // A draft that is gone may have gone out first: a person can send it from a
  // mail client, which moves it out of Drafts. So it proves nothing about the
  // customer, and the record escalates as an unknown delivery (DEC-30).
  it('escalates a reply whose draft is gone as an unknown delivery, and sends nothing', async () => {
    const artifact = emailArtifact('draft-gone-delivery-unknown');
    await seedInboundThread();
    const { runId, draftExternalId } = await parkReply();
    artifact.vary(draftExternalId, 'uid', DRAFT_UID_KEYS);
    const approval = await approveRun(pool, runId);
    expect(approval.outcome).toBe('approved');
    if (approval.outcome !== 'approved') return;
    await deleteDraft(draftExternalId);

    const results = await relayPending(pool, egressAdapter());
    const gone = `no draft with UID '${draftExternalId}' in 'Drafts'`;
    expect(results).toEqual([
      { idemKey: approval.idemKey, outcome: 'delivery_unknown_escalated', sendError: gone },
    ]);
    // The cause quotes the UID, which varies with the server.
    artifact.vary(gone, 'cause', ['sendError']);
    artifact.vary(`delivery_unknown: ${gone}`, 'reason', ['reason']);
    expect(await outboxStatuses()).toEqual(['delivery_unknown']);
    expect(await runStateOf(runId)).toBe('escalated');
    expect(await fetchInbox(CUSTOMER_ADDRESS)).toEqual([]);
    expect(await relayPending(pool, egressAdapter())).toEqual([]);

    // The artifact of this case (AGENTS.md, rule 3).
    await observeEndState(artifact, runId, [CUSTOMER_ADDRESS]);
    artifact.observe('approval', approval);
    artifact.observe('relay', results);
    artifact.finish();
  }, 120_000);

  // A Drafts mailbox that is gone takes the draft with it, on the same terms.
  // The relay reads a mailbox name the account does not have, as after a
  // rename: GreenMail cannot delete a mailbox a session once selected.
  it('escalates a reply whose Drafts mailbox is gone as an unknown delivery', async () => {
    const artifact = emailArtifact('drafts-mailbox-gone-delivery-unknown', { relayDrafts: RENAMED_DRAFTS });
    await seedInboundThread();
    const { runId, draftExternalId } = await parkReply();
    artifact.vary(draftExternalId, 'uid', DRAFT_UID_KEYS);
    const approval = await approveRun(pool, runId);
    expect(approval.outcome).toBe('approved');
    if (approval.outcome !== 'approved') return;

    const results = await relayPending(pool, egressAdapter('drafts'));
    expect(results).toEqual([
      {
        idemKey: approval.idemKey,
        outcome: 'delivery_unknown_escalated',
        sendError: `the mailbox '${RENAMED_DRAFTS}' does not exist`,
      },
    ]);
    expect(await outboxStatuses()).toEqual(['delivery_unknown']);
    expect(await runStateOf(runId)).toBe('escalated');
    expect(await fetchInbox(CUSTOMER_ADDRESS)).toEqual([]);

    // The artifact of this case (AGENTS.md, rule 3). The draft is still in
    // the mailbox the relay could not find.
    await observeEndState(artifact, runId, [CUSTOMER_ADDRESS]);
    artifact.observe('approval', approval);
    artifact.observe('relay', results);
    artifact.finish();
  }, 120_000);

  // The other half of DEC-30. Once the SMTP step starts, SMTP has no
  // read-back to say what reached the customer, so the record escalates.
  it('still escalates a failed SMTP send as an unknown delivery', async () => {
    const artifact = emailArtifact('smtp-fails-delivery-unknown', { refused: REFUSED, broken: 'smtp' });
    await seedInboundThread();
    const { runId } = await parkReply();
    const approval = await approveRun(pool, runId);
    expect(approval.outcome).toBe('approved');
    if (approval.outcome !== 'approved') return;

    const results = await relayPending(pool, egressAdapter('smtp'));
    expect(results).toEqual([
      {
        idemKey: approval.idemKey,
        outcome: 'delivery_unknown_escalated',
        sendError: expect.stringContaining('ECONNREFUSED'),
      },
    ]);
    expect(results[0]!.sendError).not.toMatch(/no SMTP send was attempted/);
    expect(await outboxStatuses()).toEqual(['delivery_unknown']);
    expect(await runStateOf(runId)).toBe('escalated');
    expect(await fetchInbox(CUSTOMER_ADDRESS)).toEqual([]);
    expect(await relayPending(pool, egressAdapter())).toEqual([]);

    // The artifact of this case (AGENTS.md, rule 3).
    await observeEndState(artifact, runId, [CUSTOMER_ADDRESS]);
    artifact.observe('approval', approval);
    artifact.observe('relay', results);
    artifact.finish();
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
    host: greenmail.host,
    port: greenmail.smtpPort,
    secure: false,
  });
  await inbound.sendMail({ ...INBOUND });
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

async function runStateOf(runId: string): Promise<string> {
  const rows = await pool.query<{ state: string }>('SELECT state FROM run WHERE run_id = $1', [runId]);
  return rows.rows[0]!.state;
}

/** Deletes one parked draft, as an operator would in a mail client. */
async function deleteDraft(draftExternalId: string): Promise<void> {
  const client = new ImapFlow({
    host: greenmail.host,
    port: greenmail.imapPort,
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
}
