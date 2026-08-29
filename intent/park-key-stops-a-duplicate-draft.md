# Intent: A repeat park returns the first draft

## Problem

`createDraft` reaches the target system before the ledger records the handle
it returns. A crash in that window left a draft that no row named. The next
run parked a second one, so the customer saw two replies waiting.

The stage before this made the orphan detectable. A run that found an
unresolved park escalated. That stopped the duplicate. It did not let a
retry reuse the draft that was already there.

The port stated the no-resend guarantee for `sendDraft` without condition.
The mail adapter cannot honour it, and declares so.

## Proposed outcome

Every gated reply carries a park key, derived from the action and the ticket
under DEC-24. Two runs of the same park derive the same key.

The adapter recognises the repeat and returns the first draft. The helpdesk
adapter keys a map. The mail adapter writes the key as a header.
It then searches the Drafts mailbox for that header.
A mailbox gives an appended message no other stable handle.

The bridge refuses a reply with no key, next to the disclosure and the
provenance checks.

The port states the `sendDraft` guarantee against the capability that backs
it.

## Affected users and systems

Every customer whose reply is parked. Both egress adapters.

## Constraints

A server that cannot search an arbitrary header returns nothing rather than
failing the park. The ledger-side guard still stops a blind repeat there.

## Decisions affected

DEC-24 now covers the park, which had no key. DEC-11 and DEC-14 are
unchanged. Section 4.9 lists three obligations instead of two.

## Open questions

None.
