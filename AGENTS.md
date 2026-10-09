# AGENTS.md — Auracle

This file holds the rules an agent needs to work in this tree. A person reads
`CONTRIBUTING.md` for the same workflow. Where a topic has a home in another
guide, this file points there and does not repeat it.

## Commands

`packageManager` in `package.json` pins pnpm. An `npm install` produces a
tree that no workflow validates.

`pnpm run verify` is the contract. It exits non-zero on failure.

```sh
pnpm run verify
```

It runs, in order: `build`, `check`, `lint`, `test`, the console's build,
check and test, `check:docs`, `check:ste`, `check:guards` and
`check:fixtures`. Healthy output ends with the `check:fixtures` summary line
and exit code 0. Of the evals, it runs the structural layer only.

`CONTRIBUTING.md` section 1 describes `verify:fast`, `verify:db` and each
target that runs alone. Its section 10 gives the exception for a change to
markdown alone.
`pnpm run check` is the fastest signal. It is not a substitute for `verify`.

The repository installs two TypeScript releases. TypeScript 7 builds and
type-checks, and every script calls it as `node_modules/typescript-7/bin/tsc`.
The `typescript` package is release 6. typescript-eslint and the source guards
load its compiler API, which TypeScript 7 does not ship. Both packages carry a
`tsc` binary, so a script names the one it means by path. In this file, `tsc`
names the TypeScript 7 compiler.

`check` runs three passes. The first is `tsc -b tsconfig.build.json`, which
builds the core and then the console. The second and third cover the test
files, which both build configs exclude because tests must not reach `dist/`.
They also cover both vitest configs. So a type error in a test appears here
and never in the build.

The first pass emits, so it is the same build `pnpm run build` runs. The build
is incremental, so a no-change build finishes almost at once. Each config
writes its own `tsBuildInfoFile` under `dist/`. Two configs that share one file
poison each other's state.

## Working from source

`tsc -b tsconfig.build.json` is a solution build. The console references the
core, so a rename inside `src/` that breaks the console fails the core's own
`pnpm run check`.

The reference acts under `tsc -b` alone. `tsc -p` does not build a referenced
project, so `pnpm run verify:console` needs a built core first. CI builds
before it runs that job.

`check` type-checks the console against the core's **source**, not its
compiled output. `tsc -b` compares file timestamps to decide what is up to
date. It skips a source file older than its build output. A check that
reads that stale output passes on broken code. An archive extraction or a
`cp -p` restore is enough to produce it.

Only `check` and `dev:console` read the core's source. The console's build,
its tests, `start` and the image read `dist/`. `dev:console` reads the source
through `console/tsconfig.dev.json`.

Five processes start from source with no build step:

```sh
pnpm run dev:webhook    pnpm run dev:imap      pnpm run dev:consumer
pnpm run dev:relay      pnpm run dev:console
```

They use `tsx`. Node's own type stripping cannot run this tree. It resolves a
NodeNext `./x.js` specifier literally, and no `.js` file exists in `src/`. It
also refuses a TypeScript parameter property, which several production
classes use.

`dev:console` also needs `READER_DATABASE_URL` exported, because its readers
connect as `auracle_reader`.

Two watch modes exist: `pnpm run check:watch` recompiles the solution, and
`pnpm run test:watch` reruns the unit project.

## Setup

