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
}

export interface RetrievedDoc extends IndexedDoc {
  /**
   * False when `review_by` is past. A non-fresh document never reaches the
   * automatic path; it stays available for an answer that a person approves.
   */
  fresh: boolean;
}
