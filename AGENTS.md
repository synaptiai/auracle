# AGENTS.md — Agentic Support System

## Commands

This repository uses pnpm, pinned by `packageManager` in `package.json`.
An `npm install` produces a tree that no workflow validates.

Each command is a single target. Each exits non-zero on failure.

- Build: `pnpm run build`. Healthy output: the compiler finishes with no errors and exit code 0.
- Test: `pnpm test`. Healthy output: every test passes, for example `Tests: 42 passed, 42 total`, exit code 0.
- Lint: `pnpm run lint`. Healthy output: no findings printed and exit code 0.

The console is a second package, and these three targets do not reach it.
Run its own three as well, or you verify none of `console/`:

- `pnpm --filter @auracle/console build`
- `pnpm --filter @auracle/console check`
- `pnpm --filter @auracle/console test`

`pnpm run lint` is the exception. It reaches `console/` already.

`pnpm run check` runs the compiler with `--noEmit`. Use it as the fast inner loop.
It is not a substitute for the three targets above.

`check` uses `tsconfig.check.json`, which covers the test files too.
The build config excludes them, because they must not reach `dist/`.
So a type error in a test appears here and never in the build.

## Setup

You need Node 22 or later and Docker.

```sh
docker compose up -d
export DATABASE_URL=postgres://auracle:auracle@localhost:5433/auracle
pnpm install
pnpm run build
pnpm run db:migrate
```

The live-database guard blocks a bare `pnpm run db:migrate`, because the
command names no target. Name the target on the same line inside a session:
`DATABASE_URL=postgres://auracle:auracle@localhost:5433/auracle pnpm run db:migrate`.

Compose publishes Postgres on host port 5433. Port 5432 belongs to another local stack.
`pnpm run db:migrate` applies the SQL files under `db/` in order.

Every CLI and daemon loads `./.env` through `process.loadEnvFile`. A shell variable always wins.
Three commands read no `.env` file: `pnpm run escalations`, `pnpm run triage` and `pnpm run export-corpus`.
Never commit `.env`. It holds `OPENROUTER_API_KEY`.

## Running one test

The runner is Vitest. Run one file or one case:

```sh
pnpm exec vitest run src/policy/policy.test.ts
pnpm exec vitest run src/policy/policy.test.ts -t 'blocks the reply'
```

Two suffixes exist. A `*.test.ts` file is pure and needs no database.
A `*.db.test.ts` file needs Postgres. The run supplies it.

No database suite skips itself. An unreachable database fails the run.
No mail suite skips itself either. A GreenMail server that never answers fails the run.

A `SELECT 1` failure at import time means Docker, not the ledger.
Check the container count first. A loaded daemon drops connections.

`src/test-support/global-setup.ts` starts one throwaway pgvector container per run.
It also starts one GreenMail server and waits until it answers IMAP.
It runs before the workers fork, so parallel runs never share a database.
Each mail suite owns its own mailboxes, because one server now serves them all.

An explicit `DATABASE_URL` disables the container and targets that database instead.
The setup probes that database first. An unreachable one fails the run.
Without the probe every database suite skips itself and the run still exits 0.

`fileParallelism` is false because the suites truncate tables between cases.
Set `AURACLE_TEST_DB_REUSE=1` to keep one warm database between local runs.
Set `AURACLE_TEST_MAIL_REUSE=1` to keep the mail server warm the same way.

## Architecture

The authoritative design is `docs/v1-architecture.md`. It holds 41 numbered decisions, DEC-01 to DEC-41. The decisions are the only design authority. If a statement does not trace to a DEC, the statement is an implementation detail. You can change an implementation detail. You cannot change a DEC.

Core shape: TypeScript, a Postgres ledger (`tsvector` and `pgvector`), a plain state machine, a transactional outbox. No orchestration framework. Models come through OpenRouter.

`docs/architecture-map.md` draws the same system in three diagrams.

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

The queue partitions on `hash(conversation_id) % N` (DEC-36). One consumer owns each partition (DEC-27).
A run with no conversation keys on the ticket id instead.
So two runs on one conversation never race. The epoch covers the rebalance
overlap, and it is keyed on the ticket, so it still fences two conversations
that share one.

Four long-running processes exist:

- `pnpm run webhook` and `pnpm run imap` take messages in.
- `pnpm run consumer` walks the state machine for its partitions.
- `pnpm run relay` drains the outbox to the adapters.

Offline jobs write artifacts and never touch live traffic:
`pnpm run calibrate`, `pnpm run gold-report`, `pnpm run triage`, `pnpm run replay`, `pnpm run export-corpus`.
`pnpm run latency` reads the ledger and reports queue wait and service time per partition.
It measures V2 open item 7, which stays open because nobody has chosen a correction.

