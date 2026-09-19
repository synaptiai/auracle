// The edits the case screen's callout makes to a reply (DEC-44).
//
// A refused claim is a sentence the judge found unsupported by the document
// it cites. The callout offers three ways out, and each one edits the reply
// the ledger holds: replace the sentence with what the cited document says,
// remove it, or write the answer the document should have carried.
//
// The three are text operations and nothing else. No model runs here, and
// nothing decides what a person meant: the console takes the document's own
// sentence, or the reviewer's own words, and puts them where the refused
// sentence stood.
//
// Every function returns null rather than guessing when the sentence it was
// given is not in the reply. A reply a reviewer has since edited may no
// longer hold it, and a caller that carried on regardless would write text
// nobody asked for.

/**
 * The sentences of one reply, in order.
 *
 * Split on a full stop, exclamation or question mark followed by whitespace.
 * That is the same rule the composer's own output obeys — it joins its
 * sentences with a single space — so a drafted reply comes back as the
 * sentences it was drafted from.
 *
 * What it cannot do: an abbreviation or a decimal inside a sentence splits
 * it. The reply is shown to a person who reads it as one text, the split
 * decides only which sentence a callout addresses, and a wrong split costs
 * one edit they can see and undo.
 */
export function sentencesOf(text: string): readonly string[] {
  return text
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** The words of a sentence, lowercased, for comparing two of them. */
function words(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

/**
 * The sentence of a document closest to what a claim said, or null.
 *
 * "Closest" is the count of words the two share, which is the whole of the
 * rule. Nothing infers meaning and no model is called: the reviewer sees the
 * sentence it picks in the editor, and edits it when it is not what they
 * meant. Null means the document shares no word with the claim at all, which
 * is the case the third button exists for.
 */
export function closestDocumentSentence(documentBody: string, claimText: string): string | null {
  const wanted = words(claimText);
  if (wanted.size === 0) return null;
  let best: string | null = null;
  let bestScore = 0;
  for (const sentence of sentencesOf(documentBody)) {
    const shared = [...words(sentence)].filter((word) => wanted.has(word)).length;
    // Strictly greater, so a tie keeps the earlier sentence: the first thing
    // the document says about the claim is what a reader would quote.
    if (shared > bestScore) {
      best = sentence;
      bestScore = shared;
    }
  }
  return best;
}

/**
 * The reply with one sentence replaced by other text, or null.
 *
 * The match is exact, and the rest of the reply is left byte for byte as it
 * was: the replacement happens where the sentence stood, so a reviewer's own
 * line breaks and spacing survive an edit to one sentence.
 */
export function withSentenceReplaced(
  text: string,
  sentence: string,
  replacement: string,
): string | null {
  const at = text.indexOf(sentence);
  if (at === -1 || replacement.trim().length === 0) return null;
  return text.slice(0, at) + replacement.trim() + text.slice(at + sentence.length);
}

/**
 * The reply without one sentence, or null.
 *
 * The neighbours close up over it: what stood before and after are joined
 * with one space, so a sentence removed from the middle of a paragraph does
 * not leave a double space or a stray line break behind.
 */
export function withoutSentence(text: string, sentence: string): string | null {
  const at = text.indexOf(sentence);
  if (at === -1) return null;
  const before = text.slice(0, at).trimEnd();
  const after = text.slice(at + sentence.length).trimStart();
  return `${before} ${after}`.trim();
}
