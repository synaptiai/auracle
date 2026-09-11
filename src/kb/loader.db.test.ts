// Integration suite for the knowledge-base loader against Postgres: a real
// markdown corpus indexes into the section 4.6 document table through
// indexDocument (no second storage path) and comes back out of hybridSearch.
// Also covers loud per-file failures and both dimension-mismatch guards.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';

import { truncateLedger } from '../test-support/schema.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import type {
  EmbeddingRequest,
  EmbeddingResult,
  ModelProvider,
} from '../models/provider.js';
import { hybridSearch } from '../retriever/retriever.js';
import { DEFAULT_EMBED_MODEL, loadKbDirectory } from './loader.js';

const pool = new Pool({ connectionString: dbUrl(), max: 5 });

// src/test-support/db-global-setup.ts guarantees a reachable database before
// the workers fork: it starts a container, or probes an explicit
// DATABASE_URL and fails the run. A failure here is therefore a fault, and
// a suite that skipped itself instead would report success while proving
// nothing.
await pool.query('SELECT 1');


const DIM = 1536;
const FRESH_REVIEW_BY = '2999-01-01';

// Seeded PRNG so every run uses identical synthetic vectors (DEC-18: fixtures only).
function mulberry32(seed: number): () => number {
  let a: number = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 16), 7 | a);
    t = (t + Math.imul(t ^ (t >>> 15), 1 | t)) ^ t;
    return ((t < 0 ? ~t + 1 : t) >>> 0) / 4294967296;
  };
}

