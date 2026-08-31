// Integration suite for the outbox relay of section 4.4, proven end-to-end
// against Dockerized Postgres. Records enter through the real write path
// (fencedInsert, section 4.2) so each test exercises insert -> pending ->
// relay -> terminal status exactly as production would.
import { randomUUID } from 'node:crypto';

import { applyLedgerSchema } from '../test-support/schema.js';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  AdapterCapabilities,
  DeliveryState,
  EgressAdapter,
} from '../adapters/types.js';
import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { dbUrl } from '../db/config.js';
import { fencedInsert, type FencedOutboxInput, type FencedRunInput } from '../ledger/insert.js';
import { COMPENSATION_ACTION_CLASS } from '../adapters/types.js';
import { relayPending } from './relay.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

// src/test-support/global-setup.ts guarantees a reachable database before
// the workers fork: it starts a container, or probes an explicit
// DATABASE_URL and fails the run. A failure here is therefore a fault, and
// a suite that skipped itself instead would report success while proving
// nothing.
await pool.query('SELECT 1');


/** Egress fake whose send and read-back behaviour a test scripts per case. */
class ScriptedEgress implements EgressAdapter {
  readonly name = 'scripted';

  readonly capabilities: AdapterCapabilities;

  readonly sendCalls: Array<{ draftExternalId: string; idemKey: string }> = [];

  readonly performCalls: Array<{
    actionClass: string;
    payload: Record<string, unknown>;
    idemKey: string;
  }> = [];

  constructor(
    capabilities: AdapterCapabilities,
    private readonly onSend: (call: {
      draftExternalId: string;
      idemKey: string;
    }) => Promise<{ readonly externalId: string }>,
    private readonly onReadBack: (ref: { readonly idemKey: string }) => Promise<DeliveryState>,
    private readonly onPerform?: (call: {
      actionClass: string;
      payload: Record<string, unknown>;
      idemKey: string;
    }) => Promise<{ readonly externalId: string }>,
  ) {
    this.capabilities = capabilities;
  }

  createDraft(): Promise<{ readonly draftExternalId: string }> {
    throw new Error('the relay never parks drafts; the approval bridge does');
  }

  async sendDraft(
    draftExternalId: string,
    idemKey: string,
  ): Promise<{ readonly externalId: string }> {
    const call = { draftExternalId, idemKey };
    this.sendCalls.push(call);
    return this.onSend(call);
  }

  async performAction(
    actionClass: string,
    payload: Record<string, unknown>,
    idemKey: string,
  ): Promise<{ readonly externalId: string }> {
    const call = { actionClass, payload, idemKey };
    this.performCalls.push(call);
    if (!this.onPerform) {
      throw new Error('no performAction behaviour scripted for this test');
    }
    return this.onPerform(call);
  }

  async readBack(ref: { readonly idemKey: string }): Promise<DeliveryState> {
    return this.onReadBack(ref);
  }
}

function makeRun(epoch: bigint, ticketId: string): FencedRunInput {
  return {
    runId: randomUUID(),
    ticketId,
    partition: 0,
    epoch,
    state: 'queued',
    promptVer: 'p1',
    modelVer: 'm1',
    deadlineAt: new Date(Date.now() + 60_000),
  };
}

function replyOutbox(
  run: FencedRunInput,
  idemKey: string,
  delivery: 'at_least_once' | 'at_most_once',
): FencedOutboxInput {
  return {
    stepId: 's1',
    idemKey,
    actionClass: 'customer_reply',
    delivery,
    payload: { draftExternalId: `draft-${run.ticketId}` },
  };
}

async function seedPending(
  ticketId: string,
  epoch: bigint,
  delivery: 'at_least_once' | 'at_most_once',
): Promise<string> {
  const run = makeRun(epoch, ticketId);
  const idemKey = `idem:${ticketId}`;
  const result = await fencedInsert(pool, run, replyOutbox(run, idemKey, delivery));
  expect(result).toEqual({ outcome: 'accepted' });
  return idemKey;
}

