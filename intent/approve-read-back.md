# Intent: Approve read-back for truthful edit distance

## Problem

The approval-edit distance measures a parked draft against a final body
that the caller captures by hand (`approveRun` option `finalBody`).
Nothing checks that the captured body matches what the person actually
edited in the helpdesk. An operator can approve with no body at all, and
the distance stays null even though an edit happened.

## Proposed outcome

`npm run approve -- --run <run-id> --read-back` fetches the parked
draft's current body from the adapter before the approval commits.
`approveRun` records the distance between the parked body and that body.
Read-back that finds no draft refuses the approval and commits nothing.
The manual `finalBody` path stays and wins over read-back.

## Affected users and systems

Operators and helpdesk webhooks call the approval CLI. The approval
entrypoint (`src/approval/approve.ts`), the approval CLI, and both
draft-capable adapters change: the fixture helpdesk and the email duplex
adapter. The e2e approval flows and the operations runbook section 4
cover the new path.

## Constraints

DEC-11: the person reviews the draft in the helpdesk they already use.
DEC-12: the approval still gates every customer reply; read-back adds a
refusal case, never a bypass. DEC-24: the idempotency key still comes
from the action semantics. Section 4.10: the distance commits with the
approval in one transaction, or not at all.

## Decisions affected

none. The register fixes the measurement (section 4.10) and the approval
gate (DEC-12). It does not fix the capture mechanism for the final body.
Read-back is an implementation detail of that capture.

## Open questions

None. The email duplex adapter implements `DraftReadBack` and joins
`APPROVE_ADAPTER` as `imap-smtp`.
