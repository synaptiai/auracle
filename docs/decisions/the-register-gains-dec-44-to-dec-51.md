# The register gains DEC-44 to DEC-51

## Problem

A design handoff turns the operator console into the working tool of a small
review team. Seven issues in the reviewer-console epic need a row that does
not exist. DEC-11 rejects a new web queue by name. DEC-40 permits a read-only
console. DEC-42 names the approver unverified.

Five needs had no row at all. They are a reservation on a case, a product and
review outcomes beyond approve. The last two are a held send and knowledge
written from a case. DEC-38 also bound a second attempt on one turn to the
first attempt's key.

A proposal is not a decision. A document becomes a decision only when a row
enters the table in section 2.

## Proposed outcome

Section 2 carries DEC-44 to DEC-51. The maintainer ratified the wording in
`../design/amendment-a-reviewer-console-four-people-work-from.md` on 2026-09-14.

No row rewrites a row it supersedes. DEC-11, DEC-38, DEC-40 and DEC-42 keep
their text, as DEC-27 kept its text when DEC-36 replaced the partition key.

This change corrects the statements that restate the register. They are
sections 4.7 and 4.9 of the register, and its design index. They also include
the architecture map, the README flow, the composer's module header and the
stated decision range. Four documents state the key rule, and this change
corrects each. The quick map lists the eight rows among those no directory
implements yet.

The statements that describe what the code does today stay. The proposal
lists each one beside the row whose change corrects it.

## Affected users and systems

Anyone who reads the register. The Track B issues of the reviewer-console
epic, which cite these rows. The style checker skips a front-matter block only
when every line in it is a known metadata key.
No runtime component changes.

## Constraints

No runtime behaviour changes. No published number moves, and the committed
fixtures stay byte-identical (DEC-18).

Today no approval accepts a reply parked before a consumer start, or before a
later run on its ticket. Issue 113 records that defect. No change that cites
a row which moves a parked run ships before its fix.

## Decisions affected

Affects: DEC-44, DEC-45, DEC-46, DEC-47, DEC-48, DEC-49, DEC-50, DEC-51, DEC-11, DEC-38, DEC-40, DEC-42, DEC-12, DEC-14, DEC-19, DEC-24, DEC-28, DEC-30

Adds DEC-44 to DEC-51. DEC-44 supersedes DEC-11 on where a person reviews,
and its rejection of "a new web queue" by name. It supersedes DEC-40's word
"read-only" for every adapter. Some helpdesks cannot send a parked copy.
For their adapters it also supersedes DEC-40's draft state. It supersedes the
rejection of "a console that parks its own drafts" there too.

DEC-45 supersedes DEC-42 for the console. DEC-42 still governs the command-line
approval. DEC-49 supersedes DEC-38 in part: a key now also carries the attempt
a person requested.

DEC-12 and DEC-14 keep every effect they had. A customer reply still needs a
person and a non-empty disclosure. DEC-19 keeps the compliance position in
documentation. DEC-50's identifier check guards one field and states no
position.

DEC-24 still derives a key from action semantics and never from the run.
DEC-28 still refuses a write from a stale owner. DEC-30 still escalates an
unknown delivery state. DEC-51 counts a fenced row that the relay may have
sent as one. Today the relay marks such a row `fenced` and escalates nothing.

## Open questions

None. The maintainer ruled on seventeen questions the rows raised. The
proposal records each ruling.