/** Seed one pending automatic internal write (any class but customer_reply). */
async function seedPendingAction(
  ticketId: string,
  epoch: bigint,
  actionClass: string,
  payload: Record<string, unknown>,
  delivery: 'at_least_once' | 'at_most_once' = 'at_most_once',
): Promise<string> {
  const run = makeRun(epoch, ticketId);
  const idemKey = `${actionClass}:${ticketId}:test`;
  const result = await fencedInsert(pool, run, {
    stepId: 's1',
    idemKey,
    actionClass,
    delivery,
    payload,
  });
  expect(result).toEqual({ outcome: 'accepted' });
  return idemKey;
}

async function outboxStatus(idemKey: string): Promise<string> {
  const rows = await pool.query('SELECT status FROM outbox WHERE idem_key = $1', [idemKey]);
  return rows.rows[0]!.status as string;
}

async function runState(idemKey: string): Promise<string> {
  const rows = await pool.query(
    'SELECT r.state FROM run r JOIN outbox o ON o.run_id = r.run_id WHERE o.idem_key = $1',
    [idemKey],
  );
  return rows.rows[0]!.state as string;
}

/**
 * `finished_at` for the run behind one outbox record. Null means the service
 * time cannot be measured for that run (db/005_run_timing.sql).
 */
async function runFinishedAt(idemKey: string): Promise<Date | null> {
  const rows = await pool.query(
    'SELECT r.finished_at FROM run r JOIN outbox o ON o.run_id = r.run_id WHERE o.idem_key = $1',
    [idemKey],
  );
  return rows.rows[0]!.finished_at as Date | null;
}

