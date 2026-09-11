// Tests for the relay daemon loop (section 4.4): per-record error
// isolation, graceful shutdown, interval rescans, and scan-level failure
// recovery. Database-backed cases run against Dockerized Postgres and are
// skipped when it is down; the scan-failure case needs no database at all.
import { randomUUID } from 'node:crypto';

import { truncateLedger } from '../test-support/schema.js';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdapterCapabilities,
  DeliveryState,
  EgressAdapter,
} from '../adapters/types.js';
import { dbUrl } from '../db/config.js';
import { fencedInsert, type FencedOutboxInput, type FencedRunInput } from '../ledger/insert.js';
import { startRelayDaemon, type RelayDaemon, type RelayLogEntry } from './daemon.js';
import type { PendingOutboxRow } from './relay.js';

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

  readonly actionCalls: Array<{
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
    private readonly onPerform: (call: {
      actionClass: string;
      payload: Record<string, unknown>;
      idemKey: string;
    }) => Promise<{ readonly externalId: string }> = () => {
      throw new Error('no automatic action was expected in this scenario');
    },
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
    this.actionCalls.push(call);
    return this.onPerform(call);
  }

  async readBack(ref: { readonly idemKey: string }): Promise<DeliveryState> {
    return this.onReadBack(ref);
  }
}

const IDEMPOTENT: AdapterCapabilities = Object.freeze({
  supportsIdempotencyKey: true,
  supportsReadBack: false,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
});

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

async function seedPending(
  ticketId: string,
  idemKey: string,
  payload: unknown = { draftExternalId: `draft-${ticketId}` },
): Promise<void> {
  const run = makeRun(10n, ticketId);
  const outbox: FencedOutboxInput = {
    stepId: 's1',
    idemKey,
    actionClass: 'customer_reply',
    delivery: 'at_least_once',
    payload,
  };
  const result = await fencedInsert(pool, run, outbox);
  expect(result).toEqual({ outcome: 'accepted' });
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

describe('relay daemon loop', () => {
  let daemon: RelayDaemon | null = null;

  beforeEach(async () => {
    await truncateLedger(pool);
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = null;
    await truncateLedger(pool);
  });

  it('a poisoned record escalates alone and the scan still relays the next one', async () => {
    // The first record in scan order carries a customer_reply payload with
    // no draftExternalId: a shape defect, terminal for that record. The
    // daemon must log its outcome and still relay the next record in the
    // same pass — one bad record never stops the scan.
    await seedPending('T-' + randomUUID().slice(0, 8), 'idem:a-bad', { noDraftHere: true });
    const goodKey = 'idem:b-good';
    await seedPending('T-' + randomUUID().slice(0, 8), goodKey);

    const logs: RelayLogEntry[] = [];
    const adapter = new ScriptedEgress(
      IDEMPOTENT,
      async (call) => ({ externalId: `ext-${call.idemKey}` }),
      async () => {
        throw new Error('read-back must not run when the send succeeds');
      },
    );

    daemon = startRelayDaemon({ pool, adapter, intervalMs: 60_000, logger: (e) => logs.push(e) });

    await vi.waitFor(async () => expect(await outboxStatus(goodKey)).toBe('sent'), {
      timeout: 2_000,
      interval: 10,
    });
    await daemon.stop();

    expect(await outboxStatus('idem:a-bad')).toBe('malformed'); // terminal, no send attempted
    expect(await runState('idem:a-bad')).toBe('escalated');
    expect(adapter.sendCalls).toHaveLength(1); // only the good record reached the adapter
    expect(adapter.sendCalls[0]!.idemKey).toBe(goodKey);

    const relayed = logs.filter((e) => e.event === 'record_relayed');
    expect(relayed).toHaveLength(2);
    expect(relayed[0]).toMatchObject({
      event: 'record_relayed',
      idemKey: 'idem:a-bad',
      outcome: 'malformed_escalated',
    });
    expect(relayed[1]).toMatchObject({
      event: 'record_relayed',
      idemKey: goodKey,
      outcome: 'sent',
    });
    expect(logs.some((e) => e.event === 'record_failed')).toBe(false);
  });

  it('stop drains the in-flight record and skips the rest of the scan', async () => {
    // Shutdown semantics: while a send is in flight, stop must wait for
    // that record to reach its outcome, then quit without starting new
    // work — records after it in the same pass stay pending.
    const firstKey = 'idem:a-first';
    const secondKey = 'idem:b-second';
    await seedPending('T-' + randomUUID().slice(0, 8), firstKey);
    await seedPending('T-' + randomUUID().slice(0, 8), secondKey);

    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sendEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      sendEntered = resolve;
    });

    const adapter = new ScriptedEgress(
      IDEMPOTENT,
      async () => {
        sendEntered();
        await inFlight;
        return { externalId: 'ext-1' };
      },
      async () => ({ state: 'not_found' }),
    );

    const logs: RelayLogEntry[] = [];
    daemon = startRelayDaemon({ pool, adapter, intervalMs: 60_000, logger: (e) => logs.push(e) });
    await entered;

    let stopSettled = false;
    const stopping = daemon.stop().then(() => {
      stopSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopSettled).toBe(false); // stop waits while a send is in flight

    release();
    await stopping;

    expect(await outboxStatus(firstKey)).toBe('sent'); // drained to its outcome
    expect(await outboxStatus(secondKey)).toBe('pending'); // skipped, never sent
    expect(adapter.sendCalls).toHaveLength(1);
    expect(logs.at(-1)).toMatchObject({ event: 'daemon_stopped' });

    // No further scans start after stop resolved.
    const callsAfterStop = adapter.sendCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adapter.sendCalls).toHaveLength(callsAfterStop);
  });

  it('rescans on the interval until a left_pending_retry record is sent', async () => {
    // The loop must come back: an at_least_once record whose first send
    // fails with a proven not_found stays pending, and the next interval's
    // scan retries it successfully.
    const key = 'idem:a-retry';
    await seedPending('T-' + randomUUID().slice(0, 8), key);

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

    const outcomes: string[] = [];
    const logs: RelayLogEntry[] = [];
    daemon = startRelayDaemon({
      pool,
      adapter,
      intervalMs: 20,
      logger: (e) => {
        logs.push(e);
        if (e.event === 'record_relayed') outcomes.push(e.outcome);
      },
    });

    await vi.waitFor(async () => expect(await outboxStatus(key)).toBe('sent'), {
      timeout: 2_000,
      interval: 10,
    });
    await daemon.stop();

    expect(adapter.sendCalls).toHaveLength(2);
    // The structured log shows both outcomes of section 4.4 in order.
    expect(outcomes).toEqual(['left_pending_retry', 'sent']);
  });

  afterAll(async () => {
    await pool.end();
  });
});

