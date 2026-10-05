# AGENTS.md — Agentic Support System

## Commands

This repository uses pnpm, pinned by `packageManager` in `package.json`.
An `npm install` produces a tree that no workflow validates.

`pnpm run verify` is the contract. It exits non-zero on failure.
It reaches the console package too, so nothing is left unverified.

```sh
pnpm run verify
```

It runs, in order: `build`, `check`, `lint`, `test`, the console's build,
check and test, `check:docs`, `check:ste`, `check:guards` and
`check:fixtures`. Healthy output ends with the fixtures line and exit code 0.

`pnpm run verify:fast` is the inner loop. It needs no Docker and takes about
half a minute. It runs the unit project alone, so it proves nothing about a
database suite. It is not the contract.

It does type-check the console. `check` builds the solution first, and the
console is part of that. It runs none of the console's own tests.

`pnpm run verify:db` is the other half: the database and mail suites alone.
CI runs the two as parallel jobs, with a third for the console.

The individual targets still exist and are worth running alone while you work:
`pnpm run build`, `pnpm test`, `pnpm run lint`, `pnpm run test:unit`,
`pnpm run verify:console`.

`pnpm run check` is the fastest signal of all. Neither it nor
`pnpm run verify:fast` is a substitute for `pnpm run verify`.

The repository installs two TypeScript releases. TypeScript 7 builds and
type-checks, and every script calls it as `node_modules/typescript-7/bin/tsc`.
The `typescript` package is 6.0.3. typescript-eslint and the source guards
load its compiler API, which TypeScript 7 does not ship. Both packages carry a
`tsc` binary, so a script names the one it means by path. In this file, `tsc`
names the TypeScript 7 compiler.

`check` runs three passes. The first is `tsc -b tsconfig.build.json`, which
builds the core and then the console. The second and third cover the test
files, which both build configs exclude because tests must not reach `dist/`.
They also cover both vitest configs. So a type error in a test appears here
and never in the build.

The first pass emits, so it is the same build `pnpm run build` runs.

The build is incremental, so a no-change `pnpm run build` takes less than a
tenth of a second. Each config writes its own `tsBuildInfoFile` under `dist/`,
because two configs sharing one file poison each other's state.

## Working from source

`tsc -b tsconfig.build.json` is a solution build. The console references the
core, so a rename inside `src/` that breaks the console fails the core's own
`pnpm run check`. Before this, three commands passed and a fourth broke.

The reference acts under `tsc -b` alone. `tsc -p` does not build a referenced
project, so `pnpm run verify:console` still needs a built core first. CI
builds before it runs that job.

`check` type-checks the console against the core's **source**, not its
compiled output. `tsc -b` compares file timestamps to decide what is up to
date. A source file older than the build output is skipped. A check reading
that stale output would then pass on broken code. An archive extraction or a
`cp -p` restore is enough to produce it.

Five processes start from source with no build step:

```sh
pnpm run dev:webhook    pnpm run dev:imap      pnpm run dev:consumer
pnpm run dev:relay      pnpm run dev:console
```

They use `tsx`. Node's own type stripping cannot run this tree. It resolves a
NodeNext `./x.js` specifier literally, and no `.js` file exists in `src/`. It
also refuses a TypeScript parameter property, which five production classes
use. `dev:console` reads the core from `dist/`, so build once first.

Two watch modes exist: `pnpm run check:watch` recompiles the solution, and
`pnpm run test:watch` reruns the unit project.

## Setup

You need Node 22.13 or later and Docker.

```sh
./scripts/bootstrap.sh
docker compose --profile test up -d
export DATABASE_URL=postgres://auracle:auracle@localhost:5433/auracle
export MAIL_HOST=127.0.0.1
pnpm run db:migrate
```

`scripts/bootstrap.sh` does the steps that need no choice from you. It enables
corepack, installs from the frozen lockfile, installs the commit hook and
copies `.env.example` to `.env`. It is idempotent, and it overwrites nothing.

It starts no container and runs no migration. Both write, and it cannot know
which database you meant. It prints whatever is left, including the API key
nobody but you can supply.

A `SessionStart` hook in `.claude/settings.json` runs it with `--check`. That
mode reports and changes nothing. The hook names a script this repository
tracks, so a branch could rewrite it. Installing packages and writing an
executable into `.git/hooks/` are things a person chooses.

Compose publishes Postgres on host port 5433, because 5432 belonged to another
local stack. `AURACLE_DB_PORT` moves it. GreenMail sits behind the `test`
profile on 3025 and 3143, moved by `AURACLE_SMTP_PORT` and
`AURACLE_IMAP_PORT`. That server accepts any credentials, so the profile keeps
it out of the stack `.github/workflows/release.yml` deploys. A plain
`docker compose up -d` starts the ledger alone.
`pnpm run db:migrate` applies the SQL files under `db/` in order.

