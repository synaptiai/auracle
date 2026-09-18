-- The products a reviewer covers — docs/v1-architecture.md DEC-47.
--
-- DEC-47 records a product on every run. This column is what a reviewer
-- declares about their own work: the products they cover, so the queue can
-- put those cases first for them. It decides no access and filters nothing —
-- every reviewer works every case — which is why it is a preference and not
-- a grant.
--
-- NOT NULL with an empty default, as `document.products` is. Empty means the
-- reviewer declared no focus, so the queue's own order stands and nothing is
-- reordered. A reviewer added before this migration covers everything, which
-- is what an undeclared focus is.
--
-- Forward-only. The runner applies each file once, in its own transaction.

ALTER TABLE reviewer ADD COLUMN IF NOT EXISTS products text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN reviewer.products IS 'DEC-47: the products this reviewer covers, for the queue''s own order. Empty means no declared focus, so the queue is not reordered. It grants nothing: a reviewer still works every case, and the hold (DEC-46) is what reserves one.';
