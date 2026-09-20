/**
 * Whether the ledger can store this text at all.
 *
 * Postgres `text` and `jsonb` both refuse a NUL, and a lone surrogate is not
 * a character any encoder can write: the driver replaces it with U+FFFD, so
 * the value stored is not the value that arrived. Both raise or corrupt
 * inside the write, and a console then answers a fault about a case it did
 * not touch — or, worse, sends a customer text nobody submitted.
 *
 * It lived in `src/outcomes/close.ts`, which was right while the close was
 * its only reader. Three writes now take text a person typed — the close's
 * reason, the save's reply and the rewrite's reply — and the rule is one rule
 * about the ledger, so it sits here.
 *
 * A paired surrogate is one code point above the range, so it passes: the
 * check reads code points, not code units.
 */
export function isStorableText(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point === 0 || (point >= 0xd800 && point <= 0xdfff)) return false;
  }
  return true;
}