**The two variables are the local test path.** With `DATABASE_URL` and
`MAIL_HOST` set, no suite starts a throwaway container and no test opens a
Docker socket. Without them the suites fall back to `testcontainers`, which 95
packages hang off. It loads through a dynamic import. A tree that lacks it
gets a sentence naming both ways out, rather than a resolution error.

`testcontainers` stays a development dependency. `optionalDependencies` puts
it in the production graph, and the runtime image installs with `--prod`.
`pnpm install --no-optional` is not the lean install it looks like. It also
drops rollup's platform-native package. Every vitest project then fails to
collect.

Every CLI and daemon loads `./.env` through `process.loadEnvFile`. A shell variable always wins.
Three commands read no `.env` file: `pnpm run escalations`, `pnpm run triage` and `pnpm run export-corpus`.
The operator console reads none either, so its variables must be exported.
Never commit `.env`. It holds `OPENROUTER_API_KEY`.

`.env.example` names every variable a process reads, with a comment on each.
`src/config/env-example.test.ts` proves it stays complete.

That guard reads every SCREAMING_SNAKE literal in a file that mentions the
environment. A narrower rule missed three shapes. One module reads a parameter rather than
`process.env`. One reaches it through a helper that calls another helper. One
holds the name in a frozen record.

## The path to a running stack

One image holds all five processes, and its command picks one:

