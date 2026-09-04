# Intent: Compensation enters the register as DEC-34

## Problem

Compensation shipped. `src/policy/policy.ts` gates every irreversible write,
`src/coordinator/coordinator.ts` parks it in the ledger, and the relay sends
it through `performAction`. The register held no decision for any of it.

The code cited DEC-03, which says the autonomy limit is a reversible write.
That decision does not describe a new action class, an always-gated rule or
a ledger-only park.

Section 1.2 still listed compensation as outside V1. Section 7 listed it as
an open item. The section 4.8 pseudocode omitted the rule the engine runs,
while `src/policy/policy.ts` claimed to follow that pseudocode exactly.

Section 4.9 said the bridge writes every gated action into a draft state.
A ledger-only park makes no adapter call.

The action-class constants lived in the relay. An adapter implements the
port. It must not depend on the process that drives it. So the helpdesk
adapter carried a bare `'compensate'` literal instead.

No test drove a compensation through the relay.

## Proposed outcome

DEC-34 states the rule the code runs. A write that the system cannot
reverse always gates. A gated write with no customer draft parks in the
ledger.

The scope is deliberate. Four policy paths reach that park. They are no idempotency support, an
irreversible write, a high risk tier, and coverage between 0.70 and 0.80. Narrowing the branch to compensation would send a high-risk internal
write into `createDraft`. That puts an internal action in front of a
customer.

Sections 1.2, 4.8, 4.9 and 7 agree with the code. The appendix defines
compensation, because the register allows one name for one meaning.

The action-class vocabulary lives with the port. Both constants move to
`src/adapters/types.ts`, which imports nothing.

A relay test drives a compensation to `delivery_unknown` and proves no
second attempt follows.

## Affected users and systems

Anyone who reads the register. The policy engine, the coordinator, the
relay and both adapters.

## Constraints

No behaviour changes. The register records what already runs.

## Decisions affected

Adds DEC-34. Extends DEC-03 without changing it. DEC-29 and DEC-30 keep the
delivery rule and the unknown-state rule.

## Open questions

None.
