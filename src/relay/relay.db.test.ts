// Integration suite for the outbox relay of section 4.4, proven end-to-end
// against Dockerized Postgres. Records enter through the real write path
// (fencedInsert, section 4.2) so each test exercises insert -> pending ->
// relay -> terminal status exactly as production would.
import { randomUUID } from 'node:crypto';

import { beforeConnect, failingConnects } from '../test-support/failing-pool.js';
import { truncateLedger } from '../test-support/schema.js';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AdapterCapabilityError, NothingSentError } from '../adapters/types.js';
import type {
  AdapterCapabilities,
  DeliveryState,
  EgressAdapter,
  LedgerReply,
} from '../adapters/types.js';
import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { dbUrl } from '../db/config.js';
import { fencedInsert, type FencedOutboxInput, type FencedRunInput } from '../ledger/insert.js';
import { COMPENSATION_ACTION_CLASS } from '../adapters/types.js';
import { owedKeyOf, pendingRows, relayOne, relayPending, type OwedEscalations } from './relay.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

// src/test-support/db-global-setup.ts guarantees a reachable database before
// the workers fork: it starts a container, or probes an explicit
// DATABASE_URL and fails the run. A failure here is therefore a fault, and
// a suite that skipped itself instead would report success while proving
// nothing.
await pool.query('SELECT 1');


/** Egress fake whose send and read-back behavior a test scripts per case. */
class ScriptedEgress implements EgressAdapter {
  readonly name = 'scripted';

  readonly capabilities: AdapterCapabilities;

  /** Nothing in this suite reads the declaration; the script decides. */
  readonly performs: ReadonlyMap<string, readonly string[]> = new Map();

  readonly sendCalls: Array<{ draftExternalId: string; idemKey: string }> = [];

  readonly performCalls: Array<{
    actionClass: string;
    payload: Record<string, unknown>;
    idemKey: string;
  }> = [];

  /** DEC-44: every reply this adapter was told to send from the ledger. */
  readonly ledgerSends: Array<{ reply: LedgerReply; idemKey: string }> = [];

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
    /** DEC-44: what this adapter does with a reply the ledger holds. */
    private readonly onLedgerSend?: (call: {
      reply: LedgerReply;
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
      throw new Error('no performAction behavior scripted for this test');
    }
    return this.onPerform(call);
  }

