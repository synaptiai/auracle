/**
 * Comparing the reply the ledger holds with the copy the helpdesk holds
 * (DEC-44).
 *
 * A person may still edit the copy in the helpdesk after the park. The design
 * refuses to discard that edit in silence, so every approval path on an
 * adapter whose helpdesk cannot send the copy refuses when the two texts
 * differ, and shows both.
 *
 * The comparison is normalised, and it has to be. The two sides come from
 * different places: the ledger holds the reply alone, and an adapter with no
 * structured field wraps the reply with a disclosure and a provenance trailer
 * before posting it. Comparing them raw would refuse every approval whose
 * channel rewraps a line, which is every approval, and the refusal would be
 * about this system's own decoration rather than about a person's edit.
 *
 * What it does not catch: a copy whose difference lives entirely after a
 * `-- ` separator line, because both sides are cut there (see `replyPartOf`)
 * and the remainder is judged equal. Nothing in such a channel records where
 * the trailer began, so the alternative is refusing every reply that happens
 * to contain a signature line.
 */
import { replyPartOf } from '../adapters/reply-text.js';

/**
 * One text, as the comparison reads it: the reply alone, with every run of
 * whitespace collapsed to one space and the ends trimmed.
 *
 * Collapsing whitespace is what lets a channel that rewraps a paragraph, or
 * one that soft-wraps on read, still compare equal to the parked body. The
 * cost is that a person's reflow is not a difference here, which is right:
 * this check is about text that changed, not about where the lines end.
 */
export function normaliseReply(text: string): string {
  return replyPartOf(text).replace(/\s+/gu, ' ').trim();
}

/**
 * Whether the copy the target system holds still says what the park put
 * there.
 *
 * Both sides are normalised, so the answer is about words and not about
 * whitespace. Neither side is the text an approval sends: the question is
 * whether the copy changed after the park, and a person's own edit in the
 * console is not a change to the copy.
 */
export function parkCopyWasEdited(parkedBody: string, copyText: string): boolean {
  return normaliseReply(parkedBody) !== normaliseReply(copyText);
}

/**
 * Whether an approval must refuse because a person's edit to the copy would
 * be lost.
 *
 * Two questions, and both must be answered yes. The copy is compared against
 * the body the park put there: unchanged, there is nothing to lose, and a
 * reviewer editing the reply in the console passes here. Then against the
 * text the approval would send: when the two are the same text, the edit is
 * not discarded — it is what is about to be sent.
 *
 * The second question is what makes the refusal a choice rather than a dead
 * end. The console offers the helpdesk copy as one of the texts to send, and
 * a reviewer who takes it writes that text onto the turn. An approval that
 * refused again would leave no way to send the very text the refusal was
 * about.
 *
 * And the choice cuts both ways. A reviewer who read the copy and decided the
 * ledger's reply is what sends says so with `copyAcknowledged`, which
 * `approveRun` checks against the copy it read. Without it the refusal's other
 * branch would be a dead end of its own: the copy is in a helpdesk this
 * system cannot write into, so nothing a reviewer could do here would make the
 * two texts agree.
 */
export function copyEditWouldBeLost(
  parkedBody: string,
  ledgerText: string,
  copyText: string,
): boolean {
  if (!parkCopyWasEdited(parkedBody, copyText)) return false;
  return parkCopyWasEdited(ledgerText, copyText);
}

/**
 * Whether a copy read back from the helpdesk holds text at all.
 *
 * False for a copy that is gone and for one whose text a person cleared. One
 * rule, because the two are one fact to a reader: there is nothing to compare
 * and nothing to choose. A cleared copy offered as a text to send reaches
 * `saveReply`, which refuses an empty reply, so the choice would be a control
 * that cannot work.
 */
export function copyHoldsText(text: string | null): text is string {
  return text !== null && normaliseReply(text) !== '';
}
