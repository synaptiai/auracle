// The identity of a gold half, and the DEC-31 check that reads two of them.
//
// Split from load.ts. A caller that compares two halves no longer imports file
// I/O to do it, and the fit-report separation is testable on two objects built
// in memory.
//
// The order of the checks inside `assertHalvesDisjoint` is load-bearing and
// unchanged: an overlap is reported before a size mismatch, because an
// operator who sees "the halves hold 4100 and 4099 cases" and fixes the count
// has not fixed the overlap.
import { createHash } from 'node:crypto';

import { assert, label } from './validate.js';
import type { GoldFile, HalfIdentity } from '../domain/gold-types.js';

/**
 * A stable name for the exact case set of one half.
 *
 * The disjointness check happens once, inside one job run, and then nothing
 * remembers it. So an operator could calibrate against report half B, then
 * publish against a pruned fit half A' that no longer overlaps B, and every
 * check would pass while the gate in force came from a fit that did overlap.
 * Recording this digest in both artifacts lets a reader compare the two runs
 * and see that they were proved against different sets.
 *
 * Ticket ids only, sorted, so the value does not depend on file order. Ids
 * are already identifiers; no case text enters the digest.
 */
export function halfDigest(identity: HalfIdentity): string {
  const ids = [...identity.ticketIds].sort().join('\n');
  return createHash('sha256').update(ids).digest('hex').slice(0, 16);
}

export function identityOf(half: GoldFile): HalfIdentity {
  const withClaims = half.tickets.filter((ticket) => (ticket.claims ?? []).length > 0);
  return {
    split: half.split,
    source: half.source,
    ticketIds: new Set(half.tickets.map((ticket) => ticket.ticket_id)),
    conversationIds: new Set(
      half.tickets
        .map((ticket) => ticket.conversation_id)
        .filter((id): id is string => id !== undefined),
    ),
    claimDigests: new Set(
      withClaims.flatMap((ticket) => (ticket.claims ?? []).map((claim) => claimDigest(claim.text))),
    ),
    groundedDrafts: withClaims.filter((ticket) =>
      (ticket.claims ?? []).every((claim) => claim.supported)).length,
    draftsWithClaims: withClaims.length,
  };
}

/**
 * A claim sentence's stable name.
 *
 * Always a digest, on a synthetic half as much as a real one. An identifier
 * has a safe printable form and a sentence does not, and the provenance that
 * would gate the choice is a field a caller can set wrongly. Digesting both
 * removes the decision rather than making it correctly.
 *
 * Whitespace is folded and case is dropped first, so two spellings of one
 * sentence are one sentence. Otherwise a stray double space would let the
 * same claim sit in both halves and pass the check.
 */
