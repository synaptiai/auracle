---
name: adapter-capability-review
description: Reviews adapter and policy engine changes against capability guarantees. Triggers when the user asks to add an adapter, change an adapter, modify the policy engine, or touch the approval path.
---

# Adapter Capability Review

This skill is advisory. The deterministic backstop is the compliance pass in
`REVIEW.md`, supported by the adversarial-reviewer subagent.

Every adapter declares a capability manifest. The policy engine reads it.
These rules come from DEC-03, DEC-06, DEC-12 and DEC-14.

## Checks

1. A capability manifest is declared for each adapter. The manifest contains
   `supportsIdempotencyKey`, `supportsReadBack`, `supportsDraftState`,
   `supportsStructuredFields` and `supportsThreading`.
2. If `supportsIdempotencyKey` is false, every write action goes to the
   approval path. The risk tier does not change this. The intent does not
   change this. The system declares this decrease in autonomy.
3. No code path lets a customer-visible action run without approval. Customer
   replies always return `gated` from the policy engine.
4. Each customer reply carries a non-empty `disclosure` field and provenance
   metadata. The approval bridge refuses a reply that lacks either one.

If any check fails, name the DEC that the change violates and stop.
