/**
 * The text form a reply takes when its channel carries no structured field.
 *
 * DEC-14 and DEC-33 require every customer reply to carry the adopter's
 * disclosure and the machine-readable provenance. A channel with structured
 * fields carries both as fields; one without them carries both as text under
 * the reply. This module owns that text form, in one place, because two
 * things now read it: the adapter that posts the reply, and the approval that
 * compares the ledger's reply against the copy the helpdesk holds (DEC-44).
 *
 * It lived in the FreeScout adapter, which was right while that adapter was
 * its only reader. The approval sits below no adapter, so the definition
 * moved here rather than the approval importing one adapter's module.
 */
import type { ReplyProvenance } from './types.js';

/**
 * The line that separates the reply a person wrote from the trailer this
 * system attached.
 *
 * A separator line, and a guess at where the reply ends: see `replyPartOf`
 * for what that costs and why nothing better is available.
 */
export const DRAFT_TRAILER_MARKER = '\n\n-- \n';

/** The reply with its disclosure and provenance under it (DEC-14, DEC-33). */
export function composeDraftBody(
  body: string,
  disclosure: string,
  provenance: ReplyProvenance,
): string {
  const trail = [
    `generated-by: ${provenance.generatedBy}`,
    `model: ${provenance.modelId}`,
    `prompt-version: ${provenance.promptVer}`,
    `generated-at: ${provenance.generatedAt}`,
  ].join('\n');
  return `${body}${DRAFT_TRAILER_MARKER}${disclosure}\n\n${trail}\n`;
}

/**
 * The reply part of a draft body, without the trailer this system appended.
 *
 * The approval-edit distance compares the body the ledger journalled against
 * the body read back (section 4.10). The journal holds the reply alone, so a
 * read-back that returned the trailer too would measure this system's own
 * decoration as a person's edit, and the C2 control band would move with the
 * disclosure text rather than with what people change.
 *
 * The split is on the first `-- ` separator line, and that is a guess with two
 * known failure modes. A person who ends their own edit with a signature
 * separator loses everything after it from the read-back, so the distance
 * understates their edit. A person who deletes the trailer has their whole
 * body counted, which overstates it.
 *
 * Neither can be repaired from the body alone: nothing in such a channel
 * records where the trailer began. Both understate or overstate one run's
 * distance rather than corrupt the ledger, and C2 reads a distribution over
 * many. A structured field would fix it, and an adapter with none has no
 * other way to carry the disclosure.
 */
export function replyPartOf(draftBody: string): string {
  const at = draftBody.indexOf(DRAFT_TRAILER_MARKER);
  return at === -1 ? draftBody : draftBody.slice(0, at);
}
