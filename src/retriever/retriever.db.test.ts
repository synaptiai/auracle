// Integration suite for section 4.6 ("Retriever") against the compose
// Postgres: hybrid retrieval over tsvector and pgvector, RRF fusion,
// freshness (DEC-23), index contents (DEC-22) and the reranker gate (DEC-21).

import { truncateLedger } from '../test-support/schema.js';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dbUrl } from '../db/config.js';
import { rrfFuse } from './rrf.js';
import {
  documentsNeedingReview,
  hybridSearch,
  indexDocument,
} from './retriever.js';
import type { IndexedDoc, RetrievedDoc } from './types.js';

const pool = new Pool({ connectionString: dbUrl(), max: 10 });

// src/test-support/db-global-setup.ts guarantees a reachable database before
// the workers fork: it starts a container, or probes an explicit
// DATABASE_URL and fails the run. A failure here is therefore a fault, and
// a suite that skipped itself instead would report success while proving
// nothing.
await pool.query('SELECT 1');


const DIM = 1536;

// Seeded PRNG so every run uses identical synthetic vectors (DEC-18: fixtures only).
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

function unitVector(rand: () => number): number[] {
  const v = Array.from({ length: DIM }, () => rand() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

/** Vector near `base`: high-dim random bases are near-orthogonal, so topic membership is unambiguous. */
function near(base: number[], rand: () => number, noise: number): number[] {
  const v = base.map((x) => x + (rand() * 2 - 1) * noise);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

const FRESH_REVIEW_BY = '2999-01-01';
const STALE_REVIEW_BY = '2020-01-01';

function doc(docId: string, title: string, body: string, extra?: Partial<IndexedDoc>): IndexedDoc {
  return {
    docId,
    kind: 'document',
    title,
    body,
    owner: 'synthetic-owner',
    reviewBy: FRESH_REVIEW_BY,
    ...extra,
  };
}

describe('section 4.6 retriever', () => {
  beforeEach(async () => {
    await truncateLedger(pool);
  });

  afterEach(async () => {
    await truncateLedger(pool);
  });

  it('ranks a document that leads both channels first, ahead of single-channel leaders', async () => {
    const rand = mulberry32(42);
    const resetBase = unitVector(rand);
    const billingBase = unitVector(rand);

    // Repeated terms give 'both' a strict lexical lead over 'lex-only', so it
    // is rank 1 in each channel and must win the fuse regardless of ties.
    await indexDocument(pool, doc('both', 'password reset steps', 'password reset password reset how to complete a password reset'), resetBase);
    await indexDocument(pool, doc('lex-only', 'password reset policy details', 'policy around password reset windows'), near(billingBase, rand, 0.05));
    await indexDocument(pool, doc('vec-only', 'billing invoices and charges', 'invoice cycles for billing accounts'), billingBase);

    // The query text matches two docs lexically; the embedding sits at the
    // 'both' base, so 'both' is rank 1 in each channel and must win the fuse.
    const results = await hybridSearch(
      pool,
      'password reset',
      near(resetBase, rand, 0.01),
      { limit: 3 },
    );

    expect(results[0]?.docId).toBe('both');
    expect(results.map((d) => d.docId).sort()).toEqual(['both', 'lex-only', 'vec-only']);
  });

  it('matches exact tokens (error codes) through the lexical channel', async () => {
    const rand = mulberry32(7);
    const target = unitVector(rand);

    await indexDocument(pool, doc('code-doc', 'ERR_4471 refund failure', 'the gateway returns ERR_4471 when the refund provider rejects the card'), target);
    await indexDocument(pool, doc('other-doc', 'general refund guidance', 'refunds follow the standard policy'), near(unitVector(rand), rand, 0.05));

    const results = await hybridSearch(
      pool,
      'ERR_4471',
      near(target, rand, 0.9), // deliberately poor embedding: lexical channel must carry this
      { limit: 2 },
    );

    expect(results[0]?.docId).toBe('code-doc');
  });

  it('excludes out-of-date documents from the automatic path but keeps them for approved answers', async () => {
    const rand = mulberry32(11);
    const base = unitVector(rand);

    // Repeated terms give 'stale' a strict lexical lead over 'fresh'.
    await indexDocument(pool, doc('stale', 'legacy api keys', 'api keys api keys rotate legacy api keys using the old console', { reviewBy: STALE_REVIEW_BY }), base);
    await indexDocument(pool, doc('fresh', 'api key rotation', 'rotate api keys in the developer console'), near(base, rand, 0.3));

    const automatic = await hybridSearch(pool, 'api keys', base, { limit: 5 });
    expect(automatic.map((d) => d.docId)).toEqual(['fresh']);
    expect(automatic[0]?.fresh).toBe(true);

    const approved = await hybridSearch(pool, 'api keys', base, { limit: 5, includeStale: true });
    expect(approved[0]?.docId).toBe('stale'); // led both channels once admitted
    expect(approved[0]?.fresh).toBe(false);

    const needingReview = await documentsNeedingReview(pool);
    expect(needingReview.map((d) => d.docId)).toEqual(['stale']);
  });

  it('engages the reranker at 50+ fused candidates and stands down below', async () => {
    const rand = mulberry32(23);
    const base = unitVector(rand);
    const reverse = async (_q: string, docs: readonly { docId: string }[]) => {
      const mutable = [...docs].reverse() as RetrievedDoc[];
      return Promise.resolve(mutable);
    };
    const rerank = vi.fn(reverse);

    for (let i = 0; i < 60; i++) {
      await indexDocument(
        pool,
        doc(`bulk-${i}`, `knowledge base entry ${i}`, `entry ${i} about general product usage`),
        near(base, rand, 0.5),
      );
    }

    const engaged = await hybridSearch(pool, 'knowledge base', base, { limit: 5, rerank });
    expect(rerank).toHaveBeenCalledOnce();
    const [, passed] = rerank.mock.calls[0]!;
    expect(passed.length).toBeGreaterThanOrEqual(50);
    expect(engaged.length).toBe(5);

    rerank.mockClear();
    // Freshness shrinks the candidate pool to 5 documents — below the stand-down threshold.
    await pool.query(
      "UPDATE document SET review_by = '2020-01-01' WHERE substring(doc_id from 6)::int < 55",
    );
    const stoodDown = await hybridSearch(pool, 'knowledge base', base, { limit: 5, rerank });
    expect(rerank).not.toHaveBeenCalled();
    expect(stoodDown).toHaveLength(5);
  });

  it('refuses to index raw tickets — the CHECK enforces the DEC-22 index contents', async () => {
    await expect(
      pool.query(
        `INSERT INTO document (doc_id, kind, title, body, owner, review_by, embedding)
         VALUES ('raw-1', 'raw_ticket', 't', 'b', 'o', '2999-01-01', '[${'0,'.repeat(DIM - 1)}0]'::vector)`,
      ),
    ).rejects.toThrow(/document_kind_check/i);

    // Canonical resolutions are person-approved and therefore indexable.
    await expect(
      indexDocument(
        pool,
        doc('canon-1', 'approved resolution', 'verified fix', { kind: 'canonical_resolution' }),
        unitVector(mulberry32(99)),
      ),
    ).resolves.toBeUndefined();
  });

  it('upserts an indexed document by doc_id', async () => {
    const rand = mulberry32(31);
    const base = unitVector(rand);
    await indexDocument(pool, doc('dup', 'original title', 'original body'), base);
    await indexDocument(pool, doc('dup', 'updated title', 'updated body about refunds'), base);

    const rows = await pool.query("SELECT title FROM document WHERE doc_id = 'dup'");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.title).toBe('updated title');
  });

  it('fuses with RRF such that agreement across channels dominates any single channel', () => {
    // Pins the DEC-21 property at the fusion boundary with realistic channels:
    // a doc at rank 1 in both lists beats a doc at rank 1 in one list alone,
    // whatever that list's internal scores were (they never enter here).
    const fused = rrfFuse([
      ['agreed', 'lexOnly'],
      ['denseOnly', 'agreed'],
    ]);
    expect(fused[0]).toBe('agreed');
  });

  afterAll(async () => {
    await pool.end();
  });
});
