---
title: V2 Design: Automatic Customer Replies (Phase 2 Exit Criteria)
author: code
tags: [v2, design, approval, phase-2-exit]
created_at: 2026-08-28T08:14:04Z
updated_at: 2026-08-28T08:14:04Z
---

# V2 Design: Automatic Customer Replies

Status: proposed, blocked (card f9b24a9c). Traces to section 1.2, section 5, section 6 and open item 1 of `docs/v1-architecture.md`.

## Verdict

This feature cannot ship from this repository today. Three independent gates block it. Each gate has a different owner.

- **B1: DEC-12 binds.** Internal writes are automatic. Customer replies need approval. The policy engine enforces this in code (`src/policy/policy.ts`). An agent cannot change a DEC. Only a person can amend the register.
- **B2: no exit decision exists.** Section 5 states the criteria to leave Phase 2 are not in V1. Open item 1 names the missing decision. The architecture deliberately does not make it. This document supplies the decision material. It does not make the decision.
- **B3: no data exists.** `bands.yaml` keeps the `approval_edit_distance` baselines null. `run.approval_edit_distance` stays null until a person approves a reply. The repository ships synthetic fixtures only (DEC-18). No live Phase 2 deployment runs.

This document changes no DEC and no code. It records the exit criteria a person can adopt, amend or reject.

## What the measurement can and cannot show

The approval-edit distance is live since card eb9f2284. It is a normalized token-level Levenshtein distance between the parked draft and the sent text. A value of 0.0 means the person changed nothing.

The measurement shows how far drafts sit from sendable text. It shows drift over time. It needs no labels and no counterfactual (section 4.10).

The measurement cannot show a confident error. An approver can accept a wrong draft unchanged. A distance of 0.0 then certifies a bad reply. Paragraph 3.2 states the same limit for agreement. All samples can agree on the wrong answer. Here, all approvals can rubber-stamp the wrong draft.

Section 6 states the second blind spot. The groundedness check is a model call. It can be wrong the same way each time. Section 6 says it plainly: if DEC-12 changes, that component is not sufficient alone. Any exit criteria must therefore rest on more than the two model gates.

## Proposed exit criteria (open item 1)

A person sets the final numbers, the same way as `GATE_AGREEMENT` (DEC-13). The seed values below follow the sensitivity math in section 4.10.

- **C1 Volume.** At least 470 approved replies in the window. Section 4.10 gives 470 cases for a 5 percent change and about 3 000 for 2 percent. Claims tighter than 5 percent need proportionally more data.
- **C2 Edit distance.** Median at or below 0.05. Ninetieth percentile at or below 0.20. Stable across the window, with no upward trend. The baselines in `bands.yaml` must carry live values first.
- **C3 Human audit of unchanged sends.** A person reads a sample of zero-edit approvals. The wrong-content rate stays below an agreed bound. This is the only signal that sees rubber-stamping. It is a second, independent gate in the DEC-05 sense.
- **C4 Groundedness floor.** Auto eligibility requires a groundedness value at or above 0.80. The review threshold becomes the auto floor. The 0.70 block stays on every path.
- **C5 Person-set intent eligibility.** Only intents a person marks eligible go automatic. The risk tier is the mechanism (DEC-13). A high tier never goes automatic. This is a defence with no model inside it.
- **C6 Disclosure and provenance stay mandatory.** DEC-14 and DEC-33 apply to every customer reply. No amendment relaxes them.
- **C7 Adapter floor.** Auto replies need `supportsIdempotencyKey` and `supportsReadBack` (DEC-06). With no person in the loop, the relay must reconcile delivery itself (DEC-30). Consequence: the reference email adapter cannot carry automatic replies. Its `readBack` throws (`src/adapters/imap-smtp.ts`). The helpdesk adapter qualifies. No production-eligible channel exists today: email fails `readBack`, and the helpdesk adapter is fixture-backed (DEC-18).
- **C8 Blast-radius cap.** A daily cap limits auto sends per eligible intent. A systematic failure stays bounded and visible. DEC-25 sets the same philosophy for cost: a limit makes damage visible, not a surprise.

## Rollout shape a DEC-12 amendment would take

Not implemented. Inventory only.

The rollout is graduated. One low-tier intent goes first, under a low cap. The whitelist grows only by a person's decision, one window at a time. One config value returns every reply to gating. Reverting needs no code change.

A sent email is an irreversible write. This links the amendment to open item 2, the compensation design. The compensation action class already gates unconditionally, so no conflict exists there.

Code surfaces the decision would touch:

- `src/policy/policy.ts`. The DEC-12 rule becomes conditional on intent eligibility. The capability and irreversibility rules stay above it in the rule order.
- `src/coordinator/coordinator.ts`. The gated branch parks a draft today. An eligible branch would compose, gate and queue the send without parking.
- `src/config/action-profile.ts`. The eligibility switch and the cap would live here, from environment variables.
- `bands.yaml`. Live baselines arrive before the first auto send, not after.
- Calibration (section 4.11) may fit the C2 and C3 numbers. One global threshold applies (DEC-13). Learned per-intent thresholds need about 8 000 labelled tickets (paragraph 3.3, open item 5).

## Traceability

| Concern | Decisions |
|---|---|
| Customer replies gate in V1 | DEC-12, section 1.2 |
| Exit criteria are a person's decision | section 5, open item 1 |
| Edit distance as the online measure | section 4.10 |
| Audit as a second independent signal | DEC-05, paragraph 3.2 |
| Groundedness alone is not sufficient | section 6 |
| Person-set tiers as the eligibility mechanism | DEC-13 |
| Disclosure and provenance survive any amendment | DEC-14, DEC-33 |
| Adapter capability floor for auto sends | DEC-06, DEC-30 |
| Bounded failure through limits | DEC-25 |

## Rejected alternatives

- **Ship behind a flag now.** A flag changes behaviour the register forbids. Section 6 warns that the gates alone do not make auto sends safe.
- **Exit on edit distance alone.** The metric is blind to confident errors. Paragraph 3.2 gives the reason by analogy.
- **Exit on gate scores alone.** Section 6 states the groundedness check is not sufficient alone. Agreement has the same limit.
- **Learned per-intent thresholds.** DEC-13 rejects them. Paragraph 3.3 gives the data cost.
- **A judge as exit evidence.** Section 4.10 states a judge shares the failures of the system it tests.

## Open items

- Who owns the Phase 2 exit decision. The adopter must name the person.
- The audit sample size and the wrong-content bound for C3.
- A legal re-check of Article 50(2) marking before any auto send (section 4.9). The text method is not verified.

---

## Superseded facts, recorded 2026-09-04

The text above stays as it was written on 2026-08-28. One of its blockers has
since changed, and the change is half of one blocker rather than a whole one.

**B3 said no data exists.** It still holds for the data. It no longer holds for
the tooling.

`pnpm run bands` now reports the four control-band metrics for one day, against
the thirty most recent measured days before it. So the approval-edit distance
that criterion C2 rests on is readable from the ledger alone. The command
arrived after this document was written.

The `bands.yaml` baselines stay null, and they fill only from an adopter's own
production traffic. B1 and B2 do not change at all.

One consequence of C7 is worth restating, because it is the only part of this
item a change to this repository can move. No egress adapter meets the C7
floor. The mail adapter declares `supportsReadBack: false` and its `readBack`
throws. The helpdesk adapter meets the floor and reaches no network. So an
automatic customer reply has no channel to leave through, whatever the register
later decides.

`docs/v2-roadmap.md` records that gap as the candidate next change.