export function claimDigest(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/**
 * Refuse two halves whose grounded shares are not shown to be close.
 *
 * Precision counts grounded drafts above a threshold against every draft above
 * it, so a half holding more grounded drafts is the easier one, and a
 * precision published from it reads high. The corpus this repository shipped
 * held 167 grounded drafts of 385 against 195 of 385, and the known-limits
 * section asked the reader to compensate for it.
 *
 * This is an equivalence test, not a significance test, and the difference is
 * the whole point. An earlier version refused when a two-proportion z-test
 * rejected equality. That answers "is the gap real?" when the question is "is
 * the gap small enough not to matter?", and the two come apart in both
 * directions: a 5.5 point gap over 600 drafts a side gives z = 1.91 and passed,
 * while the 7.3 point gap that motivated the check gives z = 2.02 over 385 and
 * refused. A larger corpus was allowed a larger gap. At ten thousand drafts a
 * side, a gap of 1.5 points is beyond sampling noise and could not flatter any
 * published precision, and it refused that too. Failing to reject equality was
 * never evidence of equality.
 *
 * So the halves must prove the gap SMALL. Two one-sided tests at 5 percent,
 * which is the 90 percent interval for the difference lying wholly inside the
 * margin. Sample size now works the right way round: a half too small to
 * demonstrate closeness is refused rather than passed by default, and it is
 * already too small to fit a threshold on (see minimumSupport).
 */
function assertGroundedSharesComparable(a: HalfIdentity, b: HalfIdentity): void {
  // A half with no labelled claims has no share to compare. The coverage job
  // refuses such a half itself, with a message about claims rather than about
  // balance, and that is the fault an operator should read first.
  if (a.draftsWithClaims === 0 || b.draftsWithClaims === 0) return;
  const na = a.draftsWithClaims;
  const nb = b.draftsWithClaims;
  const pa = a.groundedDrafts / na;
  const pb = b.groundedDrafts / nb;
  const difference = pb - pa;
  // Agresti-Caffo: one success and one failure added to each half before the
  // standard error, unpooled because the null here is a difference of exactly
  // the margin rather than of zero.
  //
  // The adjustment is not decoration. The textbook standard error is exactly
  // zero at a share of 0 or 1, so the interval collapses to a point and any
  // sample size passes — one draft a side "demonstrates closeness". That is
  // the trivial pass this guard replaced a significance test to remove,
  // reappearing at the edge of the range. Away from the boundary the two agree
  // to four decimal places, so nothing else moves: the committed corpus reads
  // 0.0357 either way.
  const aa = (a.groundedDrafts + 1) / (na + 2);
  const ab = (b.groundedDrafts + 1) / (nb + 2);
  const standardError = Math.sqrt((aa * (1 - aa)) / (na + 2) + (ab * (1 - ab)) / (nb + 2));
  const halfWidth = Z_90_ONE_SIDED * standardError;
  assert(
    Math.abs(difference) + halfWidth < GROUNDED_SHARE_MARGIN,
    `the halves hold ${a.groundedDrafts} and ${b.groundedDrafts} fully grounded drafts of `
      + `${na} and ${nb}, a grounded share of ${pa.toFixed(3)} against ${pb.toFixed(3)}. `
      + `The 90 percent interval for that difference reaches `
      + `${(Math.abs(difference) + halfWidth).toFixed(3)}, which does not fit inside the `
      + `${GROUNDED_SHARE_MARGIN} margin, so these halves are not shown to be equally hard `
      + 'and a precision published from one of them may read high (DEC-31).',
  );
}

/**
 * The largest grounded-share gap this repository leaves uncompensated.
 *
 * A stated margin, because "how much easier may one half be" is a judgement
 * and no test can supply it. It is anchored on the defect it replaces: the
 * halves that motivated this check differed by 7.3 points, and section 6 asked
 * the reader to allow for it. Five points is the point at which this
 * repository stops asking that of a reader.
 */
export const GROUNDED_SHARE_MARGIN = 0.05;

/** One-sided 5 percent, which is the 90 percent two-sided interval TOST reads. */
const Z_90_ONE_SIDED = 1.6448536269514722;

/**
 * Refuse two halves that share a case or a conversation (DEC-31).
 *
 * A conversation on both sides is the subtler leak. Two turns of one thread
 * are two cases with two identifiers, so a case-level check passes, and a
 * threshold would still be fitted and published on one customer's problem.
 */
export function assertHalvesDisjoint(a: HalfIdentity, b: HalfIdentity): void {
  assert(a.split !== b.split, `both halves declare split ${a.split} (DEC-31)`);
  // Both halves must describe one body of data. Without this an operator can
  // pair their own fit half with a copy of the shipped report half: SYN- ids
  // never collide with real ones, so the proof passes trivially and the
  // artifact records a real fit proved against a set nobody publishes from.
  assert(
    a.source === b.source,
    `the halves declare different provenance, ${a.source} and ${b.source} (DEC-18, DEC-31)`,
  );
  for (const id of b.ticketIds) {
    assert(!a.ticketIds.has(id), `ticket ${label(id, a.source)} appears in both halves (DEC-31)`);
  }
  for (const id of b.conversationIds) {
    assert(
      !a.conversationIds.has(id),
      `conversation ${label(id, a.source)} appears in both halves (DEC-31)`,
    );
  }
  // A sentence on both sides is the leak the two checks above cannot see. Two
  // halves can hold entirely disjoint cases and still ask the judge the same
  // sentences, and then a judge that mis-reads one WORDING moves both halves
  // together.
  //
  // Wording is the limit of what this proves, and the claim must not be
  // widened past it. The digest normalises whitespace and case and then
  // hashes, so it separates sentences, never facts. The shipped corpus pairs
  // each report sentence with a paraphrase of its fit counterpart, which is a
  // deliberate choice — it keeps the two halves matched in difficulty — and it
  // means a judge that mis-reads the FACT still moves both halves together.
  // Section 6 concedes exactly that, and this check does not remove it.
  for (const digest of b.claimDigests) {
    assert(
      !a.claimDigests.has(digest),
      `claim sentence digest ${digest} appears in both halves (DEC-31)`,
    );
  }
  assertGroundedSharesComparable(a, b);
  // Last, because an overlap is the graver fault and must be the one an
  // operator is told about first. Reporting the size mismatch ahead of it
  // sent them off to trim a half before they learned of the leak.
  //
  // DEC-31 splits one gold set into two halves and publishes from the half
  // that fitted nothing. Halves of different sizes are not that split. A set
  // with an odd number of cases, or whose conversations admit no equal
  // partition, cannot be split this way at all: hold a conversation back
  // until the two sides match.
  assert(
    a.ticketIds.size === b.ticketIds.size,
    `the halves hold ${a.ticketIds.size} and ${b.ticketIds.size} cases; DEC-31 splits one `
      + 'gold set into two halves of equal size. Hold a whole conversation back from the '
      + 'larger half until the two match; a conversation may not straddle them.',
  );
}
