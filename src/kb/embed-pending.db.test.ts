// The consumer embeds a document written in the console (DEC-50).
//
// The console calls no model, so a document it writes waits in the ledger
// with no vector. Every consumer scan claims a few waiting documents, calls
// the model with no transaction open, and writes each vector only while its
// claim still holds. Retrieval reads embedded documents only, so a document
// is invisible until this has run.
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { processQueuedTickets } from '../coordinator/consumer.js';
import type { CoordinatorDeps } from '../coordinator/types.js';
import { dbUrl } from '../db/config.js';
import { FakeProvider } from '../models/fake.js';
import { ProviderHttpError, UnreadableAnswerError } from '../models/provider.js';
import type {
  EmbeddingRequest,
  EmbeddingResult,
  ModelProvider,
  PinnedVersions,
} from '../models/provider.js';
import { truncateLedger } from '../test-support/schema.js';
import {
  EMBED_CALL_TIMEOUT_MS,
  EMBED_DEFERRED_RETRY_SECONDS,
  EMBED_ERROR_MAX_CHARS,
  EMBED_LEASE_SECONDS,
  EMBED_PENDING_BATCH,
  EMBED_PROBE_TEXT,
  EMBED_RETRY_DELAYS_SECONDS,
  INPUT_REFUSED_STATUSES,
  MAX_EMBED_FAILURES,
  claimPendingDocuments,
  embedPendingDocuments,
} from './embed-pending.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });
await pool.query('SELECT 1');

const DIM = 1536;
const MODEL = 'synthetic-embed-v1';
const vector = (fill: number): number[] => Array.from({ length: DIM }, () => fill);

/** A document written in the console, waiting for its embedding. */
async function pending(docId: string, title = 'a title', body = 'a body'): Promise<void> {
  await pool.query(
    `INSERT INTO document (doc_id, kind, title, body, owner, review_by, products, source, embedding_status)
     VALUES ($1, 'document', $2, $3, 'synthetic-owner', '2999-01-01', '{web}', 'console', 'pending')`,
    [docId, title, body],
  );
}

interface Row {
  embedding_status: string;
  embedded: boolean;
  embedded_with: string | null;
  embedding_error: string | null;
  embedding_failures: number;
  claimed: boolean;
}

async function row(docId: string): Promise<Row> {
  const result = await pool.query<Row>(
    `SELECT embedding_status, embedding IS NOT NULL AS embedded, embedded_with, embedding_error,
            embedding_failures, embedding_claimed_until IS NOT NULL AS claimed
       FROM document WHERE doc_id = $1`,
    [docId],
  );
  return result.rows[0]!;
}

/**
 * Makes every retry delay pass, as the minutes between scans would. It moves
 * each back by the same hour, so the order the delays end in is kept.
 */
async function lapseRetryDelays(): Promise<void> {
  await pool.query(
    "UPDATE document SET embedding_retry_after = embedding_retry_after - interval '1 hour' WHERE embedding_retry_after IS NOT NULL",
  );
}

/** Seconds until the document may be claimed again, or null when it waits for nothing. */
async function retryIn(docId: string): Promise<number | null> {
  const result = await pool.query<{ seconds: number | null }>(
    `SELECT extract(epoch FROM embedding_retry_after - clock_timestamp())::float8 AS seconds
       FROM document WHERE doc_id = $1`,
    [docId],
  );
  return result.rows[0]!.seconds;
}

/** A provider that refuses a whole call when any input holds `refused`. */
class RefusingProvider implements ModelProvider {
  readonly kind = 'stub' as const;
  readonly calls: string[][] = [];
  constructor(private readonly refused: string) {}
  async complete(): Promise<never> {
    throw new Error('not a chat test');
  }
  async embed(call: EmbeddingRequest & PinnedVersions): Promise<EmbeddingResult> {
    // The probe is not a document, so it is left out of the calls.
    if (call.input[0] !== EMBED_PROBE_TEXT) this.calls.push([...call.input]);
    if (call.input.some((text) => text.includes(this.refused))) {
      throw new ProviderHttpError('OpenRouter request failed (400): maximum input length is 8192 tokens', 400);
    }
    return {
      vectors: call.input.map(() => vector(0.05)),
      costMicros: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      servedModelVer: call.modelVer,
    };
  }
}

/**
 * A provider whose every call fails: with an HTTP status when one is given,
 * as the real provider answers, and without one as a timeout does.
 */
class FailingProvider implements ModelProvider {
  readonly kind = 'stub' as const;
  /** Calls for documents; a probe is counted apart. */
  calls = 0;
  probes = 0;
  constructor(
    private readonly message: string,
    private readonly status?: number,
    /** True for a model that refuses the documents and still embeds the probe. */
    private readonly acceptsProbe = false,
  ) {}
  async complete(): Promise<never> {
    throw new Error('not a chat test');
  }
  async embed(call: EmbeddingRequest & PinnedVersions): Promise<EmbeddingResult> {
    if (call.input.length === 1 && call.input[0] === EMBED_PROBE_TEXT) {
      this.probes += 1;
      if (this.acceptsProbe) {
        return { vectors: [vector(0.09)], costMicros: 2, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, servedModelVer: call.modelVer };
      }
    } else {
      this.calls += 1;
    }
    throw this.status === undefined ? new Error(this.message) : new ProviderHttpError(this.message, this.status);
  }
}

/** The model refusing a document's input, which uses one of its attempts. */
const refusing = (message = 'the input is refused', status = 400): FailingProvider =>
  new FailingProvider(message, status, true);

/** A provider that runs a check while the model call is in flight. */
class WatchingProvider implements ModelProvider {
  readonly kind = 'stub' as const;
  constructor(private readonly during: () => Promise<void>) {}
  async complete(): Promise<never> {
    throw new Error('not a chat test');
  }
  async embed(call: EmbeddingRequest & PinnedVersions): Promise<EmbeddingResult> {
    await this.during();
    return {
      vectors: call.input.map(() => vector(0.02)),
      costMicros: 0,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      servedModelVer: call.modelVer,
    };
  }
}

