---
name: evidence-gate-review
description: Reviews changes to the classifier, retriever, composer, groundedness check or policy engine for gate independence. Triggers when the user asks to change classification, retrieval, groundedness, thresholds, or scoring.
---

# Evidence Gate Review

This skill is advisory. The deterministic backstop is the eval suite in
`evals/`. It contains regressions for blended scores and classifier
temperature. The compliance pass in `REVIEW.md` is a second backstop.

The system has two independent gates: sample agreement and groundedness
coverage. DEC-05 mandates the independence. Section 3.2 of
`docs/v1-architecture.md` records why: agreement cannot find a confident
error.

## Checks

1. No code blends agreement and coverage into a single score. No weighted
   average, no product, no minimum that hides which gate failed.
2. Each gate reports its own result. The policy engine reads both values as
   separate inputs.
3. The classifier samples at a temperature above zero. The enforcement is an
   assertion in the code, not a comment.
4. RRF combines BM25 and dense results by rank only. No code averages BM25
   scores with cosine scores.
5. The groundedness thresholds stay at 0.70 (block) and 0.80 (send to a
   person). A change to a threshold cites the DEC that permits it. Both
   thresholds apply to the automatic path. A customer reply is gated by
   DEC-12 before the policy engine reads either one.

If any check fails, name the DEC that the change violates and stop.
