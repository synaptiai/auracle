---
name: decision-tracing
description: Traces behavioral changes to the decision register. Triggers on a request to change behavior, modify a component or add a feature. Triggers also on any change that touches what docs/v1-architecture.md specifies.
---

# Decision Tracing

This skill is advisory. The deterministic backstop is the commit hook. It
blocks a change to `docs/v1-architecture.md` without a DEC citation. The
compliance pass in `REVIEW.md` is a second backstop.

Section 2 of `docs/v1-architecture.md` holds the numbered decisions. The
decisions are the only design authority.

## Rules

1. A change to behavior must cite the DEC it obeys.
2. If a change cannot cite a DEC, state that it is an implementation detail.
   Implementation details can change freely.
3. If a change contradicts a DEC, stop. Do not proceed. Raise the conflict
   with the user and name the DEC that blocks the change.
4. If the change needs a decision the register does not contain, stop and ask.
   Do not invent decisions.
5. When the change cites a DEC, write a design record as `CONTRIBUTING.md`
   section 4 says. An implementation detail writes no record. Its rationale
   goes in the pull request.
