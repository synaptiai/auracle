---
name: adapter-capability-review
description: Reviews adapter and policy engine changes against capability guarantees. Triggers when the user asks to add or change an adapter, modify the policy engine, or touch the approval path.
---

# Adapter Capability Review

This skill is advisory. The deterministic backstop is the policy and approval
test suites. The compliance pass in `REVIEW.md` and the adversarial-reviewer
subagent are the readers behind them.

Every adapter declares a capability manifest. The policy engine reads it.
These rules come from DEC-03, DEC-06, DEC-12, DEC-14 and DEC-33.

## Checks

1. Each adapter declares a capability manifest. The manifest contains
   `supportsIdempotencyKey`, `supportsReadBack`, `supportsDraftState`,
   `supportsStructuredFields`, `supportsThreading` and `supportsLedgerReply`.
2. If `supportsIdempotencyKey` or `supportsReadBack` is false, every write
   action goes to the approval path. The risk tier does not change this. The
   intent does not change this. The system declares this decrease in autonomy.
3. No code path lets a customer-visible action run without approval. Customer
   replies always return `gated` from the policy engine.
4. Each customer reply carries a non-empty `disclosure` field and provenance
   metadata. The approval bridge refuses a reply that lacks either one.

If any check fails, name the DEC that the change violates and stop.
