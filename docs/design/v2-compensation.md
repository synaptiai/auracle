---
title: V2 Compensation Design
author: ox-alpha
tags: [v2, approval, relay]
created_at: 2026-08-25T16:17:25Z
updated_at: 2026-08-25T16:17:25Z
---

# V2 Compensation Design

Status: accepted (card fd986527). Traces to section 1.2 and V2 open item 2 of `docs/v1-architecture.md`.

## Problem

DEC-03 limits V1 autonomy to writes the system can reverse. A sent refund cannot be reversed. When such an action lands wrongly — wrong amount, wrong ticket, stale evidence — the system needs a second action that repairs the damage. That second action is compensation.

## Decision

Compensation is a new action class, `compensate` (`COMPENSATION_ACTION_CLASS` in `src/relay/relay.ts`). It rides the existing dispatch port: the relay already routes every non-`customer_reply` class through `EgressAdapter.performAction`, so no relay routing change exists. Three properties distinguish it.

### 1. Delivery rule: at_most_once (DEC-29)

Each action class declares its delivery rule. Compensation declares `at_most_once`: a duplicate refund costs money, a dropped one is recoverable by a person. The existing `resolveSendFailure` matrix already covers this cell:

- Adapter with idempotency support: failures stay pending; the key dedupes retries.
- Adapter without idempotency, unknown delivery state: escalate (DEC-30).
- Adapter without idempotency, read-back `not_found`: escalate — no second attempt, ever.

The coordinator enforces the declaration with an assertion: a compensation input carrying any other delivery rule throws before any state change.

### 2. Always gated (extends DEC-03)

DEC-03 says the autonomy limit is a reversible write. So an irreversible write can never take the `'auto'` path, whatever the gate scores read — the same way customer replies always gate (DEC-12). The policy engine's `ActionClass` gains an `isIrreversible` property; a new rule after the DEC-12 check returns `'gated'` for irreversible writes. The coordinator forces this property true when the action class is `compensate`; a caller cannot mark compensation reversible.

### 3. Approval parks in the ledger only

The gated branch for compensation journals a `park` step carrying `{actionClass, delivery, body, payload}` and moves the run to `awaiting_approval`. It makes no adapter call:

- A compensation has no customer-visible draft. Parking one in the helpdesk (DEC-11) would leave a lingering unsent draft after approval, because approval queues a `performAction` record, not a `sendDraft` record.
- The composed answer text still lands in the journal as `body`: it is the rationale a person reads when approving, and it keeps the approval-edit-distance measurement (section 4.10) available.

`approveRun` generalizes its park-record parsing: `draftExternalId` becomes optional, an optional journaled `payload` object is accepted, and the outbox insert carries `{draftExternalId}` for drafts or the stored payload for compensation. The idempotency key derivation is unchanged — action semantics only (DEC-24).

## Traceability

| Concern | Decisions |
|---|---|
| New action class rides `performAction` | DEC-29 (per-class rules), DEC-06 (capability honesty) |
| `at_most_once` + escalate-on-unknown | DEC-29, DEC-30 |
| Irreversible writes never automatic | DEC-03, DEC-12 as precedent |
| Ledger-only park, one approval transaction | DEC-04 (outbox), DEC-28 (fencing), section 4.2 |
| Idempotency key from semantics | DEC-24 |

## Rejected alternatives

- **Route compensation through the draft path** (`createDraft` + `sendDraft`). Conflates a money-moving internal action with a customer message; leaves an unsent draft behind after approval.
- **Gate via risk tier alone** (`risk_tier: 'high'` per intent). Risk tiers are person-set per intent (DEC-13); a misconfigured tier would let a refund run automatically. The irreversibility belongs to the action class, not to the intent.
- **A saga/compensation framework** (Temporal-style). Violates DEC-04: the ledger plus outbox plus plain state machine already expresses park, approve, and relay.
- **Automatic compensation triggers** (detect the bad refund, compensate without a person). Out of scope: every compensation passes a person first, same as customer replies.

## Open items

- What detects that a prior irreversible action was wrong and proposes the compensation payload remains adopter-side; this card covers the mechanism only.
- Adopter UI for approvals stays DEC-11 helpdesk-side or CLI (`npm run approve`); no approval queue table exists yet.