Intake signals the consumer on enqueue and the loop wakes on it, so a queue wait
sits far below `CONSUMER_INTERVAL_MS`. That variable is the ceiling for a lost signal.
`pnpm run bands` reads the ledger and reports the four `bands.yaml` metrics for one day.
It judges that day against the 30 most recent measured days before it.
Both issue SELECT statements only, so they are safe against a live database.

`src/policy/policy.ts` is a pure function. It calls no model and reads no state.
Adapters declare their capabilities, and autonomy adapts to those declarations (DEC-06).

`docs/operations.md` is the runbook. `README.md` states the published numbers and the compliance position.
`docs/v2-roadmap.md` states what is left in V2 and what blocks each item.
`python3 scripts/check-docs.py` proves the diagram structure, the links and the design index.
It decides structure and reference. It does not decide whether a diagram is true.

## Conventions

- Keep two independent gates: sample agreement and groundedness coverage. Never blend them into one score (DEC-05).
- The classifier samples 9 times at a temperature above zero. Enforce this with an assertion, not a comment (section 4.5).
- The idempotency key comes from the action semantics. It never comes from the run identity (DEC-24, section 3.4).
- Commit the state change and the outbox insert in one transaction. Treat an insert of zero rows as a distinct result (section 4.2).
- The relay sends first and sets the status second (section 4.4).
- Groundedness below the block threshold stops an automatic write. Below the review threshold a person sees it (DEC-07).
  0.70 and 0.80 are the section 4.7 seeds, not the operative pair. `pnpm run fit-groundedness` fits one,
  and a process holding a coverage artifact runs the fitted pair and logs `coverage_thresholds_fitted`.
  The thresholds never decide a customer reply. Such a reply already needs approval (DEC-12), and the
  policy engine returns that verdict before it reads either threshold.
- Customer replies always need approval and a non-empty `disclosure` field (DEC-12, DEC-14).
- The repository ships synthetic fixtures only. Never write real emails, phone numbers, names or account identifiers (DEC-18).
- Shipped markdown follows Simplified Technical English. Maximum 20 words per sentence, 6 sentences per paragraph, active voice, present tense.

## Change workflow

1. Trace the change to a DEC, or state that it is an implementation detail. The skill `decision-tracing` holds the rules.
2. Copy `intent/TEMPLATE.md` to `intent/<short-title>.md`. Fill every section and commit it with the change.
3. Install the commit hook once: `cp hooks/commit-msg .git/hooks/commit-msg && chmod +x .git/hooks/commit-msg`.
   It blocks an edit to `docs/v1-architecture.md` that cites no DEC. `.github/workflows/guardrails.yml` runs the same check on every commit in the pull request.
4. Run the three-pass review in `REVIEW.md`: bugs, security, compliance.
5. Fit thresholds on the fit half of the gold set. Report numbers from the report half only (DEC-31).
   `scripts/generate-fixtures.mjs` regenerates the corpus. Committed fixtures match its output byte for byte.

`CONTRIBUTING.md` holds the full procedure. `scripts/ste-check.py` is the style checker.
Session hooks in `.claude/settings.json` block fixture PII, test edits during a bug fix and live database commands.
The last two rules are not enforced on a pull request, and neither is the
intent-file rule. CI checks style rules 1 and 2 with `scripts/ste-check.py`,
and rules 3 to 5 need a reader. CI also diffs the corpus against the
generator.

`REVIEW.md` holds the full table. Do not expect CI to catch them.
`evals/` holds prompt-level regressions for these guardrails. `python3 evals/run.py` runs the structural layer with no model.

## Things agents get wrong

- Blending agreement and coverage into one confidence score. The gates are independent (DEC-05, section 3.2).
- Reading `gate_pass_rate` from the gate verdict alone. `evaluatePolicy` returns `gated` for a customer reply,
  a high-risk intent, an irreversible write, a missing idempotency capability and a missing read-back
  capability, all before agreement is compared.
  The journalled `reason` says which rule decided; `reachedAgreementGate` says whether the comparison happened.
- Setting the classifier temperature to zero. At zero, agreement is always 1.0 and the gate passes every ticket (section 4.5).
- Deriving the idempotency key from `run_id` or a timestamp. Two runs of the same action must produce the same key (section 3.4).
- Mixing BM25 scores and cosine scores in a weighted average. RRF uses ranks only (DEC-21, section 4.6).
- Retrying when the delivery state is unknown. Unknown means `delivery_unknown` and escalate (DEC-30).
- Scoring replay against intent labels. Action match scores against observable dispositions (DEC-32, section 4.10).

## Verifying your work

A task is not complete until the build, the tests and the lint all run. Paste the output of each one. Report what you ran and what you saw.
