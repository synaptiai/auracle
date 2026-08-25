# AGENTS.md — Agentic Support System

## Commands

Each command is a single target. Each exits non-zero on failure.

- Build: `npm run build`. Healthy output: the compiler finishes with no errors and exit code 0.
- Test: `npm test`. Healthy output: every test passes, for example `Tests: 42 passed, 42 total`, exit code 0.
- Lint: `npm run lint`. Healthy output: no findings printed and exit code 0.

## Architecture

The authoritative design is `docs/v1-architecture.md`. It holds 33 numbered decisions, DEC-01 to DEC-33. The decisions are the only design authority. If a statement does not trace to a DEC, the statement is an implementation detail. You can change an implementation detail. You cannot change a DEC.

Core shape: TypeScript, a Postgres ledger (`tsvector` and `pgvector`), a plain state machine, a transactional outbox. No orchestration framework. Models come through OpenRouter.

## Conventions

- Keep two independent gates: sample agreement and groundedness coverage. Never blend them into one score (DEC-05).
- The classifier samples 9 times at a temperature above zero. Enforce this with an assertion, not a comment (section 4.5).
- The idempotency key comes from the action semantics. It never comes from the run identity (DEC-24, section 3.4).
- Commit the state change and the outbox insert in one transaction. Treat an insert of zero rows as a distinct result (section 4.2).
- The relay sends first and sets the status second (section 4.4).
- Groundedness below 0.70 blocks the reply. Groundedness below 0.80 sends it to a person (DEC-07).
- Customer replies always need approval and a non-empty `disclosure` field (DEC-12, DEC-14).
- The repository ships synthetic fixtures only. Never write real emails, phone numbers, names or account identifiers (DEC-18).
- Shipped markdown follows Simplified Technical English. Maximum 20 words per sentence, 6 sentences per paragraph, active voice, present tense.

## Things agents get wrong

- Blending agreement and coverage into one confidence score. The gates are independent (DEC-05, section 3.2).
- Setting the classifier temperature to zero. At zero, agreement is always 1.0 and the gate passes every ticket (section 4.5).
- Deriving the idempotency key from `run_id` or a timestamp. Two runs of the same action must produce the same key (section 3.4).
- Mixing BM25 scores and cosine scores in a weighted average. RRF uses ranks only (DEC-21, section 4.6).
- Retrying when the delivery state is unknown. Unknown means `delivery_unknown` and escalate (DEC-30).
- Scoring replay against intent labels. Action match scores against observable dispositions (DEC-32, section 4.10).

## Verifying your work

A task is not complete until the build, the tests and the lint all run. Paste the output of each one. Report what you ran and what you saw.