  /**
   * DEC-44: the send on an adapter whose helpdesk cannot send what it parks.
   * Recorded either way, so a case can assert that the draft path was not
   * taken even when the capability is off.
   */
  async sendLedgerReply(
    reply: LedgerReply,
    idemKey: string,
  ): Promise<{ readonly externalId: string }> {
    const call = { reply, idemKey };
    this.ledgerSends.push(call);
    if (!this.onLedgerSend) {
      throw new AdapterCapabilityError('no ledger reply was expected in this scenario');
    }
    return this.onLedgerSend(call);
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
    reply: null,
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
        supportsLedgerReply: false,
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
        supportsLedgerReply: false,
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
        supportsLedgerReply: false,
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

  // An adapter that proves nothing went out has a known delivery state, so
  // DEC-30's matrix is not asked. At most once forbids a second delivery, and
  // there was no first: the matrix would escalate this record, and a person
  // would reconcile a reply the next scan can send.
  it('leaves an at-most-once record pending when the adapter proves nothing was sent', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_most_once');
    let calls = 0;
    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: false,
        supportsReadBack: false,
        supportsDraftState: false,
        supportsStructuredFields: false,
        supportsThreading: false,
        supportsLedgerReply: false,
      }),
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new NothingSentError('the draft could not be read: connection refused', { permanent: false });
        }
        return { externalId: 'sent-on-the-second-scan' };
      },
      async () => {
        throw new Error('read-back must not run without supportsReadBack');
      },
    );

    expect(await relayPending(pool, adapter)).toEqual([
      {
        idemKey,
        outcome: 'left_pending_retry',
        sendError: 'the draft could not be read: connection refused',
      },
    ]);
    expect(await outboxStatus(idemKey)).toBe('pending');
    expect(await runState(idemKey)).toBe('queued');

    // The next scan sends it, once.
    expect(await relayPending(pool, adapter)).toEqual([{ idemKey, outcome: 'sent' }]);
    expect(await outboxStatus(idemKey)).toBe('sent');
    expect(adapter.sendCalls).toHaveLength(2);
  });

  /** What the mail adapter says of a draft with nobody to send it to. */
  const UNADDRESSED = "no SMTP send was attempted: draft '7' has no To address to send to";

  // A fault no retry clears stays out of the pending scan, or it would be
  // retried on every scan forever. It is not an unknown delivery either, so it
  // escalates under its own status. An adapter whose key makes every retry
  // safe gets the same answer: the matrix would leave its record pending.
  it.each([
    ['no idempotency key', false],
    ['an idempotency key', true],
  ])('escalates a permanent failure that sent nothing as not_sent, on an adapter with %s', async (_label, keyed) => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_least_once');
    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: keyed,
        supportsReadBack: false,
        supportsDraftState: false,
        supportsStructuredFields: false,
        supportsThreading: false,
        supportsLedgerReply: false,
      }),
      async () => {
        throw new NothingSentError(UNADDRESSED, { permanent: true });
      },
      async () => {
        throw new Error('read-back must not run without supportsReadBack');
      },
    );

    expect(await relayPending(pool, adapter)).toEqual([
      { idemKey, outcome: 'not_sent_escalated', sendError: UNADDRESSED },
    ]);
    expect(await outboxStatus(idemKey)).toBe('not_sent');
    expect(await runState(idemKey)).toBe('escalated');
    expect(await runFinishedAt(idemKey)).toBeInstanceOf(Date);
    const { rows } = await pool.query(
      `SELECT sj.result->>'reason' AS reason FROM step_journal sj
        JOIN outbox o ON o.run_id = sj.run_id
       WHERE o.idem_key = $1 AND sj.step_id = 'escalate'`,
      [idemKey],
    );
    expect(rows[0]!.reason).toBe(`not_sent: ${UNADDRESSED}`);

    // Terminal for the relay: a later scan finds nothing to send.
    expect(await relayPending(pool, adapter)).toEqual([]);
    expect(adapter.sendCalls).toHaveLength(1);
  });

  // The proof comes before the matrix, so the target is never read back for
  // a send that never reached it.
  it('never reads back a send the adapter proves sent nothing', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_least_once');
    const readBacks: string[] = [];
    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: false,
        supportsReadBack: true,
        supportsDraftState: false,
        supportsStructuredFields: false,
        supportsThreading: false,
        supportsLedgerReply: false,
      }),
      async () => {
        throw new NothingSentError('the draft could not be read', { permanent: false });
      },
      async (ref) => {
        readBacks.push(ref.idemKey);
        return { state: 'not_found' };
      },
    );

    expect(await relayPending(pool, adapter)).toEqual([
      { idemKey, outcome: 'left_pending_retry', sendError: 'the draft could not be read' },
    ]);
    expect(readBacks).toEqual([]);
  });

  // DEC-30 holds when the escalation itself cannot be written. The record is
  // still pending in the ledger, so a later scan would send it again: a blind
  // retry after a send whose outcome nobody knows. The relay keeps the
  // escalation it owes and writes it on a later scan instead of sending, however
  // many writes fail first.
  it.each([
    ['an unknown delivery', new Error('connection lost mid-send'), 'delivery_unknown', 'delivery_unknown_escalated', 'the send had already failed with'],
    ['a send that sent nothing', new NothingSentError(UNADDRESSED, { permanent: true }), 'not_sent', 'not_sent_escalated', 'the adapter had reported that nothing was sent'],
  ] as const)('writes %s it could not record on a later scan, and never sends again', async (_label, thrown, status, outcome, said) => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_most_once');
    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: false,
        supportsReadBack: false,
        supportsDraftState: false,
        supportsStructuredFields: false,
        supportsThreading: false,
        supportsLedgerReply: false,
      }),
      async () => {
        throw thrown;
      },
      async () => {
        throw new Error('read-back must not run without supportsReadBack');
      },
    );
    // The send's transaction takes the first connection and the escalation
    // the second. The owed escalation takes the third, and it fails as well.
    const flaky = failingConnects(pool, [2, 3]);
    const owed: OwedEscalations = new Map();

    await expect(relayPending(flaky, adapter, owed)).rejects.toThrow(
      `the relay owes a ${status} escalation: the ledger dropped the connection (${said}: ${thrown.message})`,
    );
    expect(await outboxStatus(idemKey)).toBe('pending');
    await expect(relayPending(flaky, adapter, owed)).rejects.toThrow(
      `the escalation the relay owes (${status}) was not written: the ledger dropped the connection (${said}: ${thrown.message})`,
    );
    expect(await outboxStatus(idemKey)).toBe('pending');
    expect(adapter.sendCalls).toHaveLength(1);

    expect(await relayPending(flaky, adapter, owed)).toEqual([
      { idemKey, outcome, sendError: thrown.message },
    ]);
    expect(await outboxStatus(idemKey)).toBe(status);
    expect(await runState(idemKey)).toBe('escalated');
    expect(adapter.sendCalls).toHaveLength(1);
    expect(owed.size).toBe(0);
  });

  // A caller that passes no map still owes the escalation: the relay keeps
  // one map per pool, so no caller can lose a debt by leaving the argument out.
  it('keeps an owed escalation for a caller that passes no map', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_least_once');
    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: false,
        supportsReadBack: false,
        supportsDraftState: false,
        supportsStructuredFields: false,
        supportsThreading: false,
        supportsLedgerReply: false,
      }),
      async () => {
        throw new Error('connection lost mid-send');
      },
      async () => {
        throw new Error('read-back must not run without supportsReadBack');
      },
    );
    const flaky = failingConnects(pool, [2]);

    await expect(relayPending(flaky, adapter)).rejects.toThrow(/the ledger dropped the connection/);
    expect(await relayPending(flaky, adapter)).toEqual([
      { idemKey, outcome: 'delivery_unknown_escalated', sendError: 'connection lost mid-send' },
    ]);
    expect(adapter.sendCalls).toHaveLength(1);
  });

  // A record can leave the pending scan another way: another relay settles
  // it. Its debt goes with it, and nothing is written.
  it('drops an owed escalation whose record another scan settled, and says so', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_least_once');
    const [row] = await pendingRows(pool);
    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: false,
        supportsReadBack: false,
        supportsDraftState: false,
        supportsStructuredFields: false,
        supportsThreading: false,
        supportsLedgerReply: false,
      }),
      async () => {
        throw new Error('a settled record must not reach the adapter');
      },
      async () => {
        throw new Error('unreachable');
      },
    );
    const debt = { status: 'delivery_unknown', reason: 'delivery_unknown: lost', sendError: 'lost' } as const;
    const owed: OwedEscalations = new Map([[owedKeyOf(row!), debt]]);
    // The other relay sent it while this one held it as pending.
    await pool.query("UPDATE outbox SET status = 'sent' WHERE idem_key = $1", [idemKey]);

    // The send this process tried is the trace an operator needs.
    expect(await relayOne(pool, adapter, row!, owed)).toEqual({ idemKey, outcome: 'already_settled', sendError: 'lost' });
    expect(await outboxStatus(idemKey)).toBe('sent');
    expect(await runState(idemKey)).toBe('queued');
    expect(owed.size).toBe(0);

    // A scan that no longer finds the record drops its debt too.
    owed.set(owedKeyOf(row!), debt);
    expect(await relayPending(pool, adapter, owed)).toEqual([]);
    expect(owed.size).toBe(0);
  });

  // Another relay settles the record between this one's failed send and its
  // escalation. Nothing is written, and the result keeps the failure: it is
  // the one trace that this process may also have delivered a copy.
  it.each([
    ['an unknown delivery', new Error('connection lost mid-send')],
    ['a send that sent nothing', new NothingSentError(UNADDRESSED, { permanent: true })],
  ] as const)('keeps the send failure when another relay settled the record before %s was escalated', async (_label, thrown) => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPending(ticket, 10n, 'at_least_once');
    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: false,
        supportsReadBack: false,
        supportsDraftState: false,
        supportsStructuredFields: false,
        supportsThreading: false,
        supportsLedgerReply: false,
      }),
      async () => {
        throw thrown;
      },
      async () => {
        throw new Error('read-back must not run without supportsReadBack');
      },
    );
    // The escalation takes the second connection. The other relay sends first.
    const racing = beforeConnect(pool, 2, () =>
      pool.query("UPDATE outbox SET status = 'sent' WHERE idem_key = $1", [idemKey]));

    expect(await relayPending(racing, adapter, new Map())).toEqual([
      { idemKey, outcome: 'already_settled', sendError: thrown.message },
    ]);
    expect(await outboxStatus(idemKey)).toBe('sent');
    expect(await runState(idemKey)).toBe('queued');
    expect(adapter.sendCalls).toHaveLength(1);
  });

  // The malformed refusal makes no adapter call, so it carries no cause.
  it('reports a malformed record another relay settled as already settled', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedPendingAction(ticket, 10n, 'customer_reply', { note: 'no draft handle' });
    const adapter = new ScriptedEgress(
      Object.freeze({
        supportsIdempotencyKey: false,
        supportsReadBack: false,
        supportsDraftState: false,
        supportsStructuredFields: false,
        supportsThreading: false,
        supportsLedgerReply: false,
      }),
      async () => {
        throw new Error('a malformed record must not reach the adapter');
      },
      async () => {
        throw new Error('unreachable');
      },
    );
    const racing = beforeConnect(pool, 1, () =>
      pool.query("UPDATE outbox SET status = 'sent' WHERE idem_key = $1", [idemKey]));

    expect(await relayPending(racing, adapter, new Map())).toEqual([{ idemKey, outcome: 'already_settled' }]);
    expect(await outboxStatus(idemKey)).toBe('sent');
    expect(await runState(idemKey)).toBe('queued');
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
        supportsLedgerReply: false,
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
        supportsLedgerReply: false,
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
        supportsLedgerReply: false,
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
    // ticket_epoch moved on, so the record leaves the pending queue unsent. The
    // check refuses a record whose run is still mid-walk, because the new owner
    // redoes the ticket — and the run it leaves behind is one an operator
    // reads, never a silent drop.
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
        supportsLedgerReply: false,
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

  // One scan, two records behind the same raised fence, and the branch keys on
  // each record's own run. The finished run's record goes out; the in-flight
  // run's record is refused and that run is moved where an operator reads it.
  // The invariant query at the end is the criterion's own sentence.
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
        supportsLedgerReply: false,
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
        supportsLedgerReply: false,
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
      reply: null,
      not_before: null,
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
        supportsLedgerReply: false,
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
        reply: null,
        not_before: null,
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
        supportsLedgerReply: false,
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
        reply: null,
        not_before: null,
      }),
    ).toEqual({ idemKey, outcome: 'already_settled' });
    expect(adapter.sendCalls).toHaveLength(0);
    // The record keeps the other scan's verdict, and its run is not moved:
    // an escalation here would report a reply that went out.
    expect(await outboxStatus(idemKey)).toBe('sent');
    expect(await runState(idemKey)).toBe('executing');
  });

  // A restart strands nothing: an approved record written before a consumer
  // restart is sent after the restart. The restart leaves the fence alone (the
  // run has finished), and even a fence another run raised does not drop the
  // record: the run completed, so its DEC-24 key and DEC-29 rule decide the
  // record, not the ticket's fence.
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
        supportsLedgerReply: false,
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
        supportsLedgerReply: false,
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
        supportsLedgerReply: false,
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
        supportsLedgerReply: false,
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
});

