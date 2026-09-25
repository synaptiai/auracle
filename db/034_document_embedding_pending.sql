-- A document may wait for its embedding (DEC-50).
--
-- A reviewer may write a document from a case, and the console calls no
-- model. So a document the console writes has no vector yet: a consumer
-- embeds it on a later scan. Until then retrieval must ignore it in both
-- channels, because a document only the lexical channel could rank would
-- skew the fusion (DEC-21).
--
-- So the embedding becomes nullable, and a status says whether it exists.
-- One constraint holds the two to each other: a row has a vector exactly
-- when it is embedded. The source says who wrote the row, so the loader,
-- which upserts a whole row, can leave a console document alone.
--
-- Every row before this migration came from the loader or the seeder, with a
-- vector, so the defaults describe it: source 'loader', status 'embedded'.
-- Forward-only, and safe to re-apply: each constraint is dropped by name
-- before it is added.

ALTER TABLE document ALTER COLUMN embedding DROP NOT NULL;

ALTER TABLE document ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'loader';
ALTER TABLE document ADD COLUMN IF NOT EXISTS embedding_status text NOT NULL DEFAULT 'embedded';
ALTER TABLE document ADD COLUMN IF NOT EXISTS embedding_error text;
ALTER TABLE document ADD COLUMN IF NOT EXISTS embedded_with text;
ALTER TABLE document ADD COLUMN IF NOT EXISTS embedding_claimed_until timestamptz;
ALTER TABLE document ADD COLUMN IF NOT EXISTS embedding_retry_after timestamptz;
ALTER TABLE document ADD COLUMN IF NOT EXISTS embedding_failures integer NOT NULL DEFAULT 0;
ALTER TABLE document ADD COLUMN IF NOT EXISTS embedding_deferrals integer NOT NULL DEFAULT 0;
ALTER TABLE document ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE document DROP CONSTRAINT IF EXISTS document_source_check;
ALTER TABLE document ADD CONSTRAINT document_source_check
  CHECK (source IN ('loader', 'console'));

ALTER TABLE document DROP CONSTRAINT IF EXISTS document_embedding_status_check;
ALTER TABLE document ADD CONSTRAINT document_embedding_status_check
  CHECK (embedding_status IN ('pending', 'embedded', 'failed'));

ALTER TABLE document DROP CONSTRAINT IF EXISTS document_embedding_matches_status_check;
ALTER TABLE document ADD CONSTRAINT document_embedding_matches_status_check
  CHECK ((embedding IS NOT NULL) = (embedding_status = 'embedded'));

ALTER TABLE document DROP CONSTRAINT IF EXISTS document_embedding_failures_check;
ALTER TABLE document ADD CONSTRAINT document_embedding_failures_check
  CHECK (embedding_failures >= 0);

ALTER TABLE document DROP CONSTRAINT IF EXISTS document_embedding_deferrals_check;
ALTER TABLE document ADD CONSTRAINT document_embedding_deferrals_check
  CHECK (embedding_deferrals >= 0);

COMMENT ON COLUMN document.embedding IS 'Dense channel: cosine distance via pgvector HNSW. The dimension pins one embedding model; a change of model needs a new column and a reindex. Null while a document waits for its embedding (DEC-50): embedding_status says which.';
COMMENT ON COLUMN document.source IS 'DEC-50: who wrote the row. The loader upserts whole rows, so it leaves a console row alone and reports the collision.';
COMMENT ON COLUMN document.embedding_status IS 'DEC-50: pending until a consumer embeds the document, embedded once it has a vector, failed after the consumer gave up. Retrieval reads embedded documents only, in both channels.';
COMMENT ON COLUMN document.embedding_error IS 'DEC-50: why the last attempt to embed this document failed, bounded. Null once it is embedded.';
COMMENT ON COLUMN document.embedded_with IS 'The embedding model that made the vector, so a query vector and a document vector can be seen to come from one model.';
COMMENT ON COLUMN document.embedding_claimed_until IS 'DEC-50: the lease of the consumer embedding this document. Another consumer claims it only once the lease has passed, and a write whose lease changed writes nothing.';
COMMENT ON COLUMN document.embedding_retry_after IS 'DEC-50: after a failed attempt, no consumer claims this document before this time. Null before the first failure and once the document is embedded or failed.';
COMMENT ON COLUMN document.embedding_deferrals IS 'DEC-50: how many attempts failed for a cause that is not the document''s own. They use no attempt, and a document with any goes to the model alone.';
COMMENT ON COLUMN document.embedding_failures IS 'DEC-50: how many times the model refused this document''s input. Three make it failed. A fault of the service, the key or the model pin counts none.';

-- The consumer scan reads waiting documents, oldest first, on every pass.
CREATE INDEX IF NOT EXISTS document_pending_idx
  ON document (created_at) WHERE embedding_status = 'pending';
