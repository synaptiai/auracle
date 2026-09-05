---
name: decision-tracing
description: Traces behavioural changes to the decision register. Triggers on a request to change behaviour, modify a component or add a feature. Triggers also on any change that touches what docs/v1-architecture.md specifies.
---

# Decision Tracing

This skill is advisory. The deterministic backstop is the commit hook. It
blocks a change to `docs/v1-architecture.md` without a DEC citation. The
compliance pass in `REVIEW.md` is a second backstop.

`docs/v1-architecture.md` holds 41 numbered decisions, DEC-01 to DEC-41. The
decisions are the only design authority.

## Rules

1. A change to behaviour must cite the DEC it obeys.
2. If a change cannot cite a DEC, state that it is an implementation detail.
   Implementation details can change freely.
3. If a change contradicts a DEC, stop. Do not proceed. Raise the conflict
   with the user and name the DEC that blocks the change.
4. If the change needs a decision the register does not contain, stop and ask.
   Do not invent decisions.
5. Record the DEC IDs in the intent file under "Decisions affected". Write
   "none" for implementation details.
