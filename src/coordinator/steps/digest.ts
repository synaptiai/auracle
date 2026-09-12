/**
 * A document body as a fixed-length fact about what it said.
 *
 * `document` rows are updated in place on reindex, so a reader comparing
 * today's body against this can say whether the document changed since the
 * run read it. Storing the digest rather than a second copy of every fused
 * body keeps the journal from carrying the whole corpus once per run.
 */
import { createHash } from 'node:crypto';

export function digestOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