```sh
docker build -t auracle:local .
docker run --rm auracle:local            # prints the six it accepts
cp .env.example .env                     # OPENROUTER_API_KEY at least
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

The overlay sets `DATABASE_URL` itself and ignores the one in `.env`. That
file names `localhost:5433`, which is right for a checkout and is a
container's own loopback inside one.

Every published port binds `127.0.0.1`. The webhook ships with no secret and
accepts every request. The console serves nothing without an active reviewer
behind it, and a trusted proxy authenticates that reviewer (DEC-45). So a
proxy authenticates anything that reaches either from another machine.

The stack runs the migration first, as a service the daemons depend on. So no
process opens a connection to a ledger missing a table. `AURACLE_IMAGE` selects
the tag, and defaults to a local build.

A merge to `main` runs `.github/workflows/release.yml`, which builds that image
and pushes it to GHCR tagged with the commit SHA. The tag is the SHA and never
`latest`, because a tag that moves cannot be rolled back to. A second job deploys to the host the `dev` GitHub environment names.
That job says what is missing rather than failing when the environment
names no host.

## How to test a change

These rules decide what test you write. They apply to every agent and every change.

1. Never write a unit test after you write the code. A test written after the code
   only restates what the code does. It catches no bug.
2. Prefer an end-to-end test, and make it the only test when you can. The suites
   under `src/e2e/` are the model. Use one to prove that a complex feature works.
3. Make each end-to-end test produce an artifact at its end. The artifact records the
   inputs, the seed and the observed end state. A second run from the same inputs
   produces the same artifact, so a reader can verify it.
4. Test a component in isolation only when an end-to-end test cannot reach the failure.
   First, write down every way that the component can fail. Then write the tests
   for that list. Then write the code.

`src/test-support/e2e-artifact.ts` implements rule 3. Each case settles its artifact
against a committed file under `src/e2e/artifacts/`. A difference fails the case. The
new text goes to a `.actual.json` file beside the golden, which git ignores. The golden
does not change, so a second run fails too.

Rerun with `AURACLE_E2E_ACCEPT=1` only when
the change is intended. Then review `git diff -- src/e2e/artifacts` and commit the file.

A bug fix follows rule 4. Its regression test fails before the fix, as `REVIEW.md`
requires. Do not add a unit test that an end-to-end test already covers. Do not add
a test that asserts a mock, a constant or a type.

## Running one test

The runner is Vitest. Run one file or one case:

```sh
pnpm exec vitest run src/policy/policy.test.ts
pnpm exec vitest run src/policy/policy.test.ts -t 'blocks the reply'
```

Three projects exist. `pnpm test` runs all three. Each also runs alone:

```sh
pnpm run test:unit   # pure cases, no Docker
pnpm run test:db     # Postgres
pnpm run test:mail   # Postgres and a mail server
```

Two suffixes decide the project. A `*.test.ts` file is pure and needs no database.
A `*.db.test.ts` file needs Postgres. The run supplies it.

`src/test-support/purity.test.ts` enforces the suffix in both directions.
It parses each file with the TypeScript compiler.
It fails the run when a `*.test.ts` file imports `pg`, imports a module that
opens a connection, or calls `inject('dbUrl')`.
It also fails when a `*.db.test.ts` file needs none of those.
That file makes Docker mandatory for no reason.
A type-only import of `pg` stays legal, because the compiler erases it.

The rules read one level deep, and they do not follow the import graph.
Importing `pg` opens no socket, and 37 of the 68 pure suites already reach it
through `src/db/config.ts`. A transitive rule would condemn them all.
So the `unit` project also sets `DATABASE_URL` to a port that refuses.
A pure suite that connects through a helper then fails where it stands.
Without it that suite passes green against your own compose ledger.

`test:unit` starts no container and opens no socket. It needs no Docker daemon.
It runs the files in parallel and finishes in seconds.
Use it as the inner loop, and on any machine without Docker.

No database suite skips itself. An unreachable database fails the run.
No mail suite skips itself either. A GreenMail server that never answers fails the run.

A `SELECT 1` failure at import time means Docker, not the ledger.
Check the container count first. A loaded daemon drops connections.

`src/test-support/db-global-setup.ts` starts one throwaway pgvector container per run.
`src/test-support/mail-global-setup.ts` starts the GreenMail server as well.
Both setups share one Postgres, because `src/test-support/containers.ts` starts it once.
They run before the workers fork, so parallel runs never share a database.
Each mail suite owns its own mailboxes, because one server serves them both.

`pnpm run test:db` never waits for the JVM to answer IMAP. `pnpm test` still does.
Vitest completes every project's setup before it runs any file.
So the split pays on the inner loop, not on the combined run.

An explicit `DATABASE_URL` disables the container and targets that database instead.
`MAIL_HOST` does the same for the mail server, with `MAIL_SMTP_PORT` and
`MAIL_IMAP_PORT` beside it.
The setup probes both first. An unreachable one fails the run.
Without the probe every database suite skips itself and the run still exits 0.

The compose mail server outlives the run, unlike a throwaway container. So
each mail suite empties the mailboxes it owns before every case, through
`src/test-support/mailbox-reset.ts`. Without it a second run found the drafts
the first run left.

The `db` project runs its files in parallel. Each file gets a database of its
own, cloned from a migrated template by `src/test-support/db-url.setup.ts`.
The suites truncate tables between cases, so two files sharing one database
would corrupt each other. The run's teardown asserts that none did.

The `mail` project still runs one file at a time. Both its suites drive the
one GreenMail server and own mailboxes on it. So that project sets
`maxWorkers: 1`. `pnpm run check` type-checks both vitest configs, so an
option vitest does not know fails the check.
Set `AURACLE_TEST_DB_REUSE=1` to keep one warm database between local runs.
Set `AURACLE_TEST_MAIL_REUSE=1` to keep the mail server warm the same way.

Two cases in `src/artifacts/versioned.test.ts` skip under root. They deny access with
a mode bit, and a mode bit never denies root. A skip is honest. A pass is not.

`src/public/` holds the barrels another package may import: `ledger-read`,
`policy`, `domain`, `format` and `cli`. `package.json` publishes those names
and nothing else.

It used to publish `./dist/*`. That made every compiled file public API, and
the console reached 18 core modules through it. Two were CLI entry points,
loaded only to format a number.

## Architecture

The authoritative design is `docs/v1-architecture.md`. It holds 51 numbered decisions, DEC-01 to DEC-51. The decisions are the only design authority. If a statement does not trace to a DEC, the statement is an implementation detail. You can change an implementation detail. You cannot change a DEC.

Core shape: TypeScript, a Postgres ledger (`tsvector` and `pgvector`), a plain state machine, a transactional outbox. No orchestration framework. Models come through OpenRouter.

`docs/architecture-map.md` draws the same system in three diagrams.

## Runtime shape

`src/coordinator/coordinator.ts` holds the state machine. No model controls the flow.

It sequences and nothing else. Each step is a module under
`src/coordinator/steps/`, and each takes a run context and returns a step
result. So a step runs in a unit suite with no database behind it.

```
received -> classified -> retrieved -> composed -> gated
  -> executing          (automatic path, reversible internal writes)
  -> awaiting_approval  (customer replies, DEC-12)
  -> resolved | escalated | superseded | abandoned | closed
  -> snoozed           (waiting for a period or the customer, DEC-48)
```

Each step writes to `step_journal` before it acts.
`src/ledger/journal-write.ts` owns that table. It holds one column list, and
four modules write through it.

Every run and outbox write carries a fencing epoch (DEC-28).
`src/ledger/insert.ts` owns that path. Read it before you write to the ledger.
The journal has no epoch column. A journal row is reachable through its run,
and the fenced write that created the run is what admits it.

The queue partitions on `hash(conversation_id) % N` (DEC-36). One consumer owns each partition (DEC-27).
A run with no conversation keys on the ticket id instead.
So two runs on one conversation never race. The epoch covers the rebalance
overlap, and it is keyed on the ticket. So it still fences two conversations
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
  A hook and CI enforce this inside `fixtures/` and `evals/cases/`. Elsewhere they warn, and a reader owns the rule.
  Neither reads an image, and neither has a clause for a person's name. `REVIEW.md` records both gaps.
- Shipped markdown follows Simplified Technical English. Maximum 20 words per sentence, 6 sentences per paragraph, active voice, present tense.

## Change workflow

1. Trace the change to a DEC, or state that it is an implementation detail. The skill `decision-tracing` holds the rules.
2. Write a design record only when step 1 named a DEC. Copy `intent/TEMPLATE.md` to `docs/decisions/<short-title>.md`, fill every section and commit it with the change. Open "Decisions affected" with one line, `Affects: DEC-07, DEC-12`, naming every DEC the change cites. The declaration is read; the prose beside it is not, because "None. DEC-05 governs this" and "DEC-05 governs this, and none changes" say one thing in two words. A change that affects no decision writes no file; its rationale goes in the pull request. `scripts/check-docs.py` refuses four things. A record declaring `Affects: none`. A DEC section 2 of the register does not define. A record filed in a subdirectory. Any file left in `intent/` but the template. `intent/archive/` holds the records written before this rule, frozen.
3. Install the commit hook once: `cp hooks/commit-msg .git/hooks/commit-msg && chmod +x .git/hooks/commit-msg`.
   It blocks an edit to `docs/v1-architecture.md` that cites no DEC. `.github/workflows/guardrails.yml` runs the same check on every commit in the pull request.
4. Run the three-pass review in `REVIEW.md`: bugs, security, compliance.
5. Fit thresholds on the fit half of the gold set. Report numbers from the report half only (DEC-31).
   `scripts/generate-fixtures.mjs` regenerates the corpus. Committed fixtures match its output byte for byte.

`CONTRIBUTING.md` holds the full procedure. `scripts/ste-check.py` is the style checker.
Session hooks in `.claude/settings.json` block fixture PII and live database commands.
The live-database rule is not enforced on a pull request.

The design-record rule is enforced there. `scripts/check-docs.py` runs in CI
and reads both directories. It cannot tell that a change needed a record and wrote none,
because that depends on the diff. CI checks style rules 1 and 2 with
`scripts/ste-check.py`, and rules 3 to 5 need a reader. CI also diffs the
corpus against the generator.

No hook blocks a test edit during a bug fix. One did, and it blocked the
regression test a bug fix exists to add. `REVIEW.md` holds the rule now.

The PII guard is absolute inside `fixtures/` and `evals/cases/`. Elsewhere it
warns and does not block. A runbook may need to show what real data looks
like, and that is not the corpus.

`REVIEW.md` holds the full table. Do not expect CI to catch them.
`evals/` holds prompt-level regressions for these guardrails. `python3 evals/run.py` runs the structural layer with no model.

## Things agents get wrong

- Blending agreement and coverage into one confidence score. The gates are independent (DEC-05, section 3.2).
- Reading `gate_pass_rate` from the gate verdict alone. `evaluatePolicy` returns `gated` before
  agreement is compared. The reasons are a customer reply, a high-risk intent, an irreversible write,
  and a missing idempotency or read-back capability.
  The journalled `reason` says which rule decided; `reachedAgreementGate` says whether the comparison happened.
- Setting the classifier temperature to zero. At zero, agreement is always 1.0 and the gate passes every ticket (section 4.5).
- Deriving the idempotency key from `run_id` or a timestamp. Two runs of the same request must produce the same key. A crash retry and a redelivered message are the same request (section 3.4, DEC-49).
- Mixing BM25 scores and cosine scores in a weighted average. RRF uses ranks only (DEC-21, section 4.6).
- Retrying when the delivery state is unknown. Unknown means `delivery_unknown` and escalate (DEC-30).
- Scoring replay against intent labels. Action match scores against observable dispositions (DEC-32, section 4.10).

## Verifying your work

A task is not complete until `pnpm run verify` exits 0. Paste its output and the
exit code. Report the skip count from the test run, not only the pass count.
Report what you ran and what you saw.
