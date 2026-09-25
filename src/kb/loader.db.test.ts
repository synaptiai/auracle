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

import { parseProducts } from '../config/products.js';
import { dbUrl } from '../db/config.js';
import type {
  EmbeddingRequest,
  EmbeddingResult,
  ModelProvider,
} from '../models/provider.js';
import { UnreadableAnswerError } from '../models/provider.js';
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

/** The channel map and products the loader checks a document against. */
const CATALOGUE = parseProducts({
  products: [
    { id: 'aurora', label: 'Aurora' },
    { id: 'ledger', label: 'Ledger' },
  ],
  channels: { shipping: 'aurora', billing: 'ledger' },
});

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
      // DEC-47: this document serves one product. The two beside it declare
      // none, so they serve every product.
      'products: ledger',
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

    const report = await loadKbDirectory(pool, stub, corpusDir, DEFAULT_EMBED_MODEL, CATALOGUE);

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

    const rows = await pool.query<{
      doc_id: string;
      kind: string;
      body: string;
      products: string[];
    }>('SELECT doc_id, kind, body, products FROM document ORDER BY doc_id');
    expect(rows.rows.map((r) => r.doc_id)).toEqual([
      'kb-billing-resolution',
      'kb-password-reset',
      'kb-refund-policy',
    ]);
    expect(rows.rows.find((r) => r.doc_id === 'kb-billing-resolution')?.kind).toBe(
      'canonical_resolution',
    );
    // DEC-47: the product the frontmatter named, and the empty list for the
    // files that named none — which is what "serves every product" reads as.
    expect(rows.rows.map((r) => [r.doc_id, r.products])).toEqual([
      ['kb-billing-resolution', []],
      ['kb-password-reset', []],
      ['kb-refund-policy', ['ledger']],
    ]);
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

    const report = await loadKbDirectory(pool, stub, corpusDir, DEFAULT_EMBED_MODEL, CATALOGUE);

    expect(report.indexed).toBe(3);
    expect(report.failed).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('broken.md');
    expect(report.failures[0]).toContain('kind must be "document" or "resolution"');

    const count = await pool.query<{ n: string }>('SELECT count(*) AS n FROM document');
    expect(count.rows[0]?.n).toBe('3');
  });

  // DEC-47: a document declaring a product the catalogue does not hold would
  // be retrieved by nobody — the filter keeps a run's own product's documents
  // and the unscoped ones — so it is refused by name, per file, while the
  // rest of the corpus still loads.
  it('refuses a document naming a product the catalogue does not hold', async () => {
    await writeFile(
      path.join(corpusDir, 'stray-product.md'),
      [
        '---',
        'doc_id: kb-stray',
        'kind: document',
        'title: A stray product',
        'owner: support-docs',
        `review_by: ${FRESH_REVIEW_BY}`,
        'products: nobody-serves-this',
        '---',
        'body',
      ].join('\n'),
      'utf8',
    );
    const stub = new VectorStub([unitVector(11), unitVector(22), unitVector(33)]);

    const report = await loadKbDirectory(pool, stub, corpusDir, DEFAULT_EMBED_MODEL, CATALOGUE);

    expect(report.indexed).toBe(3);
    expect(report.failed).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain('stray-product.md');
    expect(report.failures[0]).toContain('nobody-serves-this');
    expect(report.failures[0]).toContain('kb-stray');
    const stored = await pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM document WHERE doc_id = 'kb-stray'",
    );
    expect(stored.rows[0]?.n).toBe('0');
  });

  // DEC-50: a document written in the console shares the table. A reload
  // leaves it as it is and reports the collision by file, while the rest of
  // the corpus still loads, and every loaded row records its model.
  it('leaves a document the console wrote as it is, and reports the file', async () => {
    await pool.query(
      `INSERT INTO document (doc_id, kind, title, body, owner, review_by, source, embedding_status)
       VALUES ('kb-refund-policy', 'document', 'written in the console', 'the console body',
               'support-docs', $1, 'console', 'pending')`,
      [FRESH_REVIEW_BY],
    );
    const stub = new VectorStub([unitVector(11), unitVector(22), unitVector(33)]);

    const report = await loadKbDirectory(pool, stub, corpusDir, DEFAULT_EMBED_MODEL, CATALOGUE);

    expect(report.indexed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.failures).toEqual([
      expect.stringMatching(/^refund-policy\.md: a document written in the console holds doc_id "kb-refund-policy"; the loader leaves it as it is$/),
    ]);
    const kept = await pool.query(
      "SELECT title, source, embedding_status FROM document WHERE doc_id = 'kb-refund-policy'",
    );
    expect(kept.rows[0]).toEqual({ title: 'written in the console', source: 'console', embedding_status: 'pending' });
    // Found before the embedding call: the reload pays for no file it will
    // not write.
    const embedded = stub.calls.flatMap((call) => call.input);
    expect(embedded).toHaveLength(2);
    expect(embedded.some((text) => text.startsWith('Refund policy'))).toBe(false);
    const loaded = await pool.query<{ embedded_with: string | null }>(
      "SELECT DISTINCT embedded_with FROM document WHERE source = 'loader'",
    );
    expect(loaded.rows).toEqual([{ embedded_with: DEFAULT_EMBED_MODEL }]);
  });

  // A console write that lands between the check before the call and the
  // write after it is still refused, by the index step, and still reported.
  it('refuses a console document written while the batch is embedded', async () => {
    class WritesMeanwhile extends VectorStub {
      override async embed(call: EmbeddingRequest & { modelVer: string }): Promise<EmbeddingResult> {
        await pool.query(
          `INSERT INTO document (doc_id, kind, title, body, owner, review_by, source, embedding_status)
           VALUES ('kb-refund-policy', 'document', 'written meanwhile', 'the console body',
                   'support-docs', $1, 'console', 'pending')`,
          [FRESH_REVIEW_BY],
        );
        return super.embed(call);
      }
    }
    const report = await loadKbDirectory(
      pool, new WritesMeanwhile([unitVector(11), unitVector(22), unitVector(33)]), corpusDir, DEFAULT_EMBED_MODEL, CATALOGUE,
    );
    expect(report.indexed).toBe(2);
    expect(report.failures).toEqual([
      expect.stringMatching(/^refund-policy\.md: a document written in the console holds doc_id "kb-refund-policy"; the loader leaves it as it is$/),
    ]);
    const kept = await pool.query("SELECT title, source FROM document WHERE doc_id = 'kb-refund-policy'");
    expect(kept.rows).toEqual([{ title: 'written meanwhile', source: 'console' }]);
  });

  // DEC-25: an answer the provider could not read was still paid for, and
  // the error that stops the run says what the run paid.
  it('counts the cost of an answer it could not read in the report it stops with', async () => {
    const unreadable: ModelProvider = {
      kind: 'stub',
      complete: async () => {
        throw new Error('complete() is not used by the loader');
      },
      embed: async () => {
        throw new UnreadableAnswerError('the answer has no usable index', 'bad-index', 5, false);
      },
    };
    await expect(loadKbDirectory(pool, unreadable, corpusDir, DEFAULT_EMBED_MODEL, CATALOGUE))
      .rejects.toThrow('the answer has no usable index (before this, 0 documents were indexed at a cost of 5 micro-dollars)');
  });

  it('names the migration when the ledger predates db/034', async () => {
    await pool.query('ALTER TABLE document RENAME COLUMN source TO source_moved');
    try {
      await expect(loadKbDirectory(pool, new VectorStub([unitVector(11)]), corpusDir, DEFAULT_EMBED_MODEL, CATALOGUE))
        .rejects.toThrow(/^the document table predates db\/034; run pnpm run db:migrate first \(/);
    } finally {
      await pool.query('ALTER TABLE document RENAME COLUMN source_moved TO source');
    }
  });

  it('aborts when provider output does not match the column dimension', async () => {
    const stub = new VectorStub([[1, 0, 0, 0, 0, 0, 0, 0]]);
    await expect(
      loadKbDirectory(pool, stub, corpusDir, DEFAULT_EMBED_MODEL, CATALOGUE),
    ).rejects.toThrowError(/dimension mismatch.*vector\(1536\).*8 dimensions/s);
    // It says what the run did before it stopped (DEC-25): nothing indexed,
    // one batch paid for at the stub's price of 3 micro-dollars.
    await expect(
      loadKbDirectory(pool, stub, corpusDir, DEFAULT_EMBED_MODEL, CATALOGUE),
    ).rejects.toThrowError(/ \(before this, 0 documents were indexed at a cost of 3 micro-dollars\)$/);
    const count = await pool.query<{ n: string }>('SELECT count(*) AS n FROM document');
    expect(count.rows[0]?.n).toBe('0');
  });

  it('pre-flights the DDL pin against a known model before any embed call', async () => {
    const stub = new VectorStub([]);
    await expect(
      loadKbDirectory(pool, stub, corpusDir, 'openai/text-embedding-3-large', CATALOGUE),
    ).rejects.toThrowError(/dimension mismatch.*vector\(1536\).*3072/s);
    expect(stub.calls).toHaveLength(0);
  });
});