describe('relay daemon scan-level resilience', () => {
  it('logs a failed scan, keeps running, and recovers on a later pass', async () => {
    // The pending scan itself throws (ledger unreachable). The daemon must
    // survive it and keep scanning; once the ledger answers, later passes
    // run again without the process having died.
    let ledgerUp = false;
    let scans = 0;
    const scriptedPool = {
      query: async (): Promise<{ rows: unknown[] }> => {
        scans += 1;
        if (!ledgerUp) throw new Error('database unreachable');
        return { rows: [] };
      },
    } as unknown as Pool;

    // A minimal egress fake: this scenario never reaches the adapter.
    const adapter: EgressAdapter = {
      name: 'unused',
      capabilities: Object.freeze({
        supportsIdempotencyKey: true,
        supportsReadBack: false,
        supportsDraftState: false,
        supportsStructuredFields: false,
        supportsThreading: false,
      }),
      createDraft: async () => ({ draftExternalId: 'd' }),
      sendDraft: async () => ({ externalId: 'e' }),
      readBack: async () => ({ state: 'not_found' }),
      // Never called here, but present so the fake satisfies the whole
      // port: a missing method should be a type error, not a surprise.
      performAction: async () => {
        throw new Error('performAction is not part of this scenario');
      },
    };

    const logs: RelayLogEntry[] = [];
    const daemon = startRelayDaemon({
      pool: scriptedPool,
      adapter,
      intervalMs: 5,
      logger: (e) => logs.push(e),
    });

    try {
      await vi.waitFor(() => expect(logs.some((e) => e.event === 'scan_failed')).toBe(true), {
        timeout: 2_000,
        interval: 10,
      });
      const scansAtFailure = scans;
      ledgerUp = true;
      await vi.waitFor(() => expect(scans).toBeGreaterThan(scansAtFailure + 1), {
        timeout: 2_000,
        interval: 10,
      });
      expect(logs.some((e) => e.event === 'record_failed')).toBe(false);
    } finally {
      await daemon.stop();
    }
  });

  it('a record whose relay throws fails alone; the rest of the scan continues', async () => {
    // Per-record isolation at the unit boundary: relayOne rejects for the
    // first record in scan order (its ledger writes fail). The daemon must
    // log record_failed for that record and still carry the second one to
    // `sent` inside the same pass.
    const badRun = randomUUID();
    const goodRun = randomUUID();
    const badRow: PendingOutboxRow = {
      run_id: badRun,
      step_id: 's1',
      ticket_id: 'T-bad',
      idem_key: 'idem:a-bad',
      epoch: '10',
      delivery: 'at_least_once',
      action_class: 'customer_reply',
      payload: { draftExternalId: 'draft-bad' },
    };
    const goodRow: PendingOutboxRow = {
      run_id: goodRun,
      step_id: 's1',
      ticket_id: 'T-good',
      idem_key: 'idem:b-good',
      epoch: '10',
      delivery: 'at_least_once',
      action_class: 'customer_reply',
      payload: { draftExternalId: 'draft-good' },
    };

    // Any query bound to the bad run's id fails; everything else succeeds.
    const scriptedPool = {
      query: async (text: string, values?: unknown[]): Promise<{ rows: unknown[] }> => {
        if (values !== undefined && values.includes(badRun)) {
          throw new Error('ledger write failed for the bad record');
        }
        if (values === undefined && text.includes('FROM outbox')) {
          return { rows: [badRow, goodRow] }; // the pending scan
        }
        return { rows: [] }; // epoch lookups and status updates
      },
    } as unknown as Pool;

    const adapter = new ScriptedEgress(
      IDEMPOTENT,
      async (call) => ({ externalId: `ext-${call.idemKey}` }),
      async () => {
        throw new Error('read-back must not run when the send succeeds');
      },
    );

    const logs: RelayLogEntry[] = [];
    const daemon = startRelayDaemon({
      pool: scriptedPool,
      adapter,
      intervalMs: 60_000,
      logger: (e) => logs.push(e),
    });

    try {
      await vi.waitFor(
        () =>
          expect(logs.filter((e) => e.event === 'record_relayed')).toHaveLength(1),
        { timeout: 2_000, interval: 10 },
      );
      await daemon.stop();

      expect(logs).toContainEqual(
        expect.objectContaining({ event: 'record_failed', idemKey: 'idem:a-bad' }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          event: 'record_relayed',
          idemKey: 'idem:b-good',
          outcome: 'sent',
        }),
      );
      expect(adapter.sendCalls.map((c) => c.idemKey)).toEqual(['idem:b-good']);
    } finally {
      await daemon.stop();
    }
  });
});
