// End-to-end suite for the approval completion path (DEC-12) against the
// compose Postgres: gated -> parked draft -> approve -> relay sends.
//
// The coordinator runs with a FakeProvider and a real ledger; the helpdesk
// is the fixture-backed reference adapter; every approval runs through the
// same transactional entrypoint an operator or helpdesk webhook would call.
// Synthetic data only (DEC-18).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { coordinateTicket } from '../coordinator/coordinator.js';
import type { CoordinatorDeps } from '../coordinator/coordinator.js';
import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { dbUrl } from '../db/config.js';
import { deriveIdemKey } from '../ledger/keys.js';
import { FakeProvider } from '../models/fake.js';
import type { FakeStep } from '../models/fake.js';
import type { AdapterCapabilities } from '../policy/policy.js';
// The relay routes this one action class through the draft path.
import { COMPENSATION_ACTION_CLASS, CUSTOMER_REPLY_ACTION_CLASS } from '../relay/relay.js';
import { relayPending } from '../relay/relay.js';
import { indexDocument } from '../retriever/retriever.js';

import { approveRun } from './approve.js';
import { approvalEditDistance } from './edit_distance.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

let dbUp = true;
try {
  await pool.query('SELECT 1');
} catch {
  dbUp = false;
}

const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db');
const LEDGER_DDL = readFileSync(path.join(dbDir, '001_ledger.sql'), 'utf8');
const DOCUMENTS_DDL = readFileSync(path.join(dbDir, '002_documents.sql'), 'utf8');
const TIMING_DDL = readFileSync(path.join(dbDir, '005_run_timing.sql'), 'utf8');

const PINS = { promptVer: 'approval-test-prompt', modelVer: 'approval-test-model' };
const CAPABILITIES: AdapterCapabilities = {
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
};
const DIM = 1536;
const TICKET_TEXT = 'I cannot sign in to my account. How do I reset my password?';
const DISCLOSURE = 'This reply was drafted by an automated assistant and approved by a person.';

