# A profile pairs its class with its visibility

## Problem

A consumer runs one action profile. Two of its settings are the action class
and whether that action reaches the customer. Startup accepts any pairing of
the two, and checks only that a visible profile has a disclosure.

The relay sends an approved draft only for the customer reply class. It
performs every other class as an internal write. So two pairings start and then
fail in silence.

A visible profile with another class parks a draft in the helpdesk. Its
approval records an outbox row under that other class. The relay performs that
action and never sends the draft, so the customer never receives the reply.

The policy engine judges the reply class shown to no customer as an internal
write. Some adapters take an idempotency key and read back. On such an adapter,
a reply that is not high risk can pass both gates. It then takes the automatic
path, with no approval. It parks no draft, so the relay refuses its record as
malformed.

## Proposed outcome

The consumer refuses to start with either pairing. The refusal names
`ACTION_CLASS` and `ACTION_IS_CUSTOMER_VISIBLE`, and the value it read. It marks
a value that nobody set as the default.

A customer-visible profile needs the class `customer_reply`, and that class
needs a customer-visible profile. The consumer compares the class exactly, as the
relay does.

The consumer also refuses a near-miss of `customer_reply`. Such a class differs
only in case, spacing, punctuation, symbols, compatibility forms or invisible
characters. The relay runs it as an internal write. That refusal names the
class it read, and shows each invisible character as its code point.

The remedy of a pairing or near-miss refusal names every setting that the next
start checks, the disclosure too. So a profile that follows it starts. The
remedy that hides the action says what then decides approval. A `compensate`
write still waits for approval, and any other write runs wherever the gates
pass.

Once spaces and invisible characters are gone, a class or a disclosure with no
letter or digit is blank. The invisible characters are the default-ignorable,
control, format and space characters, and two hieroglyph blanks. The consumer
also ignores a Khitan filler, a Duployan selector and a Tifinagh joiner.

Every other pairing starts as before. The consumer does not check that the
egress adapter performs an internal class. Issue #144 records that gap.

## Affected users and systems

This touches the operator who configures a consumer. It changes the startup
check in the consumer's profile reader, the example environment and the
runbook. No ledger row, route or stored value changes.

An older example environment calls `ACTION_IS_CUSTOMER_VISIBLE=true` the safe
posture. A profile that follows it with an internal class now refuses to start.
On the helpdesk adapter, such a profile parks a draft for each run. Its approval
sends the internal write with the draft handle as its payload.

- A shown `route_ticket` write fails for want of a queue.
- A shown `close_ticket` write closes the ticket and leaves the draft.
- A shown `compensate` write fails for want of a reason.

The other adapters perform no internal write, so each such write fails there.
An operator who sets the action hidden gets automatic internal writes. Risk,
irreversibility and the adapter's guarantees still gate them.

## Constraints

Every customer reply parks as a draft in the target system (DEC-11) and waits
for a person (DEC-12). A visible reply carries a disclosure (DEC-14). A gated
write with no customer draft parks in the ledger (DEC-34).

## Decisions affected

Affects: DEC-11, DEC-12, DEC-14, DEC-34

This change keeps DEC-11. A profile that parks a draft is now one whose class the relay
sends as a draft.

This change keeps DEC-12. A reply can no longer skip approval, because the reply class is
always customer visible. An approved reply now always has a route to the
customer.

This change leaves DEC-14 as it is. A visible profile still needs a disclosure. The consumer
checks the pairing first, so a profile with both faults names the pairing.

This change keeps DEC-34. An internal write still parks in the ledger. The reply class can
no longer park there, because it is always customer visible.

## Open questions

None.
