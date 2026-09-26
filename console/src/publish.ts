// The publish the console's entry point hands its server (DEC-50).
//
// A delegation, like the send-back: `publishDocument` owns the transaction,
// the products, the identifier check, the review date, the DEC-46 guard and
// the re-run it asks for. The author is the reviewer the gate resolved
// against the roster before the route was reached (DEC-45). The catalogue
// travels too, so a product the file does not name is refused by the ledger's
// own rule and not by a second copy of it here.
import type { Pool } from 'pg';
import type { PublishInput, PublishOutcome } from 'auracle/ledger-read';

import { isRunId } from './approve.js';
import type { ComposerFields } from './surfaces.js';

export function publishFor(deps: {
  readonly pool: Pool;
  readonly publishDocument: (pool: Pool, input: PublishInput) => Promise<PublishOutcome>;
  readonly catalogue: readonly string[];
  readonly ledgerReply: boolean;
}): (runId: string, reviewer: string, fields: ComposerFields, shown: string) => Promise<PublishOutcome> {
  return async (runId, reviewer, fields, shown) => {
    const id = runId.trim();
    if (!isRunId(id)) throw new Error(`'${runId}' is not a run id`);
    return deps.publishDocument(deps.pool, {
      runId: id,
      title: fields.title,
      body: fields.body,
      products: fields.products,
      owner: fields.owner,
      reviewBy: fields.reviewBy,
      writtenBy: reviewer,
      catalogue: deps.catalogue,
      shown,
      ledgerReply: deps.ledgerReply,
    });
  };
}