// Seeded PRNG so every run uses identical synthetic vectors (DEC-18).
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unitVector(seed: number): number[] {
  const rand = mulberry32(seed);
  const v = Array.from({ length: DIM }, () => rand() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

const VEC = unitVector(42);

function happyScript(): FakeStep[] {
  return [
    ...Array.from({ length: 9 }, () => ({ text: 'password_reset' })),
    { vectors: [VEC] },
    { text: '[doc:d1] Open the account settings page and choose reset password.' },
    { text: '- Open the account settings page and choose reset password.' },
    { text: 'VERDICT: SUPPORTED' },
  ];
}

function makeDeps(egress: HelpdeskAdapter): CoordinatorDeps {
  return {
    pool,
    provider: new FakeProvider(happyScript()),
    taxonomy: {
      intents: [
        { id: 'password_reset', label: 'Password reset', risk_tier: 'low' },
      ],
    },
    capabilities: CAPABILITIES,
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

function helpdeskWith(ticketId: string): HelpdeskAdapter {
  return new HelpdeskAdapter([
    {
      ticketId,
      subject: 'Cannot sign in',
      queue: 'accounts',
      status: 'open',
      customerAddress: null,
    },
  ]);
}

async function parkReply(ticketId: string): Promise<{
  runId: string;
  draftExternalId: string;
  helpdesk: HelpdeskAdapter;
}> {
  const helpdesk = helpdeskWith(ticketId);
  const result = await coordinateTicket(makeDeps(helpdesk), {
    ticketId,
    ticketText: TICKET_TEXT,
    epoch: 1n,
    actionClass: CUSTOMER_REPLY_ACTION_CLASS,
    actionPayload: { summary: 'password reset answer' },
    delivery: 'at_least_once',
    isCustomerVisible: true,
    disclosure: DISCLOSURE,
  });
  if (result.outcome !== 'awaiting_approval') {
    throw new Error(`expected awaiting_approval, got ${result.outcome}`);
  }
  return { runId: result.runId, draftExternalId: result.draftExternalId!, helpdesk };
}

async function runState(runId: string): Promise<string | undefined> {
  const rows = await pool.query('SELECT state FROM run WHERE run_id = $1', [runId]);
  return rows.rows[0]?.state as string | undefined;
}

async function outboxRows(runId: string): Promise<
  { idem_key: string; epoch: string; action_class: string; delivery: string; status: string; payload: unknown }[]
> {
  const rows = await pool.query(
    `SELECT idem_key, epoch::text AS epoch, action_class, delivery, status, payload
     FROM outbox WHERE run_id = $1`,
    [runId],
  );
  return rows.rows as { idem_key: string; epoch: string; action_class: string; delivery: string; status: string; payload: unknown }[];
}

describe.skipIf(!dbUp)('approval completion path (DEC-12 end to end)', () => {
  beforeEach(async () => {
    await pool.query(LEDGER_DDL);
    await pool.query(DOCUMENTS_DDL);
    await pool.query(TIMING_DDL);
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, document');
    await indexDocument(
      pool,
      {
        docId: 'd1',
        kind: 'document',
        title: 'Reset your password',
        body: 'Open the account settings page and choose security. Choose reset password and follow the link we email you.',
        owner: 'synthetic-owner',
        reviewBy: '2999-01-01',
      },
      VEC,
    );
  });

  afterEach(async () => {
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, document');
  });

  it('runs gated -> parked draft -> approve -> relay send end to end', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, draftExternalId, helpdesk } = await parkReply(ticketId);

    // Before approval nothing is relayable: the run waits, the outbox is empty.
    expect(await runState(runId)).toBe('awaiting_approval');
    expect(await relayPending(pool, helpdesk)).toEqual([]);

    const approval = await approveRun(pool, runId);
    expect(approval.outcome).toBe('approved');

    const idemKey = deriveIdemKey({
      actionClass: CUSTOMER_REPLY_ACTION_CLASS,
      ticketId,
      payload: { draftExternalId },
    });
    expect(approval).toEqual({ outcome: 'approved', idemKey });
    expect(await runState(runId)).toBe('resolved');

    const rows = await outboxRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      idem_key: idemKey,
      epoch: '1', // DEC-28: the record carries the run's fencing epoch
      delivery: 'at_least_once', // DEC-29: the rule from the action class
      status: 'pending',
      payload: { draftExternalId },
    });

    // The relay sends the approved draft through the same adapter.
    expect(await relayPending(pool, helpdesk)).toEqual([
      { idemKey, outcome: 'sent' },
    ]);
    const sentRows = await outboxRows(runId);
    expect(sentRows[0]).toMatchObject({ status: 'sent' });
    expect(helpdesk.getDraft(draftExternalId)?.status).toBe('sent');
    expect(helpdesk.listDeliveries()).toHaveLength(1);

    // A repeat pass sends nothing more: the key dedupes (DEC-24).
    expect(await relayPending(pool, helpdesk)).toEqual([]);
    expect(helpdesk.listDeliveries()).toHaveLength(1);

    // A second approve call loses the state race under the lock.
    expect(await approveRun(pool, runId)).toEqual({
      outcome: 'not_awaiting_approval',
      state: 'resolved',
    });
    expect(await outboxRows(runId)).toHaveLength(1);
  });

  it('reads the edited draft back and records the true distance (section 4.10)', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, draftExternalId, helpdesk } = await parkReply(ticketId);
    const parkedBody = helpdesk.getDraft(draftExternalId)!.body;

    // A person edits the draft in the helpdesk, then approves with
    // read-back: the distance must measure the parked body against the
    // edited body, not against a hand-copied string.
    const editedBody = parkedBody + ' The link stays valid for one hour.';
    await helpdesk.editDraft(draftExternalId, editedBody);

    const approval = await approveRun(pool, runId, { readDraft: helpdesk });
    expect(approval.outcome).toBe('approved');
    expect(await runState(runId)).toBe('resolved');

    const rows = await pool.query(
      'SELECT approval_edit_distance FROM run WHERE run_id = $1',
      [runId],
    );
    expect(rows.rows[0]!.approval_edit_distance).toBe(
      approvalEditDistance(parkedBody, editedBody),
    );
  });

  it('records a distance of exactly 0 when read-back finds no edit', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, helpdesk } = await parkReply(ticketId);

    const approval = await approveRun(pool, runId, { readDraft: helpdesk });
    expect(approval.outcome).toBe('approved');

    const rows = await pool.query(
      'SELECT approval_edit_distance FROM run WHERE run_id = $1',
      [runId],
    );
    expect(rows.rows[0]!.approval_edit_distance).toBe(0);
  });

  it('refuses the approval when read-back finds no draft, and nothing commits', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, draftExternalId } = await parkReply(ticketId);

    // A fresh adapter holds no parked draft: read-back cannot find what
    // the person would have edited. Approving anyway would fabricate the
    // distance, so the call refuses before any write.
    const refusal = await approveRun(pool, runId, { readDraft: new HelpdeskAdapter() });
    expect(refusal).toEqual({ outcome: 'draft_missing', draftExternalId });
    expect(await runState(runId)).toBe('awaiting_approval');
    expect(await outboxRows(runId)).toEqual([]);
    const rows = await pool.query(
      'SELECT approval_edit_distance FROM run WHERE run_id = $1',
      [runId],
    );
    expect(rows.rows[0]!.approval_edit_distance).toBeNull();

    // The refusal blocks nothing: the operator reconciles by hand and the
    // manual approval path still works.
    expect(await approveRun(pool, runId)).toMatchObject({ outcome: 'approved' });
  });

  it('lets an explicit final body win over read-back', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId, draftExternalId, helpdesk } = await parkReply(ticketId);
    const parkedBody = helpdesk.getDraft(draftExternalId)!.body;

    // The adapter holds an edit, but the caller captured an explicit body;
    // the explicit capture is authoritative.
    await helpdesk.editDraft(draftExternalId, parkedBody + ' Edited in the helpdesk.');
    const explicitBody = parkedBody + ' Captured explicitly.';

    const approval = await approveRun(pool, runId, {
      finalBody: explicitBody,
      readDraft: helpdesk,
    });
    expect(approval.outcome).toBe('approved');

    const rows = await pool.query(
      'SELECT approval_edit_distance FROM run WHERE run_id = $1',
      [runId],
    );
    expect(rows.rows[0]!.approval_edit_distance).toBe(
      approvalEditDistance(parkedBody, explicitBody),
    );
  });

  it('reports unknown_run for an id that never existed', async () => {
    expect(await approveRun(pool, randomUUID())).toEqual({ outcome: 'unknown_run' });
  });

  it('runs compensation: ledger-only park -> approve -> performAction end to end', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const helpdesk = helpdeskWith(ticketId);
    const result = await coordinateTicket(makeDeps(helpdesk), {
      ticketId,
      ticketText: TICKET_TEXT,
      epoch: 1n,
      actionClass: COMPENSATION_ACTION_CLASS,
      actionPayload: { reason: 'refund sent to the wrong account' },
      // DEC-29: the class declares at_most_once; the coordinator refuses
      // anything else.
      delivery: 'at_most_once',
      isCustomerVisible: false,
      disclosure: DISCLOSURE,
    });
    if (result.outcome !== 'awaiting_approval') {
      throw new Error(`unexpected ${result.outcome}`);
    }
    const runId = result.runId;

    const approval = await approveRun(pool, runId);
    expect(approval.outcome).toBe('approved');

    const idemKey = deriveIdemKey({
      actionClass: COMPENSATION_ACTION_CLASS,
      ticketId,
      payload: { reason: 'refund sent to the wrong account' },
    });
    expect(await runState(runId)).toBe('resolved');
    const rows = await outboxRows(runId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      idem_key: idemKey,
      action_class: COMPENSATION_ACTION_CLASS,
      delivery: 'at_most_once', // DEC-29: declared by the action class
      status: 'pending',
      payload: { reason: 'refund sent to the wrong account' },
    });

    // The relay routes the non-reply class through performAction; the
    // adapter records the compensating credit against the ticket.
    expect(await relayPending(pool, helpdesk)).toEqual([
      { idemKey, outcome: 'sent' },
    ]);
    expect(helpdesk.listDeliveries()).toHaveLength(1);

    // A repeat pass sends nothing more (DEC-24): a replayed compensation
    // never pays twice.
    expect(await relayPending(pool, helpdesk)).toEqual([]);
    expect(helpdesk.listDeliveries()).toHaveLength(1);
  });

  it('refuses to approve a run that never reached awaiting_approval', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const helpdesk = helpdeskWith(ticketId);
    const result = await coordinateTicket(makeDeps(helpdesk), {
      ticketId,
      ticketText: TICKET_TEXT,
      epoch: 1n,
      actionClass: 'route_ticket',
      actionPayload: { queue: 'password-support' },
      delivery: 'at_most_once',
      isCustomerVisible: false,
      disclosure: DISCLOSURE,
    });
    if (result.outcome !== 'resolved') throw new Error(`unexpected ${result.outcome}`);

    expect(await approveRun(pool, result.runId)).toEqual({
      outcome: 'not_awaiting_approval',
      state: 'resolved',
    });
  });

  it('refuses a stale write when the fencing epoch moved on (DEC-28)', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const { runId } = await parkReply(ticketId);

    // A rebalance handed the ticket to another owner at a higher epoch.
    await pool.query('UPDATE ticket_epoch SET epoch = $2 WHERE ticket_id = $1', [
      ticketId,
      '50',
    ]);

    const approval = await approveRun(pool, runId);
    expect(approval.outcome).toBe('stale_epoch');
    if (approval.outcome === 'stale_epoch') {
      expect(approval.highestAcceptedEpoch).toBe(50n);
    }
    expect(await runState(runId)).toBe('awaiting_approval');
    expect(await outboxRows(runId)).toHaveLength(0);
  });

  afterAll(async () => {
    await pool.end();
  });
});
