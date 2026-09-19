// DEC-44: the comparison between the reply the ledger holds and the copy the
// helpdesk holds, as a pure rule.
//
// The db suite holds the paths that reach it. What is here is the rule
// itself, because both answers decide whether a customer receives text a
// person did not approve, and neither is visible from a page.
import { describe, expect, it } from 'vitest';

import { copyEditWouldBeLost, copyHoldsText, normaliseReply, parkCopyWasEdited } from './reply-copy.js';

describe('the copy comparison (DEC-44)', () => {
  it('reads one text through its whitespace', () => {
    expect(normaliseReply('  We   refunded\nthe charge.  ')).toBe('We refunded the charge.');
  });

  // Both sides are cut at the trailer the adapter adds, so a channel that
  // rewraps a reply is not read as a person's edit.
  it('compares the reply and not the trailer a channel appends', () => {
    expect(parkCopyWasEdited('We refunded it.', 'We refunded it.\n\n-- \nAuracle'))
      .toBe(false);
    expect(parkCopyWasEdited('We refunded it.', 'We refunded it, twice.'))
      .toBe(true);
  });

  // Two questions, and the second is what makes the refusal a choice: text
  // the reviewer is about to send is not an edit at risk of being lost.
  it('does not refuse a copy that is what is about to be sent', () => {
    const parked = 'We refunded the duplicate charge.';
    const copy = 'We refunded the duplicate charge, and the bank decides when it lands.';
    expect(copyEditWouldBeLost(parked, copy, copy)).toBe(false);
    expect(copyEditWouldBeLost(parked, parked, copy)).toBe(true);
    // Unchanged since the park: nothing to lose, whatever is sent.
    expect(copyEditWouldBeLost(parked, 'something else entirely', parked)).toBe(false);
  });

  it('holds text only for a copy that carries some', () => {
    expect(copyHoldsText('A reply.')).toBe(true);
    expect(copyHoldsText('   \n\n  ')).toBe(false);
    // A copy a person cleared down to the trailer this system appended: the
    // reply part is empty, and there is nothing to choose between.
    expect(copyHoldsText('\n\n-- \nAcme support\n')).toBe(false);
    expect(copyHoldsText('')).toBe(false);
    expect(copyHoldsText(null)).toBe(false);
  });
});
