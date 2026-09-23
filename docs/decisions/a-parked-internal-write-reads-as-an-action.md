# A parked internal write reads as an action

## Problem

A run can wait for a person in two kinds. A customer reply parks as a draft in
the helpdesk. An internal write parks in the ledger alone, with its payload and
no customer text. Both wait in the same state. Without this change the console
reads them alike.

So an internal write reads as a drafted reply on several surfaces. The
conversation page cannot name a drafted reply at all. The run timeline says a
draft is in the helpdesk. The evidence card heads the rationale as the reply.
The batch confirm can take an internal write. It then promises a hold and an
undo that the approval never gives it.

## Proposed outcome

Every surface names what the ledger records about the park. A park that names a
helpdesk draft is a drafted reply. A park that records a payload for an action
other than the customer reply is an internal write. A park that names neither
reads as neither, and the page claims neither.

The conversation reader reports which kind a waiting turn holds. The page then
says a reply is drafted, or that an action waits with no reply drafted. The
timeline names a draft by its handle alone. The evidence card calls an internal
write's text its rationale.

The coverage rules, the send-back and its refusal name neither kind. A close of
an internal write says its action is left unperformed. A refusal because the
page changed names what the page showed, and not a reply. The batch confirms
drafted replies alone, and a person approves an internal write on its own case
page. A reply parked in the ledger alone offers no approval, on the page or to a
request built by hand.

## Affected users and systems

This touches the conversation reader and its public type. In the console it
touches the conversation page, the run timeline and the evidence card. It also
touches the case page's panels and outcomes, the queue's grouping and the batch
confirm. A reviewer who reads a waiting case sees which kind it is.

## Constraints

Every customer reply waits for a person (DEC-12). A customer reply parks inside
the target system (DEC-11), and an internal write parks in the ledger alone
(DEC-34). The ledger holds the reply only where the adapter cannot send the copy
it parks (DEC-44). A held send and its undo cover a reply (DEC-51). No migration
is needed: the park row already records the draft handle and the payload.

## Decisions affected

Affects: DEC-07, DEC-11, DEC-12, DEC-34, DEC-37, DEC-44, DEC-46, DEC-51

DEC-07 is unchanged. Coverage judges what the system composed, a reply or a
rationale, and the case now names it so.

DEC-11 is kept. A drafted reply is read from the handle the park recorded in the
target system, and from nothing else.

DEC-12 is kept. Every reply still waits for a person. The words now say which
waits: a reply, or an action.

DEC-34 is kept. An internal write parks in the ledger alone, and no surface
calls it a reply. Its text is the rationale a person reads before approving.

DEC-37 is unchanged. The turn's reply text is still written on the approval path
alone. The reader names two more reasons it can be empty.

DEC-44 is kept. A reply parked in the ledger alone has no draft. The relay
refuses a reply record with no draft, so the case offers no approval.

DEC-46 is kept. A case that changed since the page was drawn still refuses. For
an internal write the refusal names what the page showed, its rationale.

DEC-51 is kept. The batch holds each reply for an undo, and takes replies alone.
An internal write takes no hold, so the batch never promises one for it.

## Open questions

The run detail page shows an internal write's rationale, and not the payload it
would perform. The case page shows both.
