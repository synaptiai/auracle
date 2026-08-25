-- Document index schema — docs/v1-architecture.md section 4.6.
-- Plain SQL applied by src/ledger/migrate.ts, which records each version in schema_version (V2 open item 6).
-- Every statement is idempotent, so re-applying this file against an applied
-- ledger is a no-op.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS document (
  doc_id     text        PRIMARY KEY,
  kind       text        NOT NULL CHECK (kind IN ('document', 'canonical_resolution')),
  title      text        NOT NULL,
  body       text        NOT NULL,
  owner      text        NOT NULL,
  review_by  date        NOT NULL,
  tsv        tsvector    GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED,
  embedding  vector(1536) NOT NULL
);

COMMENT ON TABLE document IS 'Retrieval index (section 4.6, DEC-21). Hybrid BM25 and dense retrieval over this table only.';
COMMENT ON COLUMN document.kind IS 'DEC-22: the CHECK refuses every kind except documents and canonical resolutions. Raw resolved tickets cannot enter the index, so personal data and one-time-only advice stay out of permanent storage.';
COMMENT ON COLUMN document.owner IS 'DEC-23: each indexed document declares an owner who answers for its content.';
COMMENT ON COLUMN document.review_by IS 'DEC-23: each indexed document declares a review date. A document past this date leaves the automatic path but stays available for an answer that a person approves.';
COMMENT ON COLUMN document.tsv IS 'BM25 channel: lexical ranks come from ts_rank_cd over this column. RRF uses the ranks only (DEC-21); Postgres ts_rank_cd is not true BM25, which is acceptable because no score crosses into the fusion.';
COMMENT ON COLUMN document.embedding IS 'Dense channel: cosine distance via pgvector HNSW. The dimension pins one embedding model; a change of model needs a new column and a reindex.';

CREATE INDEX IF NOT EXISTS document_tsv_idx ON document USING gin (tsv);

CREATE INDEX IF NOT EXISTS document_embedding_idx
  ON document USING hnsw (embedding vector_cosine_ops);
