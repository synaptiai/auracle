// Hybrid retriever — docs/v1-architecture.md section 4.6, DEC-21, DEC-22, DEC-23.
//
// Two channels, both served by Postgres: BM25-style lexical ranks from tsvector
// and dense ranks from pgvector cosine distance. The channels mix through RRF
// on ranks only (DEC-21) — see rrf.ts. The reranker is active but stands down
// below 50 candidates — see reranker.ts.

import type { Pool } from 'pg';

import { rrfFuse } from './rrf.js';
import { applyRerank, type Rerank } from './reranker.js';
import type { DocKind, IndexedDoc, RetrievedDoc } from './types.js';

export { rrfFuse } from './rrf.js';
export { applyRerank, lexicalRerank, RERANK_MIN_CANDIDATES, type Rerank } from './reranker.js';
export type { DocKind, IndexedDoc, RetrievedDoc } from './types.js';

/** Per-channel candidate depth. Defaults to the reranker minimum so the reranker can engage. */
const DEFAULT_CHANNEL_DEPTH = 50;

export interface HybridSearchOptions {
  /** Final result count. */
  limit?: number;
  /** Candidates fetched per channel before fusion. */
  channelDepth?: number;
  /**
   * Automatic path (default): out-of-date documents are excluded (DEC-23).
   * The approval path passes true; non-fresh results come back with fresh=false.
   */
  includeStale?: boolean;
  /** DEC-21: applied when at least 50 candidates survive fusion. */
  rerank?: Rerank;
  /**
   * DEC-47: the product of the channel the run's message arrived on. The
   * filter keeps a document whose `products` holds it and every document
   * that declares none. Null — and absent, which means the same thing —
   * keeps the unscoped documents alone, so a run with no product never reads
   * another product's corpus.
   */
  product?: string | null;
}

interface DocumentRow {
  doc_id: string;
  kind: DocKind;
  title: string;
  body: string;
  owner: string;
  review_by: string;
}

/**
 * What an index write did. A document written in the console holds its id,
 * so a loader file with that id is left out and reported, never merged in.
 */
export type IndexOutcome = 'indexed' | 'held_by_console';

/**
 * Indexes one document or person-approved canonical resolution (DEC-22).
 *
 * The row is the loader's, and it is embedded. `embeddedWith` names the
 * model that made the vector. The upsert never updates a row the console
 * wrote (DEC-50): a reload would otherwise rewrite a reviewer's document.
 */
export async function indexDocument(
  pool: Pool,
  doc: IndexedDoc,
  embedding: number[],
  embeddedWith?: string,
): Promise<IndexOutcome> {
  const written = await pool.query(
    `INSERT INTO document (doc_id, kind, title, body, owner, review_by, embedding, products,
                           source, embedding_status, embedded_with)
     VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8::text[], 'loader', 'embedded', $9)
     ON CONFLICT (doc_id) DO UPDATE SET
       kind = EXCLUDED.kind,
       title = EXCLUDED.title,
       body = EXCLUDED.body,
       owner = EXCLUDED.owner,
       review_by = EXCLUDED.review_by,
       embedding = EXCLUDED.embedding,
       products = EXCLUDED.products,
       embedded_with = EXCLUDED.embedded_with
     WHERE document.source = 'loader'`,
    [
      doc.docId,
      doc.kind,
      doc.title,
      doc.body,
      doc.owner,
      doc.reviewBy,
      `[${embedding.join(',')}]`,
      // DEC-47: the products this document serves. A reindex is the whole
      // row, so the column is written like every other one — a document
      // that stops declaring a product stops being retrieved for it.
      [...(doc.products ?? [])],
      embeddedWith ?? null,
    ],
  );
  return written.rowCount === 1 ? 'indexed' : 'held_by_console';
}

/**
 * Runs both channels, fuses with RRF and applies the reranker gate.
 * Returns documents ordered best first.
 */
