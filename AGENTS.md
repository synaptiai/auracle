# AGENTS.md — Agentic Support System

## Commands

Each command is a single target. Each exits non-zero on failure.

- Build: `npm run build`. Healthy output: the compiler finishes with no errors and exit code 0.
- Test: `npm test`. Healthy output: every test passes, for example `Tests: 42 passed, 42 total`, exit code 0.
- Lint: `npm run lint`. Healthy output: no findings printed and exit code 0.

`npm run check` runs the compiler with `--noEmit`. Use it as the fast inner loop.
It is not a substitute for the three targets above.

## Setup

You need Node 22 or later and Docker.

```sh
docker compose up -d
export DATABASE_URL=postgres://auracle:auracle@localhost:5433/auracle
npm install
npm run build
npm run db:migrate
```

Compose publishes Postgres on host port 5433. Port 5432 belongs to another local stack.
`npm run db:migrate` applies the SQL files under `db/` in order.

Every CLI and daemon loads `./.env` through `process.loadEnvFile`. A shell variable always wins.
Three commands read no `.env` file: `npm run escalations`, `npm run triage` and `npm run export-corpus`.
Never commit `.env`. It holds `OPENROUTER_API_KEY`.

## Running one test

The runner is Vitest. Run one file or one case:

```sh
npx vitest run src/policy/policy.test.ts
npx vitest run src/policy/policy.test.ts -t 'blocks the reply'
```

Two suffixes exist. A `*.test.ts` file is pure and needs no database.
A `*.db.test.ts` file needs Postgres. It calls `tryConnect` and skips through `describe.skipIf` when the database is down.
A skipped database suite proves nothing. Check the summary for skips.

`src/test-support/global-setup.ts` starts one throwaway pgvector container per run.
It runs before the workers fork, so parallel runs never share a database.
An explicit `DATABASE_URL` disables the container and targets that database instead.
`fileParallelism` is false because the suites truncate tables between cases.
Set `AURACLE_TEST_DB_REUSE=1` to keep one warm container between local runs.

## Architecture

The authoritative design is `docs/v1-architecture.md`. It holds 33 numbered decisions, DEC-01 to DEC-33. The decisions are the only design authority. If a statement does not trace to a DEC, the statement is an implementation detail. You can change an implementation detail. You cannot change a DEC.

Core shape: TypeScript, a Postgres ledger (`tsvector` and `pgvector`), a plain state machine, a transactional outbox. No orchestration framework. Models come through OpenRouter.

## Runtime shape

`src/coordinator/coordinator.ts` holds the state machine. No model controls the flow.

```
received -> classified -> retrieved -> composed -> gated
  -> executing          (automatic path, reversible internal writes)
  -> awaiting_approval  (customer replies, DEC-12)
  -> resolved | escalated | superseded | abandoned
```

Each step writes to `step_journal` before it acts. Every write carries a fencing epoch (DEC-28).
`src/ledger/insert.ts` owns that path. Read it before you write to the ledger.
The queue partitions on `hash(ticket_id) % N`. One consumer owns each partition (DEC-27).
So two runs on one ticket never race. The epoch covers the rebalance overlap.

Four long-running processes exist:

- `npm run webhook` and `npm run imap` take messages in.
- `npm run consumer` walks the state machine for its partitions.
- `npm run relay` drains the outbox to the adapters.

Offline jobs write artifacts and never touch live traffic:
`npm run calibrate`, `npm run gold-report`, `npm run triage`, `npm run replay`, `npm run export-corpus`.

`src/policy/policy.ts` is a pure function. It calls no model and reads no state.
Adapters declare their capabilities, and autonomy adapts to those declarations (DEC-06).

`docs/operations.md` is the runbook. `README.md` states the published numbers and the compliance position.

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

## Change workflow

1. Trace the change to a DEC, or state that it is an implementation detail. The skill `decision-tracing` holds the rules.
2. Copy `intent/TEMPLATE.md` to `intent/<short-title>.md`. Fill every section and commit it with the change.
3. Install the commit hook once: `cp hooks/commit-msg .git/hooks/commit-msg && chmod +x .git/hooks/commit-msg`.
   It blocks an edit to `docs/v1-architecture.md` that cites no DEC. `.github/workflows/guardrails.yml` runs the same check.
4. Run the three-pass review in `REVIEW.md`: bugs, security, compliance.
5. Fit thresholds on the fit half of the gold set. Report numbers from the report half only (DEC-31).
   `scripts/generate-fixtures.mjs` regenerates the corpus. Committed fixtures match its output byte for byte.

`CONTRIBUTING.md` holds the full procedure and a Simplified Technical English checker.
Session hooks in `.claude/settings.json` block fixture PII, test edits during a bug fix and live database commands.
The last two rules have no CI surface. Do not expect CI to catch them.
`evals/` holds prompt-level regressions for these guardrails. `python3 evals/run.py` runs the structural layer with no model.

## Things agents get wrong

- Blending agreement and coverage into one confidence score. The gates are independent (DEC-05, section 3.2).
- Setting the classifier temperature to zero. At zero, agreement is always 1.0 and the gate passes every ticket (section 4.5).
- Deriving the idempotency key from `run_id` or a timestamp. Two runs of the same action must produce the same key (section 3.4).
- Mixing BM25 scores and cosine scores in a weighted average. RRF uses ranks only (DEC-21, section 4.6).
- Retrying when the delivery state is unknown. Unknown means `delivery_unknown` and escalate (DEC-30).
- Scoring replay against intent labels. Action match scores against observable dispositions (DEC-32, section 4.10).

## Verifying your work

A task is not complete until the build, the tests and the lint all run. Paste the output of each one. Report what you ran and what you saw.
