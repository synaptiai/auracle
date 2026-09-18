-- The product a run belongs to — docs/v1-architecture.md DEC-47.
--
-- DEC-47: "Each run records the product of the channel its message arrived
-- on. A run retrieves the documents of its product and the documents that
-- declare no product."
--
-- Two columns, written at the two moments the value exists. `intake.product`
-- is recorded at arrival, before any run does: the queue row is the only
-- place the value can live until a consumer picks the message up, and a
-- message abandoned in the queue still has to say what it was about.
-- `run.product` is copied from it when the run is filed, and it is the
-- column every later read uses — a case, a console filter, a corpus scope.
--
-- Both are nullable, and that null is a fact rather than a gap: the message
-- arrived on a channel the mapping does not name, or named none at all. The
-- rejected alternative was a product inferred from the message, and a blank
-- that read as a product named '' would be the same fault in another shape.
--
-- No constraint against the catalogue. The products are a file an operator
-- edits (products.json), so a CHECK would freeze today's list into the
-- schema and a deployment that added a product would have to migrate before
-- it could route one.
--
-- No backfill. A run recorded before this migration has no product, and
-- reads as a message whose channel the mapping did not name — which is what
-- it is.
--
-- Forward-only. The runner applies each file once, in its own transaction.

ALTER TABLE run ADD COLUMN IF NOT EXISTS product text;
ALTER TABLE intake ADD COLUMN IF NOT EXISTS product text;

COMMENT ON COLUMN run.product IS 'DEC-47: the product of the channel this run''s message arrived on, copied from the intake row when the run was filed. Null when the channel mapped to no product. A run with no product retrieves only documents that declare none.';
COMMENT ON COLUMN intake.product IS 'DEC-47: the product of the channel this message arrived on, resolved at arrival through the channel map. Carried onto the run that answers it. Null when the channel mapped to no product.';