describe('section 4.4 outbox relay', () => {
  beforeEach(async () => {
    await applyLedgerSchema(pool);
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, conversation, turn');
  });

  afterEach(async () => {
    await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, conversation, turn');
  });

  it('sends first and sets the status second', async () => {
    // The core ordering guarantee: while the send is in flight the record
    // is still pending; only after the send resolves does it become sent.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_least_once');

    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sendEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      sendEntered = resolve;
    });

    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: true,
        supportsReadBack: false,
        supportsDraftState: true,
        supportsStructuredFields: true,
        supportsThreading: true,
      }),
      async (call) => {
        sendEntered();
        await inFlight;
        expect(call.idemKey).toBe(idemKey);
        expect(call.draftExternalId).toBe(`draft-${ticket}`);
        return { externalId: 'ext-1' };
      },
      async () => {
        throw new Error('read-back must not run when the send succeeds');
      },
    );

    const pass = relayPending(pool, adapter);
    await entered;
    expect(await outboxStatus(idemKey)).toBe('pending');

    release();
    await pass;

    expect(adapter.sendCalls).toEqual([{ draftExternalId: `draft-${ticket}`, idemKey }]);
    expect(await outboxStatus(idemKey)).toBe('sent');
    expect(await runState(idemKey)).toBe('queued'); // success touches nothing else
  });

  it('never pays a compensation twice: at_most_once escalates on not_found (DEC-34, DEC-30)', async () => {
    // The cell the compensation decision leans on. A sent refund cannot be
    // reversed, so an adapter with no idempotency support that reports the
    // delivery 'not_found' must escalate rather than try again. A second
    // attempt here would move money twice.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPendingAction(
      ticket,
      10n,
      COMPENSATION_ACTION_CLASS,
      { reason: 'refund issued against the wrong ticket' },
      'at_most_once',
    );

    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: false,
        supportsReadBack: true,
        supportsDraftState: false,
        supportsStructuredFields: false,
        supportsThreading: false,
      }),
      async () => {
        throw new Error('gateway timed out; the refund may or may not have gone out');
      },
      async () => ({ state: 'not_found' }),
    );

    const results = await relayPending(pool, adapter);
    expect(results.map((r) => ({ idemKey: r.idemKey, outcome: r.outcome }))).toEqual([
      { idemKey, outcome: 'delivery_unknown_escalated' },
    ]);
    // The relay decides DEC-30, so it must say why it could not send.
    expect(results[0]?.sendError).toBeTruthy();
    // Rode performAction, not the draft path: a compensation has no draft.
    expect(adapter.performCalls).toHaveLength(1);
    expect(adapter.performCalls[0]?.actionClass).toBe(COMPENSATION_ACTION_CLASS);
    expect(adapter.sendCalls).toHaveLength(0);
    expect(await outboxStatus(idemKey)).toBe('delivery_unknown');
    expect(await runState(idemKey)).toBe('escalated');
    expect(await runFinishedAt(idemKey)).toBeInstanceOf(Date);

    // Terminal: a later scan finds nothing, so no second refund is possible.
    await relayPending(pool, adapter);
    expect(adapter.performCalls).toHaveLength(1);
  });

  it('escalates at-most-once records with unknown delivery state and never blind-retries', async () => {
    // DEC-29/DEC-30, the cell AGENTS.md flags: no idempotency support, the
    // send threw, no read-back -> the state is unknown -> delivery_unknown
    // plus an escalated run, exactly one send attempt across scans.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_most_once');

    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: false,
        supportsReadBack: false,
        supportsDraftState: false,
        supportsStructuredFields: false,
        supportsThreading: false,
      }),
      async () => {
        throw new Error('connection lost mid-send; delivery state unknown');
      },
      async () => {
        throw new Error('read-back must not run without supportsReadBack');
      },
    );

    const results = await relayPending(pool, adapter);
    expect(results.map((r) => ({ idemKey: r.idemKey, outcome: r.outcome }))).toEqual([
      { idemKey, outcome: 'delivery_unknown_escalated' },
    ]);
    // The relay decides DEC-30, so it must say why it could not send.
    expect(results[0]?.sendError).toBeTruthy();
    expect(adapter.sendCalls).toHaveLength(1);
    expect(await outboxStatus(idemKey)).toBe('delivery_unknown');
    expect(await runState(idemKey)).toBe('escalated');
    // 'escalated' is terminal, so the service time must be measurable. The
    // relay used to move the state without the stamp, which dropped every
    // escalated run out of any latency measurement (db/005_run_timing.sql).
    expect(await runFinishedAt(idemKey)).toBeInstanceOf(Date);

    // A later scan finds nothing pending: escalation is terminal for the
    // relay, so no second refund can ever be paid by accident.
    await relayPending(pool, adapter);
    expect(adapter.sendCalls).toHaveLength(1);
  });

  it('reconciles through read-back instead of escalating when the delivery landed', async () => {
    // DEC-30: with read-back support the relay reads the target system and
    // reconciles. The throw left the state unknown; the read-back proves
    // delivered, so the record lands sent — no escalation, no retry.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_least_once');

    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: false,
        supportsReadBack: true,
        supportsDraftState: false,
        supportsStructuredFields: false,
        supportsThreading: false,
      }),
      async () => {
        throw new Error('timeout after transmit; did it land?');
      },
      async (ref) => {
        expect(ref.idemKey).toBe(idemKey);
        return { state: 'delivered', externalId: 'ext-9' };
      },
    );

    const results = await relayPending(pool, adapter);
    expect(results.map((r) => ({ idemKey: r.idemKey, outcome: r.outcome }))).toEqual([
      { idemKey, outcome: 'sent_reconciled' },
    ]);
    expect(results[0]?.sendError).toBeTruthy();
    expect(adapter.sendCalls).toHaveLength(1);
    expect(await outboxStatus(idemKey)).toBe('sent');
    expect(await runState(idemKey)).toBe('queued');
  });

  it('treats a failing read-back as an unknown state and escalates without retrying', async () => {
    // DEC-30 regression: supportsReadBack is true, but readBack itself
    // throws. The delivery state is still unknown, so the record must land
    // delivery_unknown + escalated with exactly one send attempt — not
    // stay pending for a blind retry on the next scan.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_most_once');

    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: false,
        supportsReadBack: true,
        supportsDraftState: false,
        supportsStructuredFields: false,
        supportsThreading: false,
      }),
      async () => {
        throw new Error('connection lost mid-send; delivery state unknown');
      },
      async () => {
        throw new Error('read-back endpoint unreachable');
      },
    );

    const results = await relayPending(pool, adapter);
    expect(results.map((r) => ({ idemKey: r.idemKey, outcome: r.outcome }))).toEqual([
      { idemKey, outcome: 'delivery_unknown_escalated' },
    ]);
    // The relay decides DEC-30, so it must say why it could not send.
    expect(results[0]?.sendError).toBeTruthy();
    expect(adapter.sendCalls).toHaveLength(1);
    expect(await outboxStatus(idemKey)).toBe('delivery_unknown');
    expect(await runState(idemKey)).toBe('escalated');

    await relayPending(pool, adapter);
    expect(adapter.sendCalls).toHaveLength(1);
  });

  it('leaves a confirmed-loss at_least_once record pending so the next scan retries it', async () => {
    // Row 2 of the table, loss-costs-more column: once read-back proves
    // not_found the state is known, so the at_least_once record may retry.
    // A duplicate is impossible here — nothing was delivered.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_least_once');
    let attempts = 0;

    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: false,
        supportsReadBack: true,
        supportsDraftState: false,
        supportsStructuredFields: false,
        supportsThreading: false,
      }),
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('first attempt fails before transmit');
        }
        return { externalId: 'ext-2' };
      },
      async () => ({ state: 'not_found' }),
    );

    const firstPass = await relayPending(pool, adapter);
    expect(firstPass.map((r) => ({ idemKey: r.idemKey, outcome: r.outcome }))).toEqual([
      { idemKey, outcome: 'left_pending_retry' },
    ]);
    expect(firstPass[0]?.sendError).toBeTruthy();
    expect(await outboxStatus(idemKey)).toBe('pending');

    const secondPass = await relayPending(pool, adapter);
    expect(secondPass).toEqual([{ idemKey, outcome: 'sent' }]);
    expect(adapter.sendCalls).toHaveLength(2);
    expect(await outboxStatus(idemKey)).toBe('sent');
  });

  it('fences stale-epoch records at send time and never sends them', async () => {
    // DEC-28, the second check: the lease expired between insert and send,
    // ticket_epoch moved on, so the record leaves the pending queue unsent.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_least_once');
    await pool.query('UPDATE ticket_epoch SET epoch = 11 WHERE ticket_id = $1', [ticket]);

    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: true,
        supportsReadBack: false,
        supportsDraftState: true,
        supportsStructuredFields: true,
        supportsThreading: true,
      }),
      async () => {
        throw new Error('a fenced record must never reach the adapter');
      },
      async () => {
        throw new Error('unreachable');
      },
    );

    const results = await relayPending(pool, adapter);
    expect(results).toEqual([{ idemKey, outcome: 'fenced' }]);
    expect(adapter.sendCalls).toHaveLength(0);
    expect(await outboxStatus(idemKey)).toBe('fenced');
  });

  it('routes an automatic internal write through performAction exactly once under retry', async () => {
    // The executing path of section 4.3 end to end: an internal-write
    // record leaves the outbox, reaches `performAction`, and under a
    // transient failure plus a later scan applies exactly once. sendDraft
    // throws if ever called: internal writes never take the draft path.
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPendingAction(ticketId, 10n, 'route_ticket', {
      queue: 'password-support',
    });

    const helpdesk = new HelpdeskAdapter([
      {
        ticketId,
        subject: 'synthetic ticket',
        queue: null,
        status: 'open',
        customerAddress: null,
      },
    ]);
    let attempts = 0;
    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: true,
        supportsReadBack: true,
        supportsDraftState: true,
        supportsStructuredFields: true,
        supportsThreading: true,
      }),
      async () => {
        throw new Error('sendDraft must never run for an internal write');
      },
      async () => {
        throw new Error('read-back must not run when performAction succeeds');
      },
      async (call) => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient timeout; did the write land?');
        // The relay hands over the ledger's ticket identity with the action.
        expect(call.actionClass).toBe('route_ticket');
        expect(call.payload['ticketExternalId']).toBe(ticketId);
        return helpdesk.performAction(call.actionClass, call.payload, call.idemKey);
      },
    );

    const firstPass = await relayPending(pool, adapter);
    expect(firstPass.map((r) => ({ idemKey: r.idemKey, outcome: r.outcome }))).toEqual([
      { idemKey, outcome: 'left_pending_retry' },
    ]);
    expect(firstPass[0]?.sendError).toBeTruthy();
    expect(await outboxStatus(idemKey)).toBe('pending');

    const secondPass = await relayPending(pool, adapter);
    expect(secondPass).toEqual([{ idemKey, outcome: 'sent' }]);

    // The write applied exactly once, deduped on the semantic idem key.
    expect(helpdesk.getTicket(ticketId)?.queue).toBe('password-support');
    expect(helpdesk.listDeliveries()).toHaveLength(1);

    // A later scan finds nothing pending and never re-applies.
    await expect(relayPending(pool, adapter)).resolves.toEqual([]);
    expect(helpdesk.listDeliveries()).toHaveLength(1);
  });

  it('escalates a customer-reply record whose payload carries no draftExternalId', async () => {
    // The old failure mode this card fixes: such a record threw inside the
    // send attempt and livelocked in pending forever. A shape defect is
    // permanent, so the record escalates without any adapter call.
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const run = makeRun(10n, ticketId);
    const idemKey = 'customer_reply:T-shape:test';
    await fencedInsert(pool, run, {
      stepId: 's1',
      idemKey,
      actionClass: 'customer_reply',
      delivery: 'at_least_once',
      payload: { body: 'no draftExternalId here' },
    });

    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: true,
        supportsReadBack: false,
        supportsDraftState: true,
        supportsStructuredFields: true,
        supportsThreading: true,
      }),
      async () => {
        throw new Error('a malformed record must never reach the adapter');
      },
      async () => ({ state: 'not_found' }),
    );

    const results = await relayPending(pool, adapter);
    expect(results.map((r) => ({ idemKey: r.idemKey, outcome: r.outcome }))).toEqual([
      { idemKey, outcome: 'malformed_escalated' },
    ]);
    expect(await runFinishedAt(idemKey)).toBeInstanceOf(Date);
    expect(adapter.sendCalls).toHaveLength(0);
    expect(adapter.performCalls).toHaveLength(0);
    expect(await outboxStatus(idemKey)).toBe('malformed');
    expect(await runState(idemKey)).toBe('escalated');

    // Terminal for the relay: a later scan finds nothing pending.
    await expect(relayPending(pool, adapter)).resolves.toEqual([]);
  });

  it('escalates a record whose payload matches no known shape at all', async () => {
    const ticketId = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPendingAction(ticketId, 10n, 'route_ticket', {
      queue: 'password-support',
    });
    // Corrupt the payload to a JSON scalar, as corrupted rows do exist.
    await pool.query("UPDATE outbox SET payload = '\"just-a-string\"'::jsonb WHERE idem_key = $1", [
      idemKey,
    ]);

    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: true,
        supportsReadBack: false,
        supportsDraftState: true,
        supportsStructuredFields: true,
        supportsThreading: true,
      }),
      async () => {
        throw new Error('a malformed record must never reach the adapter');
      },
      async () => ({ state: 'not_found' }),
    );

    const results = await relayPending(pool, adapter);
    expect(results.map((r) => ({ idemKey: r.idemKey, outcome: r.outcome }))).toEqual([
      { idemKey, outcome: 'malformed_escalated' },
    ]);
    expect(adapter.performCalls).toHaveLength(0);
    expect(await outboxStatus(idemKey)).toBe('malformed');
    expect(await runState(idemKey)).toBe('escalated');
  });

  afterAll(async () => {
    await pool.end();
  });
});
