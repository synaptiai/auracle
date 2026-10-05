// The approver an approval records (DEC-42).
//
// Pure, and apart from `approve.ts`, because two callers need the same answer.
// The approval records it. A surface that names the person in front of it must
// name the value the ledger would keep, or it shows one name while the audit
// column holds another.

/** DEC-42: what the ledger records when no trusted proxy named an approver. */
export const UNATTRIBUTED = 'unattributed';

/**
 * The name alphabet: letters, marks, numbers, punctuation, symbols and the
 * ASCII space. Nothing that draws nothing: no joiner and no variation
 * selector, because whether one draws depends on the script and the font.
 */
const NAME_CHARACTER = /^[\p{L}\p{M}\p{N}\p{P}\p{S} ]$/u;

/**
 * Inside the alphabet, but drawing nothing or blank: every default-ignorable
 * character (the Hangul fillers are letters and among them), the blank
 * Braille pattern, and the object replacement character. The last two are
 * symbols, and the rail's font draws nothing for either.
 */
const DRAWS_NOTHING = /^[\p{Default_Ignorable_Code_Point}\u2800\ufffc]$/u;

/** A mark draws on the character before it. */
const MARK = /^\p{M}$/u;

/**
 * A mark that stacks above or below its character. A spacing mark sits beside
 * it instead, so only these count toward the limit.
 */
const STACKING_MARK = /^[\p{Mn}\p{Me}]$/u;

/**
 * Stacking marks one character may carry. Vietnamese, pointed Hebrew and
 * Burmese syllables stay under it.
 */
const MAX_STACKING_MARKS = 4;

/**
 * True when every character of a trimmed name draws, no two spaces touch, every
 * mark follows a character other than a space, and no character carries more
 * than four stacking marks.
 */
function isReadableName(named: string): boolean {
  let before = '';
  let marks = 0;
  for (const ch of named) {
    if (!NAME_CHARACTER.test(ch) || DRAWS_NOTHING.test(ch)) return false;
    if (ch === ' ' && before === ' ') return false;
    if (MARK.test(ch)) {
      // With no base a mark draws a stray tick or a dotted circle, and a tall
      // stack draws over whatever sits above or below the name.
      if (before === '' || before === ' ') return false;
      if (STACKING_MARK.test(ch)) marks += 1;
      if (marks > MAX_STACKING_MARKS) return false;
    } else {
      marks = 0;
    }
    before = ch;
  }
  return true;
}

/**
 * A principal a header claimed, reduced to something an audit column can hold.
 *
 * The bound and the character check live here rather than in the caller, so a
 * console that forgets them cannot bypass them: this function is the one
 * chokepoint every approval path goes through.
 *
 * A control character in an audit value is a log-injection primitive — it
 * lets one recorded approver forge the appearance of another line — and this
 * value arrives from a header. A character that draws nothing, or reorders
 * what a reader sees, lets one recorded name display as another. So the bound
 * names what a name may hold, rather than what it may not: letters, marks,
 * numbers, punctuation, symbols and single spaces. A mark must follow a
 * character other than a space, and no character may carry more than four
 * stacking marks, because a mark with no base draws a stray tick and a tall
 * stack draws over the rail.
 *
 * Some refusals are deliberate. No name holds a zero-width joiner, a
 * non-joiner or a variation selector, because telling one that draws from one
 * that draws nothing needs per-script shaping rules. So a Persian name written
 * with a non-joiner, an Indic conjunct written with a joiner, an emoji
 * sequence, a subdivision flag, a keycap and a Mongolian vowel separator each
 * record `unattributed`, and the approval still goes ahead. A reviewer roster
 * replaces free-text names with identifiers when it ships.
 *
 * A value that fails any check names nobody,
 * so it records `unattributed` rather than throwing: DEC-42 already says an
 * unnamed approver is a recorded fact, and refusing the approval over the
 * audit field would put a customer reply behind a header's formatting.
 */
export function approverFrom(claimed: string | undefined): string {
  const named = claimed?.trim();
  if (named === undefined || named === '') return UNATTRIBUTED;
  // Generous for a proxy-supplied principal, and far below what `text` takes.
  if (named.length > 256) return UNATTRIBUTED;
  if (!isReadableName(named)) return UNATTRIBUTED;
  return named;
}

/** How a recorded name was established (DEC-45). */
export type NameSource = 'roster' | 'header' | 'none';

/**
 * The source to record beside a name `approverFrom` returned.
 *
 * The ledger holds a name and its source to one rule: `none` exactly when the
 * name is `unattributed`. A caller can claim any pair, so every writer derives
 * the pair here instead of passing the claim on. A real name claimed as
 * `none` reads as a caller's claim, `header`, because a name was given, and so
 * does a claim outside the vocabulary.
 */
export function sourceOf(name: string, claimed: NameSource | undefined): NameSource {
  if (name === UNATTRIBUTED) return 'none';
  return claimed === 'roster' || claimed === 'header' ? claimed : 'header';
}