The [README's Quickstart](README.md#quickstart) is the only full setup
sequence. Before you expose any port, read `SECURITY.md`, "What the default
setup does not protect". `docs/operations.md` holds the `.env` rules, the ports and the image.
This section adds what an agent working in the tree needs to know.

A `SessionStart` hook in `.claude/settings.json` runs `scripts/bootstrap.sh
--check`. That mode reports and changes nothing. The hook names a script this
repository tracks, so a branch could rewrite it. Installing packages and
writing an executable into `.git/hooks/` are things a person chooses.

`DATABASE_URL` and `MAIL_HOST` are the local test path. With both set, no
suite starts a throwaway container and no test opens a Docker socket. Without
them the suites load `testcontainers` through a dynamic import. A tree that
lacks it gets a sentence that names both ways out, not a resolution error.

`testcontainers` is a development dependency. Do not move it to
`optionalDependencies`, which puts it in the runtime image. Do not run
`pnpm install --no-optional` either. It also drops rollup's platform-native
package, and every vitest project then fails to collect.

Never commit `.env`. It holds `OPENROUTER_API_KEY`. `.env.example` names
every variable a process reads, with a comment on each.
`src/config/env-example.test.ts` reads every SCREAMING_SNAKE literal in a file
that mentions the environment, and fails on a name `.env.example` lacks.

## The `.claude/` directory

`.claude/` holds files for Claude Code. It is not optional for anyone else.
`pnpm run verify` runs the self-tests of its guards through `check:guards`.
The commit hook runs `.claude/hooks/commit_dec_citation.py` on every commit.
CI runs the PII guard and the citation guard on every pull request, and
the self-tests of all three guards. `CONTRIBUTING.md` section 6
describes each part and the session hooks.

## How to test a change

These rules decide what test you write. They apply to every agent and every
change.

1. Never write a unit test after you write the code. A test written after the
   code only restates what the code does. It catches no bug.
2. Prefer an end-to-end test, and make it the only test when you can. The
   suites under `src/e2e/` are the model. Use one to prove that a complex
   feature works.
3. Make each end-to-end test produce an artifact at its end. The artifact
   records the inputs, the seed and the observed end state. A second run from
   the same inputs produces the same artifact, so a reader can verify it.
4. Test a component in isolation only when an end-to-end test cannot reach the
   failure. First, write down every way that the component can fail. Then
   write the tests for that list. Then write the code.

`src/test-support/e2e-artifact.ts` implements rule 3. Each test settles its
artifact against a committed file under `src/e2e/artifacts/`. A difference
fails the test. The new text goes to a `.actual.json` file beside the
committed one, which git ignores. The committed file does not change, so a
second run fails too.

Rerun with `AURACLE_E2E_ACCEPT=1` only when you intend the change. Then
review `git diff -- src/e2e/artifacts` and commit the file.

A bug fix follows rule 4. Its regression test fails before the fix, as
`REVIEW.md` requires. Do not add a unit test that an end-to-end test already
covers. Do not add a test that asserts a mock, a constant or a type.

A test title says what the case proves, in plain words. It cites no issue
number. `src/test-support/test-titles.test.ts` fails a title that does.

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

Two suffixes and one list decide the project. A `*.test.ts` file is pure and
needs no database. A `*.db.test.ts` file needs Postgres, and the run supplies
it. `MAIL_SUITES` in `src/test-support/projects.ts` names the mail suites.

`src/test-support/purity.test.ts` enforces the suffix in both directions.
It parses each file with the TypeScript compiler.
It fails the run when a `*.test.ts` file imports `pg`, imports a module that
opens a connection, or calls `inject('dbUrl')`.
It also fails when a `*.db.test.ts` file needs none of those, because that
file makes Docker mandatory for no reason.
A type-only import of `pg` stays legal, because the compiler erases it.

The rules read one level deep, and they do not follow the import graph.
Importing `pg` opens no socket, and most pure suites reach it through
`src/db/config.ts`. A transitive rule condemns them all. So the `unit` project
sets `DATABASE_URL` and `READER_DATABASE_URL` to a port that refuses. A pure
suite that connects through a helper then fails where it stands. Without that
port, the suite passes against your own compose Postgres.

`test:unit` starts no container. It reaches no server except one it starts
itself on loopback, so it needs no Docker daemon. It runs the files in
parallel. Use it as the inner loop, and on any machine without Docker.

No database suite skips itself, and an unreachable database fails the run.
No mail suite skips itself either. A GreenMail server that never answers
fails the run.

`src/test-support/db-global-setup.ts` starts one throwaway pgvector container
per run. `src/test-support/mail-global-setup.ts` starts the GreenMail server as
well. Both setups share one Postgres, because `src/test-support/containers.ts`
starts it once. They run before the workers fork, so parallel runs never share
a database. Each mail suite owns its own mailboxes on the one server.

`pnpm run test:db` never waits for the JVM to answer IMAP. `pnpm test` waits
for it, because Vitest completes the setup of every project before it runs any
file. So the split pays on the inner loop, not on the combined run.

With `DATABASE_URL` and `MAIL_HOST` set, as "Setup" says, the run targets
those servers, with `MAIL_SMTP_PORT` and `MAIL_IMAP_PORT` beside the second.
The global setup probes both first with a
`SELECT 1` or a connection, and an unreachable one fails the run. Start the
server, or unset the variable.

The setup also restates `auracle_reader` on that server, with a known password.
It refuses a server on another host unless `AURACLE_TEST_ALLOW_REMOTE_DB=1`.

The compose mail server outlives the run, unlike a throwaway container. So
each mail suite empties the mailboxes it owns before every test, through
`src/test-support/mailbox-reset.ts`.

The `db` project runs its files in parallel. Each file gets a database of its
own, cloned from a migrated template by `src/test-support/db-url.setup.ts`.
The suites truncate tables between tests, so two files that share one
database corrupt each other. The teardown of the run asserts that none did.

The `mail` project runs one file at a time. Both its suites drive the one
GreenMail server and own mailboxes on it. So that project sets
`maxWorkers: 1`. `pnpm run check` type-checks both vitest configs, so an
option vitest does not know fails the check.
Set `AURACLE_TEST_DB_REUSE=1` to keep one warm database between local runs.
Set `AURACLE_TEST_MAIL_REUSE=1` to keep the mail server warm the same way.

Two tests in `src/artifacts/versioned.test.ts` skip under root. They deny
access with a mode bit, and a mode bit never denies root. A skip is honest. A
pass is not.

`src/public/` holds the barrels another package may import. Its README states
the rule.

## Architecture

The authoritative design is `docs/v1-architecture.md`, the register. It holds
51 numbered decisions, DEC-01 to DEC-51. The decisions are the only design
authority. A statement that traces to no DEC is an implementation detail. You
can change an implementation detail. You cannot change a DEC.

Core shape: TypeScript, a Postgres ledger (`tsvector` and `pgvector`), a plain
state machine and a transactional outbox. No orchestration framework. Models
come through OpenRouter.

`docs/architecture-map.md` draws the same system in diagrams.

## Runtime shape

`src/coordinator/coordinator.ts` holds the state machine. No model controls
the flow.

It sequences and nothing else. Each step is a module under
`src/coordinator/steps/`, and each takes a run context and returns a step
result. So a step runs in a unit suite with no database behind it.

```
received -> classified -> retrieved -> composed -> gated
  -> executing          (automatic path, reversible internal writes)
  -> awaiting_approval  (every parked action, DEC-12, DEC-13, DEC-34)
  -> resolved | escalated | superseded | abandoned | closed
  -> snoozed           (waiting for a period or the customer, DEC-48)
```

Each step writes to `step_journal` before it acts.
`src/ledger/journal-write.ts` owns that table. It holds one column list, and
every module that journals a step writes through it.

Every run and outbox write carries a fencing epoch (DEC-28).
`src/ledger/insert.ts` owns that path. Read it before you write to the ledger.
The journal has no epoch column. A journal row is reachable through its run,
and the fenced write that created the run is what admits it.

The queue partitions on `hash(conversation_id) % N` (DEC-36). One consumer
owns each partition (DEC-27). A run with no conversation keys on the ticket id
instead. So two runs on one conversation never race. The epoch covers the
rebalance overlap, and the ticket keys it. So it still fences two
conversations that share one.

These processes run without stopping:

- `pnpm run webhook` and `pnpm run imap` take messages in.
- `pnpm run consumer` walks the state machine for its partitions.
- `pnpm run relay` drains the outbox to the adapters.
- `pnpm run console` serves the operator console.

Offline jobs never touch live traffic. `pnpm run calibrate`,
`pnpm run gold-report`, `pnpm run triage` and `pnpm run export-corpus` write
their result to a file, and `pnpm run replay` prints its report.

Intake signals the consumer on enqueue and the loop wakes on it, so a queue
wait sits far below `CONSUMER_INTERVAL_MS`. That variable is the ceiling for a
lost signal. `pnpm run latency` reports queue wait and service time per
partition. `pnpm run bands` reports the `bands.yaml` metrics for one day,
against the window that file sets. `latency` and `bands` issue SELECT
statements only, so they are safe against a live database.

`src/policy/policy.ts` is a pure function. It calls no model and reads no
state. Adapters declare their capabilities, and autonomy adapts to those
declarations (DEC-06).

`docs/operations.md` is the runbook. `README.md` states the published numbers
and the compliance position. `docs/v2-roadmap.md` states what is left in V2
and what blocks each item. `python3 scripts/check-docs.py` proves the diagram
structure, that each linked file exists, and the design index. It does not decide whether a
diagram is true.

## Conventions

- Keep two independent gates: sample agreement and coverage.
  Never blend them into one score (DEC-05).
- The classifier samples 9 times at a temperature above zero. Enforce this
  with an assertion, not a comment (section 4.5).
- The idempotency key comes from the action semantics. It never comes from the
  run identity (DEC-24, section 3.4).
- Commit the state change and the outbox insert in one transaction. Treat an
  insert of zero rows as a distinct result (section 4.2).
- The relay sends first and sets the status second (section 4.4).
- The coverage thresholds decide an internal write that no earlier rule holds
  back and that clears the agreement gate. Below the block threshold the run
  escalates. Below the review threshold the write parks for a person (DEC-07).
  A high-tier intent and an irreversible write park first (DEC-13, DEC-34). So
  does a write through an adapter that lacks idempotency or read-back (DEC-06).
- 0.70 and 0.80 are the section 4.7 seeds, not the operative pair.
  `pnpm run fit-groundedness` fits a pair. A process that holds a coverage
  artifact runs the fitted pair and logs `coverage_thresholds_fitted`.
- The thresholds never decide a customer reply. Such a reply already needs
  approval (DEC-12). The policy engine returns that verdict before it reads
  either threshold.
- Customer replies always need approval and a non-empty `disclosure` field
  (DEC-12, DEC-14).
- The repository ships synthetic fixtures only. Never write real emails, phone
  numbers, names or account identifiers (DEC-18). `fixtures/README.md` states
  where the guard blocks, where it only warns, and what it cannot read.
- Shipped markdown follows the five Simplified Technical English rules in
  `CONTRIBUTING.md` section 9.

## Change workflow

`CONTRIBUTING.md` sections 3 to 7 hold the procedure. You trace the change to
a DEC, write a design record when it cites one, and open the pull request.
The skill `decision-tracing` holds the tracing rules. `REVIEW.md` holds the
three-pass review and the table of what CI enforces. Do not expect CI to
catch the rest.

Fit thresholds on the fit half of the gold set. Report numbers from the
report half only (DEC-31). `scripts/generate-fixtures.mjs` regenerates the
corpus, and committed fixtures match its output byte for byte.

`evals/` holds prompt-level regressions for these guardrails.
`python3 evals/run.py` runs the structural layer with no model.

## Things agents get wrong

- Blending agreement and coverage into one confidence score. The gates are
  independent (DEC-05, section 3.2).
- Reading `gate_pass_rate` from the gate verdict alone. `evaluatePolicy`
  returns `gated` for five reasons before it compares agreement. They are a
  customer reply, a high-tier intent, an irreversible write, a missing
  idempotency capability and a missing read-back capability. The journaled `reason` says which rule decided.
  `reachedAgreementGate` says whether the comparison happened.
- Setting the classifier temperature to zero. At zero, agreement is always 1.0
  and the gate passes every ticket (section 4.5).
- Deriving the idempotency key from `run_id` or a timestamp. Two runs of the
  same request must produce the same key. A crash retry and a redelivered
  message are the same request (section 3.4, DEC-49).
- Mixing BM25 scores and cosine scores in a weighted average. RRF uses ranks
  only (DEC-21, section 4.6).
- Retrying when the delivery state is unknown. Unknown means `delivery_unknown`
  and escalate (DEC-30).
- Scoring replay against intent labels. Action match scores against
  observable dispositions (DEC-32, section 4.10).

## Verifying your work

A task is not complete until `pnpm run verify` exits 0, or `verify:fast` for
a change to markdown alone. Paste the output and the exit code. Report the
skip count from the test run, not only the pass count. Report what you ran
and what you saw.