export async function hybridSearch(
  pool: Pool,
  query: string,
  queryEmbedding: number[],
  options: HybridSearchOptions = {},
): Promise<RetrievedDoc[]> {
  const limit = options.limit ?? 10;
  const depth = options.channelDepth ?? DEFAULT_CHANNEL_DEPTH;
  const staleFilter = options.includeStale === true ? '' : 'AND review_by >= CURRENT_DATE';
  const vectorLiteral = `[${queryEmbedding.join(',')}]`;

  // DEC-47: the unscoped documents and the run's own product's, and nothing
  // else. One predicate rather than two statements: with a null product,
  // `@> ARRAY[null]` is false and the empty branch is all that survives —
  // which is the same sentence, read for a run that arrived on an unmapped
  // channel. Verified against the database rather than assumed.
  //
  // `d.` qualifies it because the lexical channel joins the query, and both
  // channels carry the same filter: a scope applied to one of them would let
  // the other product's documents through from the channel that kept them.
  const productFilter =
    "AND (d.products = '{}'::text[] OR d.products @> ARRAY[$3]::text[])";
  // DEC-50: a document waiting for its embedding, or one whose embedding
  // failed, is invisible to both channels. The lexical channel could rank it
  // from its words alone, and a document only one channel can rank would
  // skew the fusion (DEC-21). So the same predicate sits in each query.
  const embeddedFilter = "AND d.embedding_status = 'embedded'";
  const product = options.product ?? null;

  // Lexical channel: ts_rank_cd supplies the ordering only. Its score never
  // leaves this query — the fusion consumes the rank positions (DEC-21).
  const bm25 = await pool.query<DocumentRow>(
    `SELECT d.doc_id, d.kind, d.title, d.body, d.owner,
            to_char(d.review_by, 'YYYY-MM-DD') AS review_by
     FROM document d, plainto_tsquery('english', $1) q
     WHERE d.tsv @@ q ${staleFilter} ${productFilter} ${embeddedFilter}
     ORDER BY ts_rank_cd(d.tsv, q) DESC
     LIMIT $2`,
    [query, depth, product],
  );

  const dense = await pool.query<DocumentRow>(
    `SELECT d.doc_id, d.kind, d.title, d.body, d.owner,
            to_char(d.review_by, 'YYYY-MM-DD') AS review_by
     FROM document d
     WHERE true ${staleFilter} ${productFilter} ${embeddedFilter}
     ORDER BY d.embedding <=> $1::vector
     LIMIT $2`,
    [vectorLiteral, depth, product],
  );

  const fusedIds = rrfFuse([
    bm25.rows.map((row) => row.doc_id),
    dense.rows.map((row) => row.doc_id),
  ]);

  const byId = new Map<string, RetrievedDoc>();
  for (const row of [...bm25.rows, ...dense.rows]) {
    byId.set(row.doc_id, {
      docId: row.doc_id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      owner: row.owner,
      reviewBy: row.review_by,
      fresh: isFresh(row.review_by),
    });
  }

  const candidates = fusedIds
    .map((id) => byId.get(id))
    .filter((doc): doc is RetrievedDoc => doc !== undefined);

  const ranked = await applyRerank(query, candidates, options.rerank);
  return ranked.slice(0, limit);
}

/**
 * DEC-23 abstain report: every indexed document past its review date. The
 * automatic path never sees these; a person-approved answer can.
 */
export async function documentsNeedingReview(pool: Pool): Promise<RetrievedDoc[]> {
  const rows = await pool.query<DocumentRow>(
    `SELECT doc_id, kind, title, body, owner,
            to_char(review_by, 'YYYY-MM-DD') AS review_by
     FROM document
     WHERE review_by < CURRENT_DATE
     ORDER BY review_by`,
  );
  return rows.rows.map((row) => ({
    docId: row.doc_id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    owner: row.owner,
    reviewBy: row.review_by,
    fresh: false,
  }));
}

function isFresh(reviewByIso: string): boolean {
  // review_by >= CURRENT_DATE held at query time for rows that passed the filter.
  return new Date(`${reviewByIso}T00:00:00Z`) >= startOfTodayUtc();
}

function startOfTodayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
