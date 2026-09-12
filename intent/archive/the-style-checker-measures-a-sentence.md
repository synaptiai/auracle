# Intent: the style checker measures a sentence

## Problem

`scripts/ste-check.py` enforces two style rules. Rule 1 caps a sentence at 20
words. Rule 2 caps a paragraph at 6 sentences.

The two rules read the same text differently. Rule 2 joined a block's lines
into one paragraph first. Rule 1 split each line on its own.

Every document here wraps its prose near 80 columns, so a sentence spans two
or three lines. Rule 1 measured each fragment. CI reported the pinned list
clean while 304 sentences broke the rule it names.

A second defect sat beside it. The sentence split fired on a full stop
followed by whitespace. A lead-in written as `**Set the secret first.**` puts
that stop before the closing marker. The checker joined that lead-in to
the sentence after it.

## Proposed outcome

Rule 1 measures a sentence the way a reader reads one. A unit is a paragraph,
a list item or a table cell. Lines join inside a unit and never across one.

Every file CI pins meets the rule.

## Affected users and systems

A reader of any shipped document, and any author whose next change CI checks.
No runtime behaviour changes, and no published number moves.

## Constraints

The limits do not change. Twenty words and six sentences stay.

The pinned file list does not change. Rules 3 to 5 need a reader and no
checker claims them.

A sentence is split because it is too long, never because it can be shortened.
Numbers, DEC ids, code spans, code fences, headings and links are compared set
for set. The comparison runs against the commit before the prose moved.

An edit to `docs/v1-architecture.md` cites the DECs its changed lines name.
Those are DEC-05, DEC-12, DEC-17, DEC-19, DEC-21, DEC-25, DEC-27, DEC-31,
DEC-39 and DEC-41. No decision changes.

## Decisions affected

None. This is an implementation detail. The style convention lives in
`AGENTS.md` and no DEC states it.

## Open questions

None.
