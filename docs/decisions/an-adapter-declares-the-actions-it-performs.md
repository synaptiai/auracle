# An adapter declares the actions it performs

## Problem

A consumer runs one action profile, and every run performs its action class.
The relay performs every internal class through the egress adapter. The
helpdesk performs `close_ticket`, `route_ticket` and `compensate`, and refuses
any other class. The FreeScout and SMTP adapters perform no internal write.

Startup accepts every class on every adapter. On an adapter that takes an
idempotency key, the relay leaves a record that the adapter refuses pending.
So that record retries on every scan and never escalates. On the automatic
path, the run already reads resolved.

The consumer sends one fixed payload with every run, a queue name. The
helpdesk refuses `compensate` without a reason. So a consumer that runs
`compensate` never completes a write.

## Proposed outcome

Each egress adapter declares the internal classes it performs, with the payload
fields each class needs. The declarations live in one registry, so a check can
read every adapter's without building one. The helpdesk's write reads its own
declaration, so the two cannot disagree. A test holds every declared class to
its fields.

At startup, before any connection opens, the consumer checks a hidden profile.
It refuses a class that its egress adapter does not perform. It refuses a class
whose payload field it does not send. So it refuses `compensate`, because its
payload carries no reason.

Each refusal names only a remedy that starts. That is a class the adapter runs
with the consumer's payload. On an adapter that runs none, it is the whole
customer-reply profile. No refusal names another adapter. The helpdesk is the
in-memory reference adapter, and the relay still runs the adapter it names.

A visible internal class can be hidden. Its refusal offers that only where the
consumer's own egress adapter runs the class. The check reads each adapter's
declaration by name, so it refuses a class before the adapter needs its
credentials.

The consumer does not check a visible profile here. Its action is the customer
reply, which the relay sends as a draft.

## Affected users and systems

This touches the operator who configures a consumer. It adds one declaration
to the egress port and to each adapter. It changes the consumer's startup, the
example environment and the runbook. No ledger row or stored value changes.

A consumer with a class its adapter cannot perform now refuses to start. Such a
consumer runs today, and none of its writes lands.

## Constraints

Each adapter declares its capability, and autonomy decreases to agree (DEC-06).
A customer reply parks as a draft in the target system (DEC-11), with a
disclosure (DEC-14).
A write the system cannot reverse always gates (DEC-34). A gated write with no
customer draft parks in the ledger (DEC-34). The compensation design leaves the
compensation payload to the adopter.

## Decisions affected

Affects: DEC-06, DEC-11, DEC-14, DEC-34

This change keeps DEC-06. An adapter now also declares the internal actions it
performs, and the consumer agrees with that declaration before it starts.

This change keeps DEC-11. The consumer does not check a visible profile. Its
reply parks as a draft, and the relay sends that draft.

This change keeps DEC-14. The remedy that names the customer-reply profile also
names the disclosure that profile needs.

This change keeps DEC-34. A compensation still always gates. The consumer
cannot build a compensation payload, so it no longer starts with that class.

## Open questions

The consumer does not check the relay's own adapter. The relay serves every
consumer, so it has no one profile to check.