function unitVector(seed: number): number[] {
  const rand = mulberry32(seed);
  const v = Array.from({ length: DIM }, () => rand() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** Stub provider: one scripted vector per input, no network. */
class VectorStub implements ModelProvider {
  calls: EmbeddingRequest[] = [];
  constructor(private readonly vectors: number[][]) {}

  async complete(): Promise<never> {
    throw new Error('complete() is not used by the loader');
  }

  async embed(call: EmbeddingRequest & { modelVer: string }): Promise<EmbeddingResult> {
    this.calls.push({ input: call.input });
    if (this.vectors.length === 0) {
      throw new Error('VectorStub has no scripted vectors');
    }
    return {
      // Cycle the scripted vectors across inputs; a single narrow vector is
      // enough to trip the loader's dimension guard.
      vectors: call.input.map(
        (_, i) => this.vectors[i % this.vectors.length] as number[],
      ),
      costMicros: 3,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 12 },
      servedModelVer: call.modelVer,
    };
  }
}

async function writeCorpus(dir: string): Promise<void> {
  await writeFile(
    path.join(dir, 'password-reset.md'),
    [
      '---',
      'doc_id: kb-password-reset',
      'kind: document',
      'title: How to reset a password',
      'owner: support-docs',
      `review_by: ${FRESH_REVIEW_BY}`,
      '---',
      '# Password reset',
      '',
      'Open the **login page** and choose *forgot password*.',
      '- enter your email address',
      '- follow the reset link',
      '',
      'See [the account guide](https://example.test/account) for more.',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(dir, 'refund-policy.md'),
    [
      '---',
      'doc_id: kb-refund-policy',
      'kind: document',
      'title: Refund policy',
      'owner: billing-docs',
      `review_by: ${FRESH_REVIEW_BY}`,
      '---',
      'Refunds arrive within **five business days**.',
      '',
      '> Exceptions need an owner approval.',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(dir, 'billing-resolution.md'),
    [
      '---',
      'doc_id: kb-billing-resolution',
      'kind: resolution',
      'title: Double charge resolution',
      'owner: billing-docs',
      `review_by: ${FRESH_REVIEW_BY}`,
      '---',
      'A verified fix: reverse the second charge and confirm by email.',
    ].join('\n'),
    'utf8',
  );
  await writeFile(path.join(dir, 'notes.txt'), 'not markdown', 'utf8');
}

describe('kb loader against postgres', () => {
  let corpusDir: string;

  beforeEach(async () => {
    await truncateLedger(pool);
    corpusDir = await mkdtemp(path.join(tmpdir(), 'kb-corpus-'));
    await writeCorpus(corpusDir);
  });

  afterEach(async () => {
    await rm(corpusDir, { recursive: true, force: true });
    await truncateLedger(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('indexes a real markdown corpus and retrieves it through hybridSearch', async () => {
    const vectors = [unitVector(11), unitVector(22), unitVector(33)];
    const stub = new VectorStub(vectors);

    const report = await loadKbDirectory(pool, stub, corpusDir, DEFAULT_EMBED_MODEL);

    expect(report).toMatchObject({
      indexed: 3,
      skipped: 1,
      failed: 0,
      failures: [],
      costMicros: 3,
    });
    // One batched embed() call carries every document body.
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.input).toHaveLength(3);

    const rows = await pool.query<{ doc_id: string; kind: string; body: string }>(
      'SELECT doc_id, kind, body FROM document ORDER BY doc_id',
    );
    expect(rows.rows.map((r) => r.doc_id)).toEqual([
      'kb-billing-resolution',
      'kb-password-reset',
      'kb-refund-policy',
    ]);
    expect(rows.rows.find((r) => r.doc_id === 'kb-billing-resolution')?.kind).toBe(
      'canonical_resolution',
    );
    // Markdown syntax is gone from the stored body.
    expect(rows.rows.find((r) => r.doc_id === 'kb-password-reset')?.body).not.toMatch(
      /\*\*|\#|\[|https:/,
    );

    // Retrieval: the dense channel alone must rank the matching document first.
    const hits = await hybridSearch(pool, 'reset password login page', vectors[0] ?? []);
    expect(hits[0]?.docId).toBe('kb-password-reset');
    expect(hits[0]?.fresh).toBe(true);

    const lexical = await hybridSearch(pool, 'double charge reversal', vectors[2] ?? []);
    expect(lexical[0]?.docId).toBe('kb-billing-resolution');
    expect(lexical[0]?.kind).toBe('canonical_resolution');
  });

  it('fails a bad file loudly and still indexes the rest', async () => {
    await writeFile(
      path.join(corpusDir, 'broken.md'),
      [
        '---',
        'doc_id: kb-broken',
        'kind: newsletter',
        'title: Broken file',
        'owner: nobody',
        'review_by: 2999-01-01',
        '---',
        'bad kind on an otherwise complete block',
      ].join('\n'),
      'utf8',
    );
    const stub = new VectorStub([unitVector(11), unitVector(22), unitVector(33)]);

    const report = await loadKbDirectory(pool, stub, corpusDir, DEFAULT_EMBED_MODEL);

    expect(report.indexed).toBe(3);
    expect(report.failed).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('broken.md');
    expect(report.failures[0]).toContain('kind must be "document" or "resolution"');

    const count = await pool.query<{ n: string }>('SELECT count(*) AS n FROM document');
    expect(count.rows[0]?.n).toBe('3');
  });

  it('aborts when provider output does not match the column dimension', async () => {
    const stub = new VectorStub([[1, 0, 0, 0, 0, 0, 0, 0]]);
    await expect(
      loadKbDirectory(pool, stub, corpusDir, DEFAULT_EMBED_MODEL),
    ).rejects.toThrowError(/dimension mismatch.*vector\(1536\).*8 dimensions/s);
    const count = await pool.query<{ n: string }>('SELECT count(*) AS n FROM document');
    expect(count.rows[0]?.n).toBe('0');
  });

  it('pre-flights the DDL pin against a known model before any embed call', async () => {
    const stub = new VectorStub([]);
    await expect(
      loadKbDirectory(pool, stub, corpusDir, 'openai/text-embedding-3-large'),
    ).rejects.toThrowError(/dimension mismatch.*vector\(1536\).*3072/s);
    expect(stub.calls).toHaveLength(0);
  });
});