// DEC-44: where the target cannot send the copy it parks, what sends is the
// reply the approval recorded on the outbox row. The rest of this suite
// covers the DEC-40 draft path, which this change does not touch.
describe('DEC-44: the relay sends the reply the ledger holds', () => {
  const CAPABLE: AdapterCapabilities = Object.freeze({
    supportsIdempotencyKey: true,
    supportsReadBack: false,
    supportsDraftState: true,
    supportsStructuredFields: false,
    supportsThreading: true,
    supportsLedgerReply: true,
  });

  const LEDGER_REPLY = {
    bodyText: 'Your refund is on its way, and the ledger holds this text.',
    disclosure: 'This reply was drafted by an automated assistant.',
    provenance: {
      generatedBy: 'auracle',
      modelId: 'test/model-v1',
      promptVer: 'p-2026-01',
      generatedAt: '2026-01-02T03:04:05Z',
    },
  };

  beforeEach(async () => {
    await truncateLedger(pool);
  });

  afterEach(async () => {
    await truncateLedger(pool);
  });

  async function seedLedgerReply(
    ticketId: string,
    epoch: bigint,
    state = 'awaiting_approval',
    reply: unknown = LEDGER_REPLY,
  ): Promise<string> {
    const run = makeRun(epoch, ticketId, state);
    const idemKey = `idem:${ticketId}`;
    const result = await fencedInsert(pool, run, {
      ...replyOutbox(run, idemKey, 'at_least_once'),
      reply,
    });
    expect(result).toEqual({ outcome: 'accepted' });
    return idemKey;
  }

  /** An adapter that declares the capability and records what it is handed. */
  function capableEgress(
    onLedgerSend: (call: { reply: LedgerReply; idemKey: string }) => Promise<{
      readonly externalId: string;
    }>,
  ): ScriptedEgress {
    return new ScriptedEgress(
      CAPABLE,
      async () => {
        throw new Error('the parked copy must never be sent on this path');
      },
      async () => ({ state: 'not_found' }),
      undefined,
      onLedgerSend,
    );
  }

  it('sends the ledger text, with the disclosure and provenance the row carries', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedLedgerReply(ticket, 10n);
    const adapter = capableEgress(async () => ({ externalId: 'e-1' }));

    const results = await relayPending(pool, adapter);

    expect(results.map((r) => ({ idemKey: r.idemKey, outcome: r.outcome }))).toEqual([
      { idemKey, outcome: 'sent' },
    ]);
    // The text the ledger holds, the disclosure and the provenance, and the
    // handle that addresses the ticket (DEC-14, DEC-33).
    expect(adapter.ledgerSends).toEqual([
      {
        reply: { draftExternalId: `draft-${ticket}`, ...LEDGER_REPLY },
        idemKey,
      },
    ]);
    // The parked copy is not what sends here, and the record is not read as
    // a draft path record.
    expect(adapter.sendCalls).toEqual([]);
    expect(await outboxStatus(idemKey)).toBe('sent');
  });

  it('sets the status after the send, never before', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedLedgerReply(ticket, 10n);
    const seen: string[] = [];
    const adapter = capableEgress(async () => {
      seen.push(await outboxStatus(idemKey));
      return { externalId: 'e-1' };
    });

    await relayPending(pool, adapter);

    expect(seen).toEqual(['pending']);
  });

  it('checks the fence before it sends the ledger text (DEC-28)', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedLedgerReply(ticket, 10n, 'executing');
    await pool.query('UPDATE ticket_epoch SET epoch = 11 WHERE ticket_id = $1', [ticket]);
    const adapter = capableEgress(async () => ({ externalId: 'never' }));

    const results = await relayPending(pool, adapter);

    expect(results.map((r) => r.outcome)).toEqual(['fenced']);
    expect(adapter.ledgerSends).toEqual([]);
    expect(await outboxStatus(idemKey)).toBe('fenced');
  });

  it('escalates a record that carries no reply rather than sending anything', async () => {
    // A record written by the draft path, handed to an adapter whose helpdesk
    // cannot send the parked copy. Nothing can deliver it: the parked copy is
    // not sendable, and no text travelled with the record.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedLedgerReply(ticket, 10n, 'awaiting_approval', null);
    const adapter = capableEgress(async () => ({ externalId: 'never' }));

    const results = await relayPending(pool, adapter);

    expect(results.map((r) => ({ idemKey: r.idemKey, outcome: r.outcome }))).toEqual([
      { idemKey, outcome: 'malformed_escalated' },
    ]);
    expect(adapter.ledgerSends).toEqual([]);
    expect(adapter.sendCalls).toEqual([]);
    expect(await outboxStatus(idemKey)).toBe('malformed');
    expect(await runState(idemKey)).toBe('escalated');
  });

  it('escalates a reply that holds no disclosure rather than send it (DEC-14)', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedLedgerReply(ticket, 10n, 'awaiting_approval', {
      ...LEDGER_REPLY,
      disclosure: '',
    });
    const adapter = capableEgress(async () => ({ externalId: 'never' }));

    const results = await relayPending(pool, adapter);

    expect(results.map((r) => r.outcome)).toEqual(['malformed_escalated']);
    expect(adapter.ledgerSends).toEqual([]);
    expect(await runState(idemKey)).toBe('escalated');
  });

  // DEC-48: a reply a person wrote from scratch names no model and no prompt,
  // and carries neither key. That is a whole provenance, not a partial one,
  // and the reply reaches the customer with it.
  it('sends a reply whose provenance names a person and no model', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedLedgerReply(ticket, 10n, 'awaiting_approval', {
      ...LEDGER_REPLY,
      bodyText: 'Call the service desk, and quote your account id.',
      provenance: { generatedBy: 'person', generatedAt: '2026-09-20T00:00:00.000Z' },
    });
    const adapter = capableEgress(async () => ({ externalId: 'm-1' }));

    const results = await relayPending(pool, adapter);

    expect(results.map((r) => ({ idemKey: r.idemKey, outcome: r.outcome }))).toEqual([
      { idemKey, outcome: 'sent' },
    ]);
    expect(adapter.ledgerSends).toHaveLength(1);
    expect(adapter.ledgerSends[0]?.reply.provenance).toEqual({
      generatedBy: 'person',
      generatedAt: '2026-09-20T00:00:00.000Z',
    });
  });

  // Four shapes a reply can arrive in that no adapter can send, each refused
  // before the adapter is reached. The row is written by code that reads the
  // journal, so a shape it cannot read is a ledger one: escalating names it
  // rather than sending a message missing the part that makes it safe.
  it('escalates a reply with no text, no provenance, or a provenance missing a field', async () => {
    const shapes: readonly (readonly [string, unknown])[] = [
      ['no bodyText at all', { ...LEDGER_REPLY, bodyText: undefined }],
      ['an empty bodyText', { ...LEDGER_REPLY, bodyText: '' }],
      ['no provenance', { ...LEDGER_REPLY, provenance: undefined }],
      ['a provenance missing generatedAt', {
        ...LEDGER_REPLY,
        provenance: { ...LEDGER_REPLY.provenance, generatedAt: '' },
      }],
      // DEC-48: a provenance names the model and the prompt, or it names
      // neither. Half of a model's provenance would reach a customer saying
      // a model wrote text with no version to point at. The key-absent shapes
      // are the ones JSON can carry: an undefined value is dropped.
      ['a provenance naming a model and no prompt key', {
        ...LEDGER_REPLY,
        provenance: { ...LEDGER_REPLY.provenance, promptVer: undefined },
      }],
      ['a provenance naming a prompt and no model key', {
        ...LEDGER_REPLY,
        provenance: { ...LEDGER_REPLY.provenance, modelId: undefined },
      }],
      // And a reply with neither model key that does not name a person: no
      // writer here produces one, and it must fail loudly rather than ship
      // as an unattributed model reply (DEC-48).
      ['a provenance naming no model and no person', {
        ...LEDGER_REPLY,
        provenance: { generatedBy: 'auracle', generatedAt: '2026-01-02T03:04:05Z' },
      }],
    ];

    for (const [shape, reply] of shapes) {
      await truncateLedger(pool);
      const ticket = 'T-' + randomUUID().slice(0, 8);
      const idemKey = await seedLedgerReply(ticket, 10n, 'awaiting_approval', reply);
      const adapter = capableEgress(async () => ({ externalId: 'never' }));

      const results = await relayPending(pool, adapter);

      expect(results.map((r) => r.outcome), shape).toEqual(['malformed_escalated']);
      expect(adapter.ledgerSends, shape).toEqual([]);
      expect(await outboxStatus(idemKey), shape).toBe('malformed');
      expect(await runState(idemKey), shape).toBe('escalated');
    }
  });

  // The relay and the console answer the capability from their own
  // environments, so they can disagree. Sending the parked copy would discard
  // the text a person approved without a word, and the ledger would record
  // that text as what went out. Nothing can deliver such a record, so it
  // escalates where a person reads it.
  it('escalates a record carrying a reply the adapter cannot send', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedLedgerReply(ticket, 10n);
    const adapter = new ScriptedEgress(
      Object.freeze({ ...CAPABLE, supportsLedgerReply: false }),
      async () => ({ externalId: 'never' }),
      async () => ({ state: 'not_found' }),
    );

    const results = await relayPending(pool, adapter);

    expect(results.map((r) => ({ idemKey: r.idemKey, outcome: r.outcome }))).toEqual([
      { idemKey, outcome: 'malformed_escalated' },
    ]);
    expect(adapter.sendCalls).toEqual([]);
    expect(adapter.ledgerSends).toEqual([]);
    expect(await outboxStatus(idemKey)).toBe('malformed');
    expect(await runState(idemKey)).toBe('escalated');
  });

  it('still sends the parked draft through an adapter without the capability', async () => {
    // The same record shape, and the same adapter shape, differing only in
    // the declaration: this is the DEC-40 path, unchanged.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    await seedLedgerReply(ticket, 10n, 'awaiting_approval', null);
    const adapter = new ScriptedEgress(
      Object.freeze({ ...CAPABLE, supportsLedgerReply: false }),
      async () => ({ externalId: 'e-1' }),
      async () => ({ state: 'not_found' }),
    );

    const results = await relayPending(pool, adapter);

    expect(results.map((r) => r.outcome)).toEqual(['sent']);
    expect(adapter.sendCalls).toHaveLength(1);
    expect(adapter.ledgerSends).toEqual([]);
  });
});

