// Integration suite for the outbox relay of section 4.4, proven end-to-end
// against Dockerized Postgres. Records enter through the real write path
// (fencedInsert, section 4.2) so each test exercises insert -> pending ->
// relay -> terminal status exactly as production would.
import { randomUUID } from 'node:crypto';

import { truncateLedger } from '../test-support/schema.js';
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
import { relayOne, relayPending } from './relay.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

// src/test-support/db-global-setup.ts guarantees a reachable database before
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

function makeRun(epoch: bigint, ticketId: string, state = 'queued'): FencedRunInput {
  return {
    runId: randomUUID(),
    ticketId,
    partition: 0,
    epoch,
    state,
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
  state = 'queued',
): Promise<string> {
  const run = makeRun(epoch, ticketId, state);
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
    await truncateLedger(pool);
  });

  afterEach(async () => {
    await truncateLedger(pool);
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

  it('fences a record whose run is in flight, and leaves that run visible', async () => {
    // DEC-28, the second check: the lease expired between insert and send,
    // ticket_epoch moved on, so the record leaves the pending queue unsent.
    // Issue #113: the check refuses a record whose run is still mid-walk,
    // because the new owner redoes the ticket — and the run it leaves behind
    // is one an operator reads, never a silent drop.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_least_once', 'executing');
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
    expect(await runState(idemKey)).toBe('escalated');
    expect(await runFinishedAt(idemKey)).not.toBeNull();
    const { rows } = await pool.query(
      `SELECT sj.result->>'reason' AS reason FROM step_journal sj
        JOIN outbox o ON o.run_id = sj.run_id
       WHERE o.idem_key = $1 AND sj.step_id = 'escalate'`,
      [idemKey],
    );
    expect(rows[0]!.reason).toMatch(/^fenced_stale_epoch:/);
  });

  // Issue #113, criterion 6: one scan, two records behind the same raised
  // fence, and the branch keys on each record's own run. The finished run's
  // record goes out; the in-flight run's record is refused and that run is
  // moved where an operator reads it. The invariant query at the end is the
  // criterion's own sentence.
  it('refuses one record and moves only its run, in one scan', async () => {
    const finishedTicket = 'T-' + randomUUID().slice(0, 8);
    const inFlightTicket = 'T-' + randomUUID().slice(0, 8);
    const finishedKey = await seedPending(finishedTicket, 10n, 'at_least_once', 'resolved');
    const inFlightKey = await seedPending(inFlightTicket, 10n, 'at_least_once', 'executing');
    await pool.query('UPDATE ticket_epoch SET epoch = 11 WHERE ticket_id = ANY($1)', [
      [finishedTicket, inFlightTicket],
    ]);

    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: true,
        supportsReadBack: false,
        supportsDraftState: true,
        supportsStructuredFields: true,
        supportsThreading: true,
      }),
      async () => ({ externalId: 'ext-1' }),
      async () => {
        throw new Error('read-back must not run when the send succeeds');
      },
    );

    const results = await relayPending(pool, adapter);
    const byKey = new Map(results.map((result) => [result.idemKey, result.outcome]));
    expect(byKey.get(finishedKey)).toBe('sent');
    expect(byKey.get(inFlightKey)).toBe('fenced');
    expect(adapter.sendCalls.map((call) => call.idemKey)).toEqual([finishedKey]);
    expect(await runState(finishedKey)).toBe('resolved');
    expect(await runState(inFlightKey)).toBe('escalated');
    expect(await outboxStatus(inFlightKey)).toBe('fenced');

    // The criterion, as a query: no record is fenced while its run reads
    // resolved with nothing escalated.
    const violation = await pool.query(
      `SELECT 1 FROM outbox o JOIN run r ON r.run_id = o.run_id
        WHERE o.status = 'fenced' AND r.state = 'resolved'`,
    );
    expect(violation.rows).toEqual([]);
  });

  // The two shapes the scan's inner join keeps out of the daemon's way, and
  // which the check's comment therefore promised in prose alone. Both refuse
  // nothing, exactly as before the change: a record whose ticket has no fence
  // row, and a record whose run row is not there at all.
  it('sends a record whose ticket has no fence row, and one whose run is gone', async () => {
    const noFenceTicket = 'T-' + randomUUID().slice(0, 8);
    const noFenceRun = randomUUID();
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state,
                        prompt_ver, model_ver, deadline_at)
       VALUES ($1, $2, 0, 1, 'resolved', 'p1', 'm1', now() + interval '1 hour')`,
      [noFenceRun, noFenceTicket],
    );
    await pool.query(
      `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery, payload, status)
       VALUES ($1, 's1', $2, 1, 'customer_reply', 'at_least_once', $3, 'pending')`,
      [noFenceRun, 'key-no-fence', JSON.stringify({ draftExternalId: 'draft-x' })],
    );
    const orphanRun = randomUUID();
    await pool.query(
      `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery, payload, status)
       VALUES ($1, 's1', $2, 1, 'customer_reply', 'at_least_once', $3, 'pending')`,
      [orphanRun, 'key-no-run', JSON.stringify({ draftExternalId: 'draft-y' })],
    );

    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: true,
        supportsReadBack: false,
        supportsDraftState: true,
        supportsStructuredFields: true,
        supportsThreading: true,
      }),
      async () => ({ externalId: 'ext-1' }),
      async () => {
        throw new Error('read-back must not run when the send succeeds');
      },
    );

    const results = await relayPending(pool, adapter);
    const byKey = new Map(results.map((result) => [result.idemKey, result.outcome]));
    expect(byKey.get('key-no-fence')).toBe('sent');

    // The orphan never reaches a scan: `pendingRows` inner-joins `run`. So
    // this one is handed to the relay directly, and it sends, as before.
    const orphan = await relayOne(pool, adapter, {
      run_id: orphanRun,
      step_id: 's1',
      ticket_id: 'T-' + randomUUID().slice(0, 8),
      idem_key: 'key-no-run',
      epoch: '1',
      delivery: 'at_least_once',
      action_class: 'customer_reply',
      payload: { draftExternalId: 'draft-y' },
    });
    expect(orphan).toEqual({ idemKey: 'key-no-run', outcome: 'sent' });
  });

  // The refusal reaches every run that has not finished, and the parked one
  // is no exception: such a record is unreachable from this codebase, since a
  // park inserts none, and nothing approved this one (DEC-12). Handed to the
  // relay directly, because the scan never produces it.
  it('refuses a parked run\'s record too, and shows that run', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_least_once', 'awaiting_approval');
    const { rows } = await pool.query(
      'SELECT run_id FROM outbox WHERE idem_key = $1',
      [idemKey],
    );
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
        throw new Error('a refused record must not reach the adapter');
      },
      async () => {
        throw new Error('unreachable');
      },
    );

    expect(
      await relayOne(pool, adapter, {
        run_id: rows[0]!.run_id as string,
        step_id: 's1',
        ticket_id: ticket,
        idem_key: idemKey,
        epoch: '10',
        delivery: 'at_least_once',
        action_class: 'customer_reply',
        payload: { draftExternalId: `draft-${ticket}` },
      }),
    ).toEqual({ idemKey, outcome: 'fenced' });
    expect(adapter.sendCalls).toHaveLength(0);
    expect(await outboxStatus(idemKey)).toBe('fenced');
    expect(await runState(idemKey)).toBe('escalated');
  });

  it('moves no run when it is handed a record another scan resolved', async () => {
    // Two scans can hold one row as pending — two relay processes, or a
    // rolling restart — and the fence this decision rests on was read before
    // the transaction opened. The record's own write is the token: when it
    // matches nothing, the run stays as it is, because the other scan either
    // sent the record or escalated the run itself.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_least_once', 'executing');
    const { rows } = await pool.query(
      'SELECT run_id FROM outbox WHERE idem_key = $1',
      [idemKey],
    );
    const runId = rows[0]!.run_id as string;
    // The other scan sent it while this one still held it as pending.
    await pool.query("UPDATE outbox SET status = 'sent' WHERE idem_key = $1", [idemKey]);
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
        throw new Error('a resolved record must not reach the adapter');
      },
      async () => {
        throw new Error('unreachable');
      },
    );

    expect(
      await relayOne(pool, adapter, {
        run_id: runId,
        step_id: 's1',
        ticket_id: ticket,
        idem_key: idemKey,
        epoch: '10',
        delivery: 'at_least_once',
        action_class: 'customer_reply',
        payload: { draftExternalId: `draft-${ticket}` },
      }),
    ).toEqual({ idemKey, outcome: 'fenced' });
    expect(adapter.sendCalls).toHaveLength(0);
    // The record keeps the other scan's verdict, and its run is not moved:
    // an escalation here would report a reply that went out.
    expect(await outboxStatus(idemKey)).toBe('sent');
    expect(await runState(idemKey)).toBe('executing');
  });

  // Issue #113, criterion 4: an approved record written before a consumer
  // restart is sent after the restart. The restart leaves the fence alone
  // (the run has finished), and even a fence another run raised does not
  // drop the record: the run completed, so its DEC-24 key and DEC-29 rule
  // decide the record, not the ticket's fence.
  it('sends a finished run\'s record at a raised fence, exactly once', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_least_once', 'resolved');
    await pool.query('UPDATE ticket_epoch SET epoch = 11 WHERE ticket_id = $1', [ticket]);

    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: true,
        supportsReadBack: false,
        supportsDraftState: true,
        supportsStructuredFields: true,
        supportsThreading: true,
      }),
      async (call) => {
        expect(call.idemKey).toBe(idemKey);
        return { externalId: 'ext-1' };
      },
      async () => {
        throw new Error('read-back must not run when the send succeeds');
      },
    );

    expect(await relayPending(pool, adapter)).toEqual([{ idemKey, outcome: 'sent' }]);
    expect(adapter.sendCalls).toEqual([{ draftExternalId: `draft-${ticket}`, idemKey }]);
    expect(await outboxStatus(idemKey)).toBe('sent');
    expect(await runState(idemKey)).toBe('resolved');
    // A second scan finds nothing: the record left the pending set.
    expect(await relayPending(pool, adapter)).toEqual([]);
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
