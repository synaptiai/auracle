// Shared types for the retriever — section 4.6, DEC-21, DEC-22, DEC-23.

/** DEC-22: only these kinds enter the index. The DDL CHECK enforces the same set. */
export type DocKind = 'document' | 'canonical_resolution';

export interface IndexedDoc {
  docId: string;
  kind: DocKind;
  title: string;
  body: string;
  /** DEC-23: who answers for this document's content. */
  owner: string;
  /** DEC-23: ISO date. Past this date the document leaves the automatic path. */
  reviewBy: string;
  /**
   * DEC-47: the products this document serves. Empty means every product,
   * which is what a document nobody scoped serves — so an absent field and
   * an empty list are the same answer, and both write `{}`.
   */
  products?: readonly string[];
}

export interface RetrievedDoc extends IndexedDoc {
  /**
   * False when `review_by` is past. Retrieval excludes such a document unless
   * a caller passes `includeStale`, and no runtime caller does (DEC-23).
   */
  fresh: boolean;
}