describe('DEC-51: the relay and a send the ledger holds back', () => {
  /**
   * An adapter that can send the record this block seeds.
   *
   * The draft path, which is the record `replyOutbox` writes. A declaration
   * of `supportsLedgerReply` would make that record malformed instead: on
   * such an adapter a record carrying no reply is one the ledger cannot
   * send, and this block is about the hold rather than about that refusal.
   */
  const DRAFT_PATH: AdapterCapabilities = Object.freeze({
    supportsIdempotencyKey: true,
    supportsReadBack: false,
    supportsDraftState: true,
    supportsStructuredFields: false,
    supportsThreading: true,
    supportsLedgerReply: false,
  });

  beforeEach(async () => {
    await truncateLedger(pool);
  });

  afterEach(async () => {
    await truncateLedger(pool);
  });

  /** Seed one pending draft-path record with a hold ahead of it. */
  async function seedHeld(ticketId: string, holdMs: number): Promise<string> {
    const run = makeRun(10n, ticketId);
    const idemKey = `idem:${ticketId}`;
    const result = await fencedInsert(pool, run, {
      ...replyOutbox(run, idemKey, 'at_least_once'),
      holdMs,
    });
    expect(result).toEqual({ outcome: 'accepted' });
    return idemKey;
  }

  /** The scanned row for one record, as a scan would have read it. */
  async function scannedRow(idemKey: string): Promise<{
    run_id: string; step_id: string; ticket_id: string; idem_key: string;
    epoch: string; delivery: string; action_class: string; payload: unknown;
    reply: unknown; not_before: Date | null;
  }> {
    const { rows } = await pool.query(
      `SELECT o.run_id, o.step_id, r.ticket_id, o.idem_key, o.epoch, o.delivery,
              o.action_class, o.payload, o.reply, o.not_before
         FROM outbox o JOIN run r ON r.run_id = o.run_id
        WHERE o.idem_key = $1`,
      [idemKey],
    );
    return rows[0] as never;
  }

  // A connection that is not given back is a pool that empties. The
  // escalation path takes a client of its own, so a release missing from one
  // of its paths leaks one per escalation: the pool here holds ten, and this
  // walks twelve records through it. Before the fix this case did not fail —
  // it stopped, on the eleventh `connect()`, which is what the daemon would
  // do in production.
  it('gives its connection back on every escalation, so the pool does not empty', async () => {
    const keys: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const ticket = 'T-' + randomUUID().slice(0, 8);
      await seedPending(ticket, 10n, 'at_least_once', 'queued');
      keys.push(`idem:${ticket}`);
    }
    // Every record carries a payload that matches no known shape, so each one
    // takes the escalation path.
    await pool.query("UPDATE outbox SET payload = '{\"noDraftHere\": true}'::jsonb");

    const adapter = new ScriptedEgress(
      DRAFT_PATH,
      async () => { throw new Error('a malformed record must not reach the adapter'); },
      async () => { throw new Error('unreachable'); },
    );

    const results = await relayPending(pool, adapter);

    expect(results).toHaveLength(12);
    expect(results.every((one) => one.outcome === 'malformed_escalated')).toBe(true);
    // And the pool is still usable: a leaked client would leave ten of the
    // twelve escalations holding one each.
    expect(await pool.query('SELECT 1 AS ok')).toBeDefined();
  });

  it('skips a record whose moment is still ahead, and leaves it to a later scan', async () => {
    // The scan's own predicate excludes a held record. This case hands the
    // row in anyway, which is the other way it is reached: a scan that read
    // the row as ready while an approval's hold was being stamped, or a
    // second relay process whose clock is a moment behind. The send must not
    // happen, and the record must stay sendable.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedHeld(ticket, 60_000);
    const adapter = new ScriptedEgress(
      DRAFT_PATH,
      async () => { throw new Error('a held record must not reach the adapter'); },
      async () => { throw new Error('unreachable'); },
    );

    expect(await relayOne(pool, adapter, await scannedRow(idemKey)))
      .toEqual({ idemKey, outcome: 'held' });
    expect(adapter.sendCalls).toHaveLength(0);
    expect(adapter.ledgerSends).toEqual([]);
    expect(await outboxStatus(idemKey)).toBe('pending');
    // Nothing moved the run either: a skipped send leaves the run where the
    // scan found it, which for a held record is wherever it was parked.
    expect(await runState(idemKey)).toBe('queued');
  });

  it('sends the held record once its period has passed, and the scan sees it again', async () => {
    // The hold is a delay, not a refusal: the same record the case above
    // skipped is sent by the next scan after its moment.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedHeld(ticket, 30);
    const adapter = new ScriptedEgress(
      DRAFT_PATH,
      async () => ({ externalId: 'e-1' }),
      async () => ({ state: 'not_found' }),
    );

    await new Promise((resolve) => setTimeout(resolve, 60));
    const results = await relayPending(pool, adapter);

    expect(results.map((r) => r.outcome)).toEqual(['sent']);
    expect(adapter.sendCalls).toHaveLength(1);
    expect(await outboxStatus(idemKey)).toBe('sent');
  });

  // T-3: the third way the locked row can differ from the scanned one. The
  // first is a removed row (the undo did it), the second a settled status
  // (another scan did it), and this is the one the undo makes reachable: the
  // row is present and pending, and it is not the row this scan read.
  it('sends nothing when the record under the lock is not the one scanned', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedHeld(ticket, 0);
    const row = await scannedRow(idemKey);
    // The undo deleted this record and a second approval wrote a new one at
    // the same key: same run, same step, different text.
    await pool.query(
      `UPDATE outbox SET payload = jsonb_build_object('draftExternalId', 'a-different-draft')
        WHERE idem_key = $1`,
      [idemKey],
    );
    const adapter = new ScriptedEgress(
      DRAFT_PATH,
      async () => { throw new Error('a row that is not the scanned one must not reach the adapter'); },
      async () => { throw new Error('unreachable'); },
    );

    expect(await relayOne(pool, adapter, row))
      .toEqual({ idemKey, outcome: 'already_settled' });
    expect(adapter.sendCalls).toHaveLength(0);
  });

  // The same, for the fence: a re-approval at a raised epoch carries a
  // different epoch, and sending the scanned copy would send text the second
  // approval never carried.
  it('sends nothing when the record under the lock carries another epoch', async () => {
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedHeld(ticket, 0);
    const row = await scannedRow(idemKey);
    await pool.query("UPDATE outbox SET epoch = epoch + 1 WHERE idem_key = $1", [idemKey]);
    const adapter = new ScriptedEgress(
      DRAFT_PATH,
      async () => { throw new Error('a row that is not the scanned one must not reach the adapter'); },
      async () => { throw new Error('unreachable'); },
    );

    expect(await relayOne(pool, adapter, row))
      .toEqual({ idemKey, outcome: 'already_settled' });
    expect(adapter.sendCalls).toHaveLength(0);
  });

  it('sends nothing and moves nothing when the record settled under the lock', async () => {
    // Another scan sent this record between this scan's read and its locks —
    // two relay processes, or a rolling restart. The record is not pending
    // any more, and the check happens under the lock that made it so: a
    // second delivery here would be a second copy to the customer.
    const ticket = 'T-' + randomUUID().slice(0, 8);
    const idemKey = await seedHeld(ticket, 0);
    const row = await scannedRow(idemKey);
    await pool.query("UPDATE outbox SET status = 'sent' WHERE idem_key = $1", [idemKey]);
    const adapter = new ScriptedEgress(
      DRAFT_PATH,
      async () => { throw new Error('a settled record must not reach the adapter'); },
      async () => { throw new Error('unreachable'); },
    );

    expect(await relayOne(pool, adapter, row))
      .toEqual({ idemKey, outcome: 'already_settled' });
    expect(adapter.sendCalls).toHaveLength(0);
    expect(adapter.ledgerSends).toEqual([]);
    // The other scan's verdict stands, and the run it moved is not moved a
    // second time.
    expect(await outboxStatus(idemKey)).toBe('sent');
    expect(await runState(idemKey)).toBe('queued');
  });
});

// The pool closes once, after every describe in this file has run. Inside a
// describe it would close before a later describe's tests, and every
// truncate after that would fail against a pool that is already gone.
afterAll(async () => {
  await pool.end();
});
