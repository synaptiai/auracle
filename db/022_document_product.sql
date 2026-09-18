-- The products a document serves — docs/v1-architecture.md DEC-47.
--
-- DEC-47: "A run retrieves the documents of its product and the documents
-- that declare no product." This column is how a document declares its
-- products. An empty array is the second half of that sentence: a document
-- nobody scoped serves every product, which is what a general help article
-- is.
--
-- NOT NULL with an empty default rather than nullable. Null and empty would
-- both have to mean something, and the only honest reading of null here is
-- the same as empty — so the schema says one thing, and a reader never has
-- to ask which. It also means a row written before this migration serves
-- everybody, which is true: nobody had scoped it.
--
-- No CHECK against the catalogue. The products are a file an operator edits,
-- so a constraint would freeze today's list into the schema. The loader
-- refuses a document that names a product the catalogue does not hold
-- (src/config/products.ts), because such a document is retrieved by nobody
-- and the fault would otherwise be silent.
--
-- Forward-only. The runner applies each file once, in its own transaction.

ALTER TABLE document ADD COLUMN IF NOT EXISTS products text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN document.products IS 'DEC-47: the products this document serves. An empty array means every product, which is what a document nobody scoped serves. A run retrieves its own product''s documents and the empty ones, and never another product''s.';

-- The retrieval filter reads this column on every search, in both channels
-- of the hybrid retriever: `products = '{}' OR products @> ARRAY[$3]`. The
-- containment operator is the one this index serves; a membership test
-- (`$3 = ANY (products)`) would read the same rows and use no index.
CREATE INDEX IF NOT EXISTS document_products_idx ON document USING gin (products);
