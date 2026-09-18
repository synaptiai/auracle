/**
 * The reply a reviewer read, as a value an approval can compare (DEC-46).
 *
 * The console draws a case from the reply the ledger parked, and puts the
 * digest of that text in the approval form. `approveRun` recomputes it under
 * the run's row lock, so a reply rewritten after the reviewer read it is
 * refused instead of approved as shown — and the console can say which of the
 * two changed.
 *
 * A digest rather than the text itself. The form carries a fixed-size token,
 * the ledger stores nothing new, and the comparison is of two hashes of the
 * same text rather than of one value a caller supplied. It proves no
 * authenticity and needs none: the answer it feeds is yes or no about the
 * text the ledger holds, so a forged digest refuses an approval and nothing
 * else.
 *
 * One definition, imported by the console that renders the form and by the
 * approval that checks it. The two must agree byte for byte on the text, and
 * two implementations of that agreement would eventually disagree.
 */
import { createHash } from 'node:crypto';

/** The digest of a reply's text, as the approval form carries it. */
export function replyDigest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
