# Intent: a FreeScout adapter, and a read-back capability with a reader

## Problem

Two gaps, one shape.

No egress adapter both reaches a real customer and meets the C7 adapter floor.
The mail adapter reaches a customer and declares `supportsReadBack: false`; its
`readBack` throws. The helpdesk adapter declares both capabilities and opens no
connection: it holds fixtures in memory.

`supportsReadBack` has a declaration and no reader. `src/policy/policy.ts`
carries it in the capability type and never reads it. Only
`supportsIdempotencyKey` is read. So an adapter that can never establish
whether its write landed could still take the automatic path. The relay
would then escalate every failure it produced.

## Proposed outcome

A FreeScout adapter implements the egress port over HTTP. It parks a gated
reply as a draft thread, reads that draft back for the approval-edit distance.
It posts the approved text after approval. It opens one request per operation
and holds nothing between them.

Its capability declaration is honest and each flag is justified against what
the API guarantees. `supportsIdempotencyKey` and `supportsReadBack` are both
false, because FreeScout takes no key on thread create and records none on a
thread.

The policy engine reads `supportsReadBack`. A write on an adapter that cannot
read delivery back goes to the approval path. The journalled reason names
that rule.

`docker-compose.freescout.yml` brings a FreeScout instance up beside Postgres,
with no credential committed. It is a separate file because compose
interpolates a whole file before it selects a service. So a required-variable
reference in the main file would break the bare `docker compose up -d` that
the setup instructions name. The reference has to stay required: the image
substitutes a published default password for an empty one.

## Affected users and systems

An adopter running FreeScout as their helpdesk. The policy engine, the
coordinator's egress registry, the relay daemon and the approval CLI. Every
run whose adapter declares no read-back: those writes gate now.

No shipped adapter changes verdict. The helpdesk adapter declares read-back
true, and the mail and FreeScout adapters are stopped by the idempotency rule
first.

## Constraints

- DEC-06. Autonomy decreases to agree with the declared capability. The
  rejected column names "a shim that removes duplicates". So no client-side
  dedupe table stands in for a guarantee the target system does not give.
- DEC-30. An unknown delivery escalates and never retries. That is why the
  absent read-back matters, and why `readBack` throws rather than guess.
- DEC-11. A gated reply parks in the target system's own draft state.
- DEC-12, DEC-14. A customer reply needs approval and a disclosure that is not
  empty. The disclosure reaches the customer with the sent text.
- DEC-33. Provenance travels with the message. FreeScout has no structured
  field for it on a thread, so it travels in the body.
- DEC-35. The reply reaches the participant the ledger recorded. The ticket
  id is the FreeScout conversation id, and FreeScout addresses a thread to
  that conversation's customer. So the ticket id is the addressing here. The
  park compares the two and refuses when they disagree.
- DEC-18. Synthetic fixtures only. No credential, address or account id.
- DEC-05. The two gates stay independent. This change adds a capability rule
  and touches neither gate.
- Section 4.10. The approval-edit distance measures what a person edited. The
  read-back returns the reply alone, without the trailer the adapter appended.
  Otherwise the distance would count that trailer as their edit.

## Decisions affected

DEC-06 and DEC-30 for the policy rule. DEC-01, DEC-11, DEC-14, DEC-18, DEC-24,
DEC-33 and DEC-35 for the adapter. Section 4.8 of `docs/v1-architecture.md` gains the
second capability line, and its `Obeys` list gains DEC-30. No register row
changes.

## Open questions

FreeScout's REST API lives in a module a person buys. A stock 1.8.239 install
ships an empty `Modules` directory and answers `404` to every `/api/` route.
So the adapter's behaviour against a real instance is unverified here. The
automated suites drive it against the documented wire contract instead. Whether
this repository should depend on a purchased module at all is a question for
the maintainer.

The DEC-35 recipient check covers the park and cannot cover the send.
`EgressAdapter.sendDraft` receives a draft id and an idempotency key. So the
port hands the adapter no participant to compare against. FreeScout resolves
the recipient itself on that later request.

A conversation whose customer changes between the park and the relay scan
therefore delivers to the new one. Closing this needs a participant on the
send, which changes the port and touches every adapter. The maintainer
decides whether that is worth it.

C7 stays open, and V2 item 1 stays open. Their blockers are a register
amendment, an exit decision and an adopter's own traffic.
