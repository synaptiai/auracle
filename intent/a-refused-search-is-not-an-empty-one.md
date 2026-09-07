# Intent: a refused search is not an empty one

## Problem

`findThreadOriginator` reads a refused IMAP SEARCH as a mailbox that holds no
such thread. The imapflow client answers `false` for a refused command. It
answers `false` for a lost connection too. The lookup folded that answer into
an empty list, so both routes reached one throw.

Commit `d786872` made that throw permanent. A permanent refusal escalates on
the first fault and skips the intake attempt ceiling. So one window of server
faults escalates every ticket that parks a reply during it. The ceiling exists
for exactly this class of fault. A `FETCH` of a listed UID has the same shape.

## Proposed outcome

The lookup separates a fault from an empty mailbox. A `false` from `search` or
from `fetchOne` raises a plain error, which the consumer counts and retries.
Only a search that truly finds nothing raises the permanent error. The two
other permanent refusals stay permanent, because no retry addresses a content
digest or invents a missing From header.

## Affected users and systems

The mail egress and every reply it parks. An operator sees fewer escalations
during a server fault, and the same escalation when a thread root is gone.

## Constraints

The worst failure of a mail egress is a reply to the wrong person. So the
lookup still verifies every candidate against the parsed Message-ID (DEC-11).
`findDraftByIdemKey` already draws this distinction and this matches it.

## Decisions affected

None. DEC-30 governs unknown delivery state, which this path never reports.
The retry ceiling and the escalation reason are implementation details.

## Open questions

None.