describe('embedding a document written in the console', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  afterEach(async () => {
    await truncateLedger(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('embeds a waiting document and records the model', async () => {
    await pending('team-1', 'Refund window', 'Refunds are open for thirty days.');
    const provider = new FakeProvider([{ vectors: [vector(0.03)] }]);

    const report = await embedPendingDocuments(pool, provider, MODEL);

    expect(report).toEqual({ embedded: ['team-1'], retrying: [], deferred: [], failed: [], lost: [], unrecorded: [], costMicros: 0, costUnknown: false });
    expect(await row('team-1')).toEqual({
      embedding_status: 'embedded', embedded: true, embedded_with: MODEL,
      embedding_error: null, embedding_failures: 0, claimed: false,
    });
    // The text embedded is the loader's: the title, a blank line, the body.
    expect(provider.calls.map((call) => call.input)).toEqual([
      ['Refund window\n\nRefunds are open for thirty days.'],
    ]);
  });

  it('does nothing and calls no model when no document waits', async () => {
    const provider = new FailingProvider('must not be called');
    await expect(embedPendingDocuments(pool, provider, MODEL))
      .resolves.toEqual({ embedded: [], retrying: [], deferred: [], failed: [], lost: [], unrecorded: [], costMicros: 0, costUnknown: false });
    expect(provider.calls).toBe(0);
    expect(provider.probes).toBe(0);
  });

  it('claims at most one batch per scan, oldest first', async () => {
    // Ages run against the id order, so an order by id alone claims the
    // newest documents and fails here.
    const id = (i: number): string => `team-${String(i).padStart(2, '0')}`;
    for (let i = 0; i < EMBED_PENDING_BATCH + 2; i++) {
      await pending(id(i));
      await pool.query(
        "UPDATE document SET created_at = now() - make_interval(mins => $2) WHERE doc_id = $1",
        [id(i), 10 + i],
      );
    }
    const claims = await claimPendingDocuments(pool);
    expect(claims.map((claim) => claim.docId)).toEqual(['team-05', 'team-04', 'team-03', 'team-02']);
    expect(EMBED_PENDING_BATCH).toBe(4);
  });

  // The outcome of two claims at once. That neither waits for the other is
  // the next case's to prove.
  it('hands one document to one consumer when two claim at once', async () => {
    await pending('team-1');
    const [first, second] = await Promise.all([
      claimPendingDocuments(pool),
      claimPendingDocuments(pool),
    ]);
    expect([...first, ...second].map((claim) => claim.docId)).toEqual(['team-1']);
    // A claim that still holds is not handed out again.
    await expect(claimPendingDocuments(pool)).resolves.toEqual([]);
  });

  // A consumer's pool is one connection, so a claim that waited on another
  // consumer's lock would stall that consumer's whole scan.
  it('skips a document another consumer is claiming, and never waits for it', async () => {
    await pending('team-1');
    const other = await pool.connect();
    try {
      await other.query('BEGIN');
      await other.query("SELECT doc_id FROM document WHERE doc_id = 'team-1' FOR UPDATE");
      const waited = new Promise<'waited'>((resolve) => { setTimeout(() => resolve('waited'), 2_000); });
      await expect(Promise.race([claimPendingDocuments(pool), waited])).resolves.toEqual([]);
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
  });

  it('holds no lock while the model is called', async () => {
    await pending('team-1');
    const other = await pool.connect();
    try {
      const provider = new WatchingProvider(async () => {
        // The claim is committed, and the row can be locked from elsewhere.
        await other.query('BEGIN');
        const locked = await other.query(
          "SELECT embedding_claimed_until IS NOT NULL AS claimed FROM document WHERE doc_id = 'team-1' FOR UPDATE NOWAIT",
        );
        await other.query('ROLLBACK');
        expect(locked.rows).toEqual([{ claimed: true }]);
      });
      const report = await embedPendingDocuments(pool, provider, MODEL);
      expect(report.embedded).toEqual(['team-1']);
    } finally {
      other.release();
    }
  });

  it('writes nothing when its claim has passed to another consumer', async () => {
    await pending('team-1');
    const provider = new WatchingProvider(async () => {
      // The first claim lapses during the call, and another consumer claims.
      await pool.query(
        "UPDATE document SET embedding_claimed_until = clock_timestamp() - interval '1 second' WHERE doc_id = 'team-1'",
      );
      const reclaimed = await claimPendingDocuments(pool);
      expect(reclaimed.map((claim) => claim.docId)).toEqual(['team-1']);
    });

    const report = await embedPendingDocuments(pool, provider, MODEL);

    expect(report).toEqual({ embedded: [], retrying: [], deferred: [], failed: [], lost: [{ docId: 'team-1', reason: 'its claim passed to another consumer' }], unrecorded: [], costMicros: 0, costUnknown: false });
    expect(await row('team-1')).toMatchObject({ embedding_status: 'pending', embedded: false, claimed: true });
  });

  // A claim that lapsed during a call that ran to its timeout would lose the
  // failure it came back with, and the document would be retried at once.
  // A scan makes four calls at most, each held to its deadline, and the claim
  // it takes outlasts them.
  it("holds a claim longer than a scan's calls can run", async () => {
    expect(EMBED_LEASE_SECONDS * 1000).toBeGreaterThan(4 * EMBED_CALL_TIMEOUT_MS);
    await pending('team-1');
    const [claim] = await claimPendingDocuments(pool);
    const held = await pool.query<{ seconds: number }>(
      'SELECT extract(epoch FROM $1::timestamptz - clock_timestamp())::float8 AS seconds',
      [claim!.claimedUntil],
    );
    expect(held.rows[0]!.seconds).toBeGreaterThan(EMBED_LEASE_SECONDS - 5);
    expect(held.rows[0]!.seconds).toBeLessThanOrEqual(EMBED_LEASE_SECONDS);
  });

  // A lease that ran out is lost, although nobody claimed the document since:
  // the write is no longer this consumer's to make. The lease keeps the value
  // this consumer read, so only the clock can tell the write it ran out.
  it('writes nothing, vector or failure, once its claim has run out', async () => {
    const outlast = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 1_300); });
    await pending('team-1');
    const slow = new WatchingProvider(outlast);
    const written = await embedPendingDocuments(pool, slow, MODEL, 1);
    expect(written.lost).toEqual([{ docId: 'team-1', reason: 'its claim ran out during the call' }]);
    expect(await row('team-1')).toMatchObject({ embedding_status: 'pending', embedded: false, embedding_failures: 0 });

    class SlowRefusal extends FailingProvider {
      override async embed(call: EmbeddingRequest & PinnedVersions): Promise<EmbeddingResult> {
        if (call.input[0] !== EMBED_PROBE_TEXT) await outlast();
        return super.embed(call);
      }
    }
    const refused = await embedPendingDocuments(pool, new SlowRefusal('the input is refused', 400, true), MODEL, 1);
    expect(refused.lost).toEqual([{ docId: 'team-1', reason: 'its claim ran out during the call: the input is refused' }]);
    expect(await row('team-1')).toMatchObject({ embedding_status: 'pending', embedding_failures: 0, embedding_error: null });
  });

  it('refuses a lease of no length', async () => {
    for (const seconds of [0, -1, Number.NaN]) {
      await expect(claimPendingDocuments(pool, EMBED_PENDING_BATCH, seconds), String(seconds))
        .rejects.toThrow(`a claim needs a lease of more than zero seconds, got ${seconds}`);
    }
  });

  it('records no failure when its claim has passed to another consumer', async () => {
    await pending('team-1');
    class LapsingFailure extends FailingProvider {
      override async embed(call: EmbeddingRequest & PinnedVersions): Promise<EmbeddingResult> {
        // The first claim lapses during the call, and another consumer claims.
        await pool.query(
          "UPDATE document SET embedding_claimed_until = clock_timestamp() - interval '1 second' WHERE doc_id = 'team-1'",
        );
        await claimPendingDocuments(pool);
        return super.embed(call);
      }
    }

    const report = await embedPendingDocuments(pool, new LapsingFailure('the model is down'), MODEL);

    // The reason survives, so the log says why the attempt failed.
    expect(report).toEqual({
      embedded: [], retrying: [], deferred: [], failed: [],
      lost: [{ docId: 'team-1', reason: 'its claim passed to another consumer: the model is down' }],
      unrecorded: [], costMicros: 0, costUnknown: false,
    });
    // The other consumer's claim stands, and the document lost no attempt.
    expect(await row('team-1')).toMatchObject({
      embedding_status: 'pending', embedding_failures: 0, embedding_error: null, claimed: true,
    });
  });

  it('asks the model for a deadline shorter than its claim', async () => {
    expect(EMBED_CALL_TIMEOUT_MS).toBeLessThan(EMBED_LEASE_SECONDS * 1000);
    await pending('team-1');
    const provider = new FakeProvider([{ vectors: [vector(0.03)] }]);
    await embedPendingDocuments(pool, provider, MODEL);
    expect(provider.calls.map((call) => call.timeoutMs)).toEqual([EMBED_CALL_TIMEOUT_MS]);
  });

  it('reports what the call cost (DEC-25)', async () => {
    await pending('team-1');
    await pending('team-2');
    const provider = new FakeProvider([{ vectors: [vector(0.03), vector(0.04)], costMicros: 37 }]);
    const report = await embedPendingDocuments(pool, provider, MODEL);
    expect(report.costMicros).toBe(37);
  });

  // A ledger that cannot answer is no fault of the documents, so it costs
  // none of them an attempt.
  it('charges no attempt when the ledger cannot say the vector size', async () => {
    await pending('team-1');
    const provider = new FailingProvider('must not be called');
    await pool.query('ALTER TABLE document RENAME COLUMN embedding TO embedding_moved');
    try {
      await expect(embedPendingDocuments(pool, provider, MODEL)).rejects.toThrow(/no pinned dimension/);
    } finally {
      await pool.query('ALTER TABLE document RENAME COLUMN embedding_moved TO embedding');
    }
    expect(provider.calls).toBe(0);
    expect(await row('team-1')).toMatchObject({ embedding_status: 'pending', embedding_failures: 0 });
  });

  it('claims a document again once its claim lapses', async () => {
    await pending('team-1');
    await claimPendingDocuments(pool);
    await pool.query(
      "UPDATE document SET embedding_claimed_until = clock_timestamp() - interval '1 second' WHERE doc_id = 'team-1'",
    );
    const again = await claimPendingDocuments(pool);
    expect(again.map((claim) => claim.docId)).toEqual(['team-1']);
  });

  it('records a failure with its reason, and fails the document after three', async () => {
    expect(MAX_EMBED_FAILURES).toBe(3);
    await pending('team-1');
    const provider = refusing();
    const down = { docId: 'team-1', reason: 'the input is refused' };

    for (let failures = 1; failures < MAX_EMBED_FAILURES; failures++) {
      const report = await embedPendingDocuments(pool, provider, MODEL);
      // The cost is the probe's, which the refused call is not.
      expect(report).toEqual({ embedded: [], retrying: [down], deferred: [], failed: [], lost: [], unrecorded: [], costMicros: 2, costUnknown: false });
      expect(await row('team-1')).toEqual({
        embedding_status: 'pending', embedded: false, embedded_with: null,
        embedding_error: 'the input is refused', embedding_failures: failures, claimed: false,
      });
      await lapseRetryDelays();
    }
    const last = await embedPendingDocuments(pool, provider, MODEL);
    expect(last).toEqual({ embedded: [], retrying: [], deferred: [], failed: [down], lost: [], unrecorded: [], costMicros: 2, costUnknown: false });
    expect(await row('team-1')).toEqual({
      embedding_status: 'failed', embedded: false, embedded_with: null,
      embedding_error: 'the input is refused', embedding_failures: MAX_EMBED_FAILURES, claimed: false,
    });
    // A failed document waits for nothing, and is never claimed again.
    await expect(retryIn('team-1')).resolves.toBeNull();
    await expect(claimPendingDocuments(pool)).resolves.toEqual([]);
  });

  // Only a refusal of the input is the document's fault. An outage, a rate
  // limit, a key or a timeout would otherwise fail every waiting document.
  it('uses no attempt on a fault that is not the document\'s', async () => {
    expect(EMBED_DEFERRED_RETRY_SECONDS).toBe(300);
    await pending('team-1');
    const faults = [
      new FailingProvider('OpenRouter request failed (503): unavailable', 503),
      new FailingProvider('OpenRouter request failed (429): rate limited', 429),
      new FailingProvider('OpenRouter request failed (401): no such key', 401),
      new FailingProvider('OpenRouter request to /embeddings exceeded 15000ms and was aborted'),
    ];
    for (const provider of faults) {
      const report = await embedPendingDocuments(pool, provider, MODEL);
      expect(report.deferred.map((failure) => failure.docId)).toEqual(['team-1']);
      expect(await row('team-1')).toMatchObject({ embedding_status: 'pending', embedding_failures: 0 });
      const wait = await retryIn('team-1');
      expect(wait).toBeGreaterThan(295);
      expect(wait).toBeLessThanOrEqual(300);
      await lapseRetryDelays();
    }
  });

  // OpenRouter answers 400 for a model pin that names no model. The probe
  // tells that from a refused input: a model that refuses the probe too is
  // the fault, and no document pays for it.
  it('uses no attempt when the model refuses the probe as well', async () => {
    await pending('team-1');
    const badPin = new FailingProvider('OpenRouter request failed (400): Model synthetic/none does not exist', 400);
    const report = await embedPendingDocuments(pool, badPin, MODEL);
    expect(report.deferred).toEqual([{
      docId: 'team-1',
      reason: 'OpenRouter request failed (400): Model synthetic/none does not exist; '
        + 'the probe failed too: OpenRouter request failed (400): Model synthetic/none does not exist',
    }]);
    expect(badPin.probes).toBe(1);
    expect(await row('team-1')).toMatchObject({ embedding_failures: 0 });
  });

  it('probes only after a refusal, and counts the probe in the cost', async () => {
    await pending('team-1');
    const outage = new FailingProvider('unavailable', 503, true);
    await embedPendingDocuments(pool, outage, MODEL);
    expect(outage.probes).toBe(0);

    await lapseRetryDelays();
    const refused = refusing();
    const report = await embedPendingDocuments(pool, refused, MODEL);
    expect(refused.probes).toBe(1);
    expect(report.costMicros).toBe(2);
  });

  // A fault that is not a refusal can still come from one input, as a count
  // of vectors short by one does. Deferred, the batch goes alone next time,
  // and the document at fault takes its turn and no more.
  it('sends each document of a deferred batch alone, in turn', async () => {
    class ShortByOne implements ModelProvider {
      readonly kind = 'stub' as const;
      readonly calls: string[][] = [];
      async complete(): Promise<never> {
        throw new Error('not a chat test');
      }
      async embed(call: EmbeddingRequest & PinnedVersions): Promise<EmbeddingResult> {
        this.calls.push([...call.input]);
        return {
          vectors: call.input.filter((text) => !text.includes('BREAKS')).map(() => vector(0.05)),
          costMicros: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          servedModelVer: call.modelVer,
        };
      }
    }
    for (const [docId, body, minutesAgo] of [['team-a', 'BREAKS', 30], ['team-b', 'b', 20], ['team-c', 'c', 10]] as const) {
      await pending(docId, 'a title', body);
      await pool.query('UPDATE document SET created_at = now() - make_interval(mins => $2) WHERE doc_id = $1', [docId, minutesAgo]);
    }
    const provider = new ShortByOne();

    const first = await embedPendingDocuments(pool, provider, MODEL);
    expect(first.deferred.map((failure) => failure.docId)).toEqual(['team-a', 'team-b', 'team-c']);
    for (let scan = 0; scan < 3; scan++) {
      await lapseRetryDelays();
      await embedPendingDocuments(pool, provider, MODEL);
    }

    // One batch of three, then each alone, in the order their delays ended:
    // a, b, c.
    const text = (body: string): string => `a title\n\n${body}`;
    expect(provider.calls).toEqual([[text('BREAKS'), text('b'), text('c')], [text('BREAKS')], [text('b')], [text('c')]]);
    expect(await row('team-b')).toMatchObject({ embedding_status: 'embedded', embedding_failures: 0 });
    expect(await row('team-c')).toMatchObject({ embedding_status: 'embedded', embedding_failures: 0 });
    expect(await row('team-a')).toMatchObject({ embedding_status: 'pending', embedding_failures: 0 });
  });

  // A fault of the ledger while it records the first is its own outcome, and
  // what the scan already did and paid for is still reported.
  it('reports a failure the ledger could not record, and keeps the rest', async () => {
    await pending('team-retried');
    await pool.query(
      `UPDATE document SET embedding_failures = 1, created_at = now() - interval '1 hour' WHERE doc_id = 'team-retried'`,
    );
    await pending('team-fresh');
    class SecondCallBreaksLedger implements ModelProvider {
      readonly kind = 'stub' as const;
      calls = 0;
      async complete(): Promise<never> {
        throw new Error('not a chat test');
      }
      async embed(call: EmbeddingRequest & PinnedVersions): Promise<EmbeddingResult> {
        this.calls += 1;
        if (this.calls === 2) {
          await pool.query('ALTER TABLE document RENAME COLUMN embedding_error TO embedding_error_moved');
          throw new ProviderHttpError('OpenRouter request failed (503): unavailable', 503);
        }
        return {
          vectors: call.input.map(() => vector(0.06)),
          costMicros: 3,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          servedModelVer: call.modelVer,
        };
      }
    }
    let report;
    try {
      report = await embedPendingDocuments(pool, new SecondCallBreaksLedger(), MODEL);
    } finally {
      await pool.query('ALTER TABLE document RENAME COLUMN embedding_error_moved TO embedding_error');
    }
    expect(report.embedded).toEqual(['team-retried']);
    expect(report.costMicros).toBe(3);
    expect(report.unrecorded.map((failure) => failure.docId)).toEqual(['team-fresh']);
    expect(report.unrecorded[0]!.reason).toMatch(/^the ledger refused the record \(.*embedding_error.*\): OpenRouter request failed \(503\): unavailable$/);
  });

  // The ledger failing is not the vector's fault: nothing is recorded against
  // the document, and its claim runs out.
  it('records nothing against a document when the ledger fails its write', async () => {
    await pending('team-1');
    const provider = new WatchingProvider(async () => {
      await pool.query('ALTER TABLE document RENAME COLUMN title TO title_moved');
    });
    let report;
    try {
      report = await embedPendingDocuments(pool, provider, MODEL);
    } finally {
      await pool.query('ALTER TABLE document RENAME COLUMN title_moved TO title');
    }
    expect(report.unrecorded.map((failure) => failure.docId)).toEqual(['team-1']);
    expect(report.unrecorded[0]!.reason).toMatch(/^the ledger failed: .*title/);
    expect(report.deferred).toEqual([]);
    expect(await row('team-1')).toMatchObject({ embedding_status: 'pending', embedding_failures: 0, claimed: true });
  });

  // The queue waits for the scan, so every call a scan makes, the probes too,
  // carries the deadline, and a scan makes four at most.
  it('makes four calls at most, each with the deadline', async () => {
    // Three documents wait to go alone, and a scan takes one of them.
    for (const docId of ['team-retried', 'team-retried-2', 'team-retried-3']) {
      await pending(docId);
      await pool.query(
        `UPDATE document SET embedding_failures = 1, created_at = now() - interval '1 hour' WHERE doc_id = $1`,
        [docId],
      );
    }
    await pending('team-fresh');
    const deadlines: (number | undefined)[] = [];
    class TimedRefusal extends FailingProvider {
      override async embed(call: EmbeddingRequest & PinnedVersions): Promise<EmbeddingResult> {
        deadlines.push(call.timeoutMs);
        return super.embed(call);
      }
    }
    const provider = new TimedRefusal('refused', 400, true);

    const report = await embedPendingDocuments(pool, provider, MODEL);

    // Two document calls, each refused and followed by a probe.
    expect(provider.calls).toBe(2);
    expect(provider.probes).toBe(2);
    expect(deadlines).toEqual(Array.from({ length: 4 }, () => EMBED_CALL_TIMEOUT_MS));
    expect(report.retrying.map((failure) => failure.docId)).toEqual(['team-retried', 'team-fresh']);
  });

  // A 401 or a 429 is the service's answer, not the input's, even when the
  // probe that follows goes through.
  it('uses no attempt on a status outside the refusals, whatever the probe says', async () => {
    for (const status of [401, 402, 403, 404, 408, 429, 500, 503]) {
      await truncateLedger(pool);
      await pending('team-1');
      const provider = new FailingProvider('the service said no', status, true);
      const report = await embedPendingDocuments(pool, provider, MODEL);
      expect(report.deferred.map((failure) => failure.docId), String(status)).toEqual(['team-1']);
      expect(provider.probes, String(status)).toBe(0);
      expect(await row('team-1'), String(status)).toMatchObject({ embedding_failures: 0 });
    }
  });

  // DEC-25: an answer the provider could not read was still paid for.
  it('adds the cost of an answer it could not read, or says the cost is unknown', async () => {
    class Unreadable implements ModelProvider {
      readonly kind = 'stub' as const;
      constructor(private readonly costMicros: number, private readonly costUnknown: boolean) {}
      async complete(): Promise<never> {
        throw new Error('not a chat test');
      }
      async embed(): Promise<EmbeddingResult> {
        throw new UnreadableAnswerError('the answer has no usable index', 'bad-index', this.costMicros, this.costUnknown);
      }
    }
    await pending('team-1');
    const paid = await embedPendingDocuments(pool, new Unreadable(7, false), MODEL);
    expect(paid).toMatchObject({ costMicros: 7, costUnknown: false });
    expect(paid.deferred.map((failure) => failure.docId)).toEqual(['team-1']);

    await lapseRetryDelays();
    const unknown = await embedPendingDocuments(pool, new Unreadable(0, true), MODEL);
    expect(unknown).toMatchObject({ costMicros: 0, costUnknown: true });
    await lapseRetryDelays();
    const lines = await scanLog(new Unreadable(0, true));
    expect(lines).toContainEqual({ event: 'document_embedding_cost', at: expect.any(String), costMicros: 0, costUnknown: true });
  });

  it('uses an attempt on each status that refuses the input', async () => {
    expect(INPUT_REFUSED_STATUSES).toEqual([400, 413, 422]);
    for (const status of INPUT_REFUSED_STATUSES) {
      await truncateLedger(pool);
      await pending('team-1');
      const report = await embedPendingDocuments(pool, refusing('refused', status), MODEL);
      expect(report.retrying.map((failure) => failure.docId), String(status)).toEqual(['team-1']);
      expect(await row('team-1')).toMatchObject({ embedding_failures: 1 });
    }
  });

  // Consecutive scans run seconds apart, so without a delay a model outage of
  // ten seconds would use up every attempt and fail the document for good.
  it('waits a minute after the first failure and five after the second', async () => {
    expect(EMBED_RETRY_DELAYS_SECONDS).toEqual([60, 300]);
    await pending('team-1');
    const provider = refusing();

    await embedPendingDocuments(pool, provider, MODEL);
    const first = await retryIn('team-1');
    expect(first).toBeGreaterThan(55);
    expect(first).toBeLessThanOrEqual(60);
    // The next scan, straight after, claims nothing and calls no model.
    await expect(embedPendingDocuments(pool, provider, MODEL))
      .resolves.toEqual({ embedded: [], retrying: [], deferred: [], failed: [], lost: [], unrecorded: [], costMicros: 0, costUnknown: false });
    expect(provider.calls).toBe(1);

    await lapseRetryDelays();
    await embedPendingDocuments(pool, provider, MODEL);
    const second = await retryIn('team-1');
    expect(second).toBeGreaterThan(295);
    expect(second).toBeLessThanOrEqual(300);
    expect(provider.calls).toBe(2);
  });

  it('sends a document that failed before to the model alone, beside the others', async () => {
    // Ages run against the id order, as in the batch case above.
    for (const [docId, minutesAgo] of [['team-c', 30], ['team-b', 20], ['team-a', 10]] as const) {
      await pending(docId);
      await pool.query(
        'UPDATE document SET created_at = now() - make_interval(mins => $2) WHERE doc_id = $1',
        [docId, minutesAgo],
      );
    }
    // The newest has failed once, and its delay has passed.
    await pool.query(
      `UPDATE document SET embedding_failures = 1, embedding_error = 'refused',
              embedding_retry_after = clock_timestamp() - interval '1 second'
        WHERE doc_id = 'team-a'`,
    );
    const provider = new FakeProvider([{ vectors: [vector(0.01)] }, { vectors: [vector(0.02), vector(0.03)] }]);

    const report = await embedPendingDocuments(pool, provider, MODEL);

    // The retried one first and alone, then the fresh ones oldest first.
    expect(provider.calls.map((call) => call.input)).toEqual([
      ['a title\n\na body'],
      ['a title\n\na body', 'a title\n\na body'],
    ]);
    expect(report.embedded).toEqual(['team-a', 'team-c', 'team-b']);
  });

  // After an outage every waiting document has failed once. A fresh one must
  // not wait until all of them have had their turn alone.
  it('embeds a fresh document in the first scan after an outage', async () => {
    for (const docId of ['team-r1', 'team-r2', 'team-r3']) {
      await pending(docId);
      await pool.query(
        `UPDATE document SET embedding_failures = 1, embedding_error = 'the model was down',
                created_at = now() - interval '1 hour' WHERE doc_id = $1`,
        [docId],
      );
    }
    await pending('team-new');
    const provider = new FakeProvider([{ vectors: [vector(0.01)] }, { vectors: [vector(0.02)] }]);

    const report = await embedPendingDocuments(pool, provider, MODEL);

    expect(report.embedded).toEqual(['team-r1', 'team-new']);
    expect(provider.calls.map((call) => call.input?.length)).toEqual([1, 1]);
  });

  // DEC-21: a vector of the old text would rank the new one.
  it('writes nothing when the text changed during the call', async () => {
    await pending('team-1', 'Plan pause', 'A plan may be paused once a year.');
    const provider = new WatchingProvider(async () => {
      await pool.query("UPDATE document SET body = 'A plan may be paused twice a year.' WHERE doc_id = 'team-1'");
    });
    const report = await embedPendingDocuments(pool, provider, MODEL);
    expect(report.lost).toEqual([{ docId: 'team-1', reason: 'its text changed during the call' }]);
    expect(await row('team-1')).toMatchObject({ embedding_status: 'pending', embedded: false, embedding_failures: 0 });

    // The title is embedded too, so a changed title alone writes nothing.
    await truncateLedger(pool);
    await pending('team-2', 'Plan pause', 'A plan may be paused once a year.');
    const retitled = await embedPendingDocuments(pool, new WatchingProvider(async () => {
      await pool.query("UPDATE document SET title = 'Plan pause and resume' WHERE doc_id = 'team-2'");
    }), MODEL);
    expect(retitled.lost).toEqual([{ docId: 'team-2', reason: 'its text changed during the call' }]);
    expect(await row('team-2')).toMatchObject({ embedded: false });
  });

  // A consumer's pool is one connection, so a write that waited on another
  // writer's lock would stall the queue behind it.
  it('skips a row another writer holds, and never waits for it', async () => {
    await pending('team-1');
    const other = await pool.connect();
    try {
      const provider = new WatchingProvider(async () => {
        await other.query('BEGIN');
        await other.query("SELECT doc_id FROM document WHERE doc_id = 'team-1' FOR UPDATE");
      });
      const waited = new Promise<'waited'>((resolve) => { setTimeout(() => resolve('waited'), 2_000); });
      const report = await Promise.race([embedPendingDocuments(pool, provider, MODEL), waited]);
      expect(report).toEqual({ embedded: [], retrying: [], deferred: [], failed: [], lost: [{ docId: 'team-1', reason: 'another writer holds its row' }], unrecorded: [], costMicros: 0, costUnknown: false });
    } finally {
      await other.query('ROLLBACK');
      other.release();
    }
    expect(await row('team-1')).toMatchObject({ embedding_status: 'pending', embedding_failures: 0 });
  });

  // The pin, as the retrieval step and the loader record it, so the three
  // compare. A real provider serves the pinned model under a shorter id.
  it('records the pinned model, not the id the provider served', async () => {
    await pending('team-1');
    const provider = new FakeProvider([{ vectors: [vector(0.03)], servedModelVer: 'text-embedding-3-small' }]);
    await embedPendingDocuments(pool, provider, 'openai/text-embedding-3-small');
    expect(await row('team-1')).toMatchObject({ embedded_with: 'openai/text-embedding-3-small' });
  });

  it('records a vector the ledger refuses, and uses no attempt on it', async () => {
    await pending('team-1');
    await pending('team-2');
    await pool.query("UPDATE document SET created_at = now() - interval '1 minute' WHERE doc_id = 'team-1'");
    const unusable = vector(0.03);
    unusable[0] = Number.POSITIVE_INFINITY;
    const provider = new FakeProvider([{ vectors: [vector(0.02), unusable] }]);

    const report = await embedPendingDocuments(pool, provider, MODEL);

    expect(report.embedded).toEqual(['team-1']);
    expect(report.deferred.map((failure) => failure.docId)).toEqual(['team-2']);
    expect(await row('team-2')).toMatchObject({ embedding_status: 'pending', embedding_failures: 0, claimed: false });
    await expect(retryIn('team-2')).resolves.toBeGreaterThan(295);
  });

  // The provider refuses a whole call for one input it cannot take, as a real
  // one does for a body longer than its input limit.
  it('lets a document the model refuses cost another at most one attempt', async () => {
    await pending('team-long', 'Long', 'TOO LONG');
    await pool.query("UPDATE document SET created_at = now() - interval '1 minute' WHERE doc_id = 'team-long'");
    await pending('team-good', 'Plan pause', 'A plan may be paused once a year.');
    const provider = new RefusingProvider('TOO LONG');

    const reports = [];
    for (let scan = 0; scan < 6; scan++) {
      reports.push(await embedPendingDocuments(pool, provider, MODEL));
      await lapseRetryDelays();
    }

    expect(await row('team-good')).toMatchObject({ embedding_status: 'embedded', embedding_failures: 1 });
    expect(await row('team-long')).toMatchObject({ embedding_status: 'failed', embedding_failures: 3 });
    // Neither waits for a retry any more: one is embedded, the other failed.
    await expect(retryIn('team-good')).resolves.toBeNull();
    await expect(retryIn('team-long')).resolves.toBeNull();
    // One model call per scan: the first holds both, every later one a single document.
    expect(provider.calls.map((input) => input.length)).toEqual([2, 1, 1, 1]);
    expect(reports.flatMap((report) => report.embedded)).toEqual(['team-good']);
  });

  it('refuses a vector of the wrong size, as the loader does', async () => {
    await pending('team-1');
    const provider = new FakeProvider([{ vectors: [[0.1, 0.2, 0.3]] }]);

    const report = await embedPendingDocuments(pool, provider, MODEL);

    // The model pin's fault, not the document's, so it uses no attempt.
    expect(report.deferred.map((failure) => failure.docId)).toEqual(['team-1']);
    const stored = await row('team-1');
    expect(stored).toMatchObject({ embedding_status: 'pending', embedded: false, embedding_failures: 0 });
    expect(stored.embedding_error).toBe(
      `dimension mismatch: the document.embedding column holds vector(${DIM}) but ${MODEL} emits 3`
        + ' dimensions. Change the DDL (new column and reindex) or pick a matching EMBED_MODEL_VER.',
    );
  });

  // Postgres refuses a NUL in text, and a reason it refused would record
  // nothing: the document would rejoin its batch and fail it again.
  it('records a reason that holds a NUL, without the NUL', async () => {
    const nul = String.fromCharCode(0);
    await pending('team-1');
    const report = await embedPendingDocuments(pool, new FailingProvider(`bad${nul}body`, 503), MODEL);
    expect(report.deferred).toEqual([{ docId: 'team-1', reason: 'badbody' }]);
    expect(await row('team-1')).toMatchObject({ embedding_error: 'badbody', claimed: false });
  });

  it('bounds the reason it keeps, in the ledger and in the report', async () => {
    expect(EMBED_ERROR_MAX_CHARS).toBe(500);
    await pending('team-1');
    const report = await embedPendingDocuments(pool, refusing('x'.repeat(5_000)), MODEL);
    // The first EMBED_ERROR_MAX_CHARS characters, no more and no fewer.
    expect((await row('team-1')).embedding_error).toBe('x'.repeat(EMBED_ERROR_MAX_CHARS));
    expect(report.retrying).toEqual([{ docId: 'team-1', reason: 'x'.repeat(EMBED_ERROR_MAX_CHARS) }]);
  });

  // A JavaScript string counts UTF-16 units, and a character outside the
  // basic plane takes two. A cut by units could split one in half.
  it('never splits a character when it bounds the reason', async () => {
    const wide = String.fromCodePoint(0x1f600);
    await pending('team-1');
    await embedPendingDocuments(pool, refusing(wide.repeat(EMBED_ERROR_MAX_CHARS + 100)), MODEL);
    expect((await row('team-1')).embedding_error).toBe(wide.repeat(EMBED_ERROR_MAX_CHARS));
  });

  it('claims no document that is already embedded', async () => {
    await pool.query(
      `INSERT INTO document (doc_id, kind, title, body, owner, review_by, embedding)
       VALUES ('loaded', 'document', 't', 'b', 'o', '2999-01-01', $1::vector)`,
      [`[${vector(0.01).join(',')}]`],
    );
    await expect(claimPendingDocuments(pool)).resolves.toEqual([]);
  });

  // Every consumer scan embeds waiting documents, after the queue and the
  // attempts a reviewer asked for, and with the model version it retrieves
  // with, so a query vector and a document vector come from one model.
  it('is run by every consumer scan, with the embedding model it retrieves with', async () => {
    await pending('team-1');
    const provider = new FakeProvider([{ vectors: [vector(0.04)] }]);
    const deps = {
      pool, provider, embedModelVer: MODEL,
      pins: { promptVer: 'consumer-prompt-v1', modelVer: 'chat-model' },
    } as unknown as CoordinatorDeps;

    await processQueuedTickets(deps, {
      partitions: [0], intervalMs: 1,
      action: { actionClass: 'route_ticket', actionPayload: {}, delivery: 'at_most_once', isCustomerVisible: false, disclosure: 'd' },
    });

    expect(await row('team-1')).toMatchObject({ embedding_status: 'embedded', embedded_with: MODEL });
    expect(provider.calls.map((call) => call.modelVer)).toEqual([MODEL]);
  });

  // The runbook names these events and their fields, and an operator reads
  // why a document failed from them.
  it('logs what it embedded and why an attempt failed', async () => {
    await pending('team-1');
    await pending('team-2');
    await pool.query("UPDATE document SET created_at = now() - interval '1 minute' WHERE doc_id = 'team-1'");
    const lines = await scanLog(new FakeProvider([{ vectors: [vector(0.04), vector(0.05)], costMicros: 12 }]));
    expect(lines).toEqual([
      { event: 'documents_embedded', at: expect.any(String), docIds: ['team-1', 'team-2'] },
      { event: 'document_embedding_cost', at: expect.any(String), costMicros: 12, costUnknown: false },
    ]);

    await pending('team-3');
    const failed = await scanLog(refusing());
    // The probe that confirmed the refusal is paid for, and logged.
    expect(failed).toEqual([{
      event: 'documents_embedding_retrying', at: expect.any(String),
      failures: [{ docId: 'team-3', reason: 'the input is refused' }],
    }, { event: 'document_embedding_cost', at: expect.any(String), costMicros: 2, costUnknown: false }]);

    await pool.query(
      `UPDATE document SET embedding_failures = 2, embedding_retry_after = NULL WHERE doc_id = 'team-3'`,
    );
    const last = await scanLog(refusing('the input is still refused'));
    expect(last).toEqual([{
      event: 'documents_embedding_failed', at: expect.any(String),
      failures: [{ docId: 'team-3', reason: 'the input is still refused' }],
    }, { event: 'document_embedding_cost', at: expect.any(String), costMicros: 2, costUnknown: false }]);

    await pending('team-4');
    const outage = await scanLog(new FailingProvider('the service is unavailable', 503));
    expect(outage).toEqual([{
      event: 'documents_embedding_deferred', at: expect.any(String),
      failures: [{ docId: 'team-4', reason: 'the service is unavailable' }],
    }]);

    // A call whose vectors the ledger cannot hold embeds nothing, and it is
    // still paid for.
    await pending('team-5');
    const wrongSize = await scanLog(new FakeProvider([{ vectors: [[0.1, 0.2, 0.3]], costMicros: 5 }]));
    expect(wrongSize).toEqual([{
      event: 'documents_embedding_deferred', at: expect.any(String),
      failures: [{ docId: 'team-5', reason: expect.stringMatching(/^dimension mismatch/) }],
    }, { event: 'document_embedding_cost', at: expect.any(String), costMicros: 5, costUnknown: false }]);
  });

  // Each vector belongs to the document at its position in the call. Distinct
  // texts and vectors, so a reversed or repeated pairing fails here.
  it("stores each document's own vector", async () => {
    for (const [docId, minutesAgo] of [['team-a', 30], ['team-b', 20], ['team-c', 10]] as const) {
      await pending(docId, `Title ${docId}`, `Body of ${docId}.`);
      await pool.query(
        'UPDATE document SET created_at = now() - make_interval(mins => $2) WHERE doc_id = $1',
        [docId, minutesAgo],
      );
    }
    const provider = new FakeProvider([{ vectors: [vector(0.01), vector(0.02), vector(0.03)] }]);

    await embedPendingDocuments(pool, provider, MODEL);

    expect(provider.calls[0]?.input).toEqual([
      'Title team-a\n\nBody of team-a.', 'Title team-b\n\nBody of team-b.', 'Title team-c\n\nBody of team-c.',
    ]);
    const stored = await pool.query<{ doc_id: string; first: number }>(
      'SELECT doc_id, (embedding::real[])[1] AS first FROM document ORDER BY doc_id',
    );
    expect(stored.rows.map((r) => [r.doc_id, Number(r.first.toFixed(2))])).toEqual([
      ['team-a', 0.01], ['team-b', 0.02], ['team-c', 0.03],
    ]);
  });

  // The runbook names these two events as carrying the provider's message.
  it('logs a lost write and an outcome the ledger could not record', async () => {
    await pending('team-1');
    const lost = await scanLog(new WatchingProvider(async () => {
      await pool.query(
        "UPDATE document SET embedding_claimed_until = clock_timestamp() - interval '1 second' WHERE doc_id = 'team-1'",
      );
      await claimPendingDocuments(pool);
    }));
    expect(lost).toEqual([
      { event: 'documents_embedding_lost', at: expect.any(String), failures: [{ docId: 'team-1', reason: 'its claim passed to another consumer' }] },
    ]);

    await truncateLedger(pool);
    await pending('team-2');
    class BreaksTheRecord extends FailingProvider {
      override async embed(call: EmbeddingRequest & PinnedVersions): Promise<EmbeddingResult> {
        await pool.query('ALTER TABLE document RENAME COLUMN embedding_error TO embedding_error_moved');
        return super.embed(call);
      }
    }
    let unrecorded: Record<string, unknown>[];
    try {
      unrecorded = await scanLog(new BreaksTheRecord('the service is unavailable', 503));
    } finally {
      await pool.query('ALTER TABLE document RENAME COLUMN embedding_error_moved TO embedding_error');
    }
    expect(unrecorded).toEqual([{
      event: 'documents_embedding_unrecorded', at: expect.any(String),
      failures: [{ docId: 'team-2', reason: expect.stringMatching(/^the ledger refused the record \(.*embedding_error.*\): the service is unavailable$/) }],
    }]);
  });

  it('logs a fault of its own and still returns the scan', async () => {
    await pending('team-1');
    await pool.query('ALTER TABLE document RENAME COLUMN embedding TO embedding_moved');
    try {
      const lines = await scanLog(new FailingProvider('must not be called'));
      expect(lines).toEqual([{
        event: 'document_embedding_scan_failed', at: expect.any(String),
        error: expect.stringMatching(/no pinned dimension/),
      }]);
    } finally {
      await pool.query('ALTER TABLE document RENAME COLUMN embedding_moved TO embedding');
    }
  });
});

/** Runs one consumer scan with an empty queue and returns its embedding log lines. */
async function scanLog(provider: ModelProvider): Promise<Record<string, unknown>[]> {
  const deps = {
    pool, provider, embedModelVer: MODEL,
    pins: { promptVer: 'consumer-prompt-v1', modelVer: 'chat-model' },
  } as unknown as CoordinatorDeps;
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const results = await processQueuedTickets(deps, {
      partitions: [0], intervalMs: 1,
      action: { actionClass: 'route_ticket', actionPayload: {}, delivery: 'at_most_once', isCustomerVisible: false, disclosure: 'd' },
    });
    // The queue was empty, and the scan still returns its (empty) results.
    expect(results).toEqual([]);
    return spy.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter((line) => String(line['event']).includes('document'));
  } finally {
    spy.mockRestore();
  }
}
