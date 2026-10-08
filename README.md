# Auracle

[![Tests][tests-badge]][tests] [![License][license-badge]](LICENSE)

[tests-badge]: https://github.com/synaptiai/auracle/actions/workflows/tests.yml/badge.svg
[tests]: https://github.com/synaptiai/auracle/actions/workflows/tests.yml
[license-badge]: https://img.shields.io/badge/license-Apache--2.0-blue.svg

Auracle is a reference architecture for agentic customer support. A language
model classifies each inbound message, finds the documents that answer it and
drafts a reply. The system acts alone only when two independent gates pass.
Every reply to a customer still waits for a person to approve it.

**Who it is for.** Teams who build or evaluate support automation and want a
design they can read, run and test end to end. The code is TypeScript on
Postgres, with no orchestration framework.

**What it is not.** It is not a hosted product, and nothing publishes it to
npm. It is a working system to study, run on your own infrastructure and adapt.

**Status.** Version 0.1, the first public release. Every number this
repository publishes comes from a synthetic corpus. So the numbers test the
pipeline, not the quality of the answers.

**License.** Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Concepts

| Term | Meaning |
|---|---|
| Ticket | A customer's request, as the helpdesk holds it. |
| Turn | One inbound message of a ticket's conversation. |
| Intent | What a turn asks for, such as a refund or a copy of an invoice. The classifier names it. |
| Classifier | The step that asks the model for a turn's intent. |
| Temperature | The model setting that lets repeated samples of one question differ. Above zero, they can. |
| Retriever | The step that finds the documents that may answer a turn. |
| Composer | The step that drafts a reply from the retrieved documents, or abstains. |
| Run | One pass of the pipeline over one turn. |
| Case | One turn that someone judges: a reviewer in the console, or a scorer in the gold set. |
| Ledger | The Postgres database that records every ticket, turn, run and action. |
| Step journal | The ledger table where a run records each step before it acts. |
| Coverage | The share of a draft's claims that the retrieved documents support. Higher is better. |
| Agreement | The share of the nine classifier samples that name the same intent. Higher is better. |
| Policy engine | The code that decides, from the evidence and the rules, whether the system acts alone. It calls no model. |
| Gate | A rule the policy engine applies before the system acts alone. The agreement gate reads agreement, and the groundedness gate reads coverage. |
| Agreement threshold | Agreement below it escalates the turn. |
| Block threshold, review threshold | The groundedness gate's two thresholds. Coverage below the block threshold escalates the turn, and coverage below the review threshold parks it. |
| Internal write | An action that changes a helpdesk ticket and sends nothing to the customer, such as closing or routing it. |
| Automatic path | The route where the system acts alone, with no person. Only an internal write can take it. |
| Abstain | The composer's answer when no retrieved document supports a reply. |
| Park | Keep an action waiting until a person approves it. A customer reply waits as a helpdesk draft, and an internal write waits in the ledger. |
| Escalate | Hand the turn to a person, with no action for them to approve. A parked turn has an action ready, and an escalated turn has none. |
| Outbox | The table an action waits in until the relay sends it. It commits with the state change that caused it. |
| Adapter | The code that connects the system to one helpdesk or mailbox. It declares what it supports. |
| Idempotency | An adapter's guarantee that a repeated send of one action has the effect of one send. |
| Read-back | An adapter's ability to read an action's result back from the helpdesk. It tells the system whether a send arrived. |
| Consumer | The daemon that takes each turn through the pipeline. |
| Relay | The daemon that sends each outbox action to the helpdesk adapter. |
| Daemon | A long-running process: the webhook, the IMAP poller, the consumer, the relay or the console. |
| Gold set | The labeled synthetic turns that fit and measure the gate thresholds. Each turn in it is a case. |
| Fit half, report half | The gold set's two halves. A threshold comes from the fit half, and a published rate comes from the report half. |
| Risk tier | The risk class of an intent: low, medium or high. A high-tier intent always goes to a person. |
| Control band | A daily metric with the range it should stay inside. |
| Containment | The share of cases the policy engine sends down the automatic path. Neither direction is better in itself: read it beside action match. |
| Routing decision | The policy engine's answer for a turn: act alone, park or escalate. |
| Action match | The share of cases whose routing decision matches the recorded outcome. Higher is better. |
| Stub model | A deterministic stand-in for the model. It returns a fixed answer and costs nothing. |
| Corpus | The synthetic tickets, documents and gold set under `fixtures/`. The generator, `scripts/generate-fixtures.mjs`, writes all of it. |
| Replay | An offline run of the classifier and the policy engine over the gold set's tickets. Action match scores it against each ticket's recorded outcome. |
| Interval | A 95 percent confidence interval around a rate. A narrower interval is more certain. |
| Register | The [decision register](docs/v1-architecture.md), which holds every design decision. |
| DEC | A numbered decision in the register. DEC-01 to DEC-51 are the design authority. |

The register's [appendix](docs/v1-architecture.md#appendix-technical-names)
defines every technical name it uses.

## What it does

One turn moves through these steps. The
[architecture map](docs/architecture-map.md) draws the same path.

1. **Intake.** A webhook or an IMAP mailbox delivers the message. Intake
   stores it as a ticket and a turn in the ledger.
2. **Classification.** The classifier asks the model for the turn's intent
   nine times, at a temperature above zero (DEC-05).
3. **Retrieval.** The retriever finds the documents that may answer the turn.
   It merges a keyword ranking and a vector ranking by rank alone (DEC-21).
4. **Composition.** The composer drafts a reply that cites its sources, or it
   abstains (DEC-07).
5. **Groundedness.** A check tests each claim of the draft against the
   retrieved documents, and that gives the draft's coverage (DEC-07).
6. **Policy.** The policy engine reads agreement, coverage and the risk tier
   of the intent. It decides whether the system acts alone, parks the action
   for a person, or escalates (DEC-03, DEC-13).
7. **Action.** The policy engine applies its rules before it reads the
   gates. A customer reply parks, whatever the gates read (DEC-12). So do an
   irreversible internal write (DEC-03, DEC-34) and a high-tier intent
   (DEC-13). So does an internal write through an adapter that lacks
   idempotency or read-back (DEC-06). Any other internal write then reaches
   the gates. It escalates below the agreement threshold or the block
   threshold. It parks below the review threshold. At or above all three, it
   takes the automatic path, through the outbox.
8. **Approval.** A person approves or rejects each parked action, in the
   helpdesk or in the operator console (DEC-11, DEC-40, DEC-44).

The two gates stay separate (DEC-05). Each one catches a failure the other
cannot see, and one blended score can pass while either gate fails.

Adapters connect the system to a helpdesk. The repository ships three: a
reference adapter that sends nothing, an IMAP and SMTP mailbox, and FreeScout.

## Quickstart

This path takes a fresh clone to passing tests and a running console with a
seeded history. It runs on your own machine and needs no model API key. The
next section, [Run the live pipeline](#run-the-live-pipeline), adds the key.

### Prerequisites

- **Node 22.13 or later.** `.nvmrc` names the major version.
- **pnpm 11.20.0.** On Node 22 to 24, run `corepack enable`. Node 25 and
  later ship no corepack, so run `npm install -g pnpm@11.20.0` there.
- **Docker** with Compose, for Postgres and a test mail server.
- **Python 3.10 or later**, for the documentation and guard checks.
- **git.**

### Set up and test

```sh
git clone https://github.com/synaptiai/auracle.git
cd auracle
./scripts/bootstrap.sh
docker compose --profile test up -d --wait
export DATABASE_URL=postgres://auracle:auracle@localhost:5433/auracle
export READER_DATABASE_URL=postgres://auracle_reader:auracle_reader@localhost:5433/auracle
export MAIL_HOST=127.0.0.1
pnpm run db:migrate
pnpm run verify:fast
```

- `./scripts/bootstrap.sh` installs the dependencies from the lockfile,
  installs the commit hook and copies `.env.example` to `.env`. It changes
  nothing that already exists.
- The compose stack starts Postgres with pgvector, its vector-search
  extension, on port 5433. It also starts GreenMail, a test mail server, on
  ports 3025 and 3143. Every port binds `127.0.0.1`. `--wait` returns once
  both answer, so the migration never meets a database that is still starting.
- The three variables point every command at that stack. Some commands read
  no `.env` file, so export them in your shell.
- `pnpm run db:migrate` creates the schema and `auracle_reader`, the
  read-only database role the console connects as.
- `pnpm run verify:fast` runs the type check, the lint and the unit tests. It
  also runs the documentation, style and guard checks and the fixtures diff.
  It needs no database.

`pnpm run verify` is the full check a pull request must pass. It adds the
database and mail suites, so it needs both services:

```sh
pnpm run verify
```

### See the operator console

```sh
pnpm run reviewers -- --add reviewer@example.test
pnpm run seed-history
CONSOLE_DEV_REVIEWER=reviewer@example.test pnpm run dev:console
```

Then open <http://127.0.0.1:8787>. The console shows the queue of cases that
need a person.

- `reviewers -- --add` puts a reviewer on the roster. The console serves only
  a reviewer on the roster.
- `seed-history` writes 45 days of synthetic traffic through the real ledger
  path. It needs no model.
- `CONSOLE_DEV_REVIEWER` names that reviewer for a console run from source on
  loopback, the local address `127.0.0.1`. A deployed console reads the
  reviewer from a trusted proxy instead, as [the runbook](docs/operations.md)
  describes.

## Run the live pipeline

The daemons process real tickets, and the consumer calls a model. Before any
daemon takes real traffic, read [SECURITY.md](SECURITY.md) and the
[compliance position](#compliance-position) below. The webhook accepts every
request until you set `WEBHOOK_SECRET`, and the console needs a proxy that
authenticates each reviewer.

Put an [OpenRouter](https://openrouter.ai) key in `.env` as
`OPENROUTER_API_KEY` first. Without it, the consumer refuses to start with
`OPENROUTER_API_KEY is not set.`

The offline jobs that call a model need the key too, and some need more:

| Command | Also needs |
|---|---|
| `pnpm run induce` | Nothing more |
| `pnpm run load-docs -- <dir>` | A directory of markdown documents to embed |
| `pnpm run calibrate` | `CALIBRATION_MODEL_VER`, the classifier model to calibrate |
| `pnpm run fit-groundedness` | `GROUNDEDNESS_MODEL_VER`, the model that checks each claim |
| `pnpm run report-groundedness` | `GROUNDEDNESS_MODEL_VER`, and a pair from `fit-groundedness` |

Each model version must equal the consumer's `MODEL_VER`. The consumer refuses
a threshold from a different model. A job that lacks what it needs
names it and refuses to start. The jobs `replay`, `gold-report` and `triage`
use a deterministic stub model and need no key.

[The runbook](docs/operations.md) covers each daemon, each variable and the
container image.

## Documentation

| Document | What it gives you |
|---|---|
| [The architecture map](docs/architecture-map.md) | Three diagrams of the system, with a legend for every box |
| [The quick map](docs/quick-map.md) | Which decisions each source directory answers to |
| [The decision register](docs/v1-architecture.md) | DEC-01 to DEC-51, the only design authority |
| [The runbook](docs/operations.md) | Every daemon, command and variable an operator uses |
| [The V2 roadmap](docs/v2-roadmap.md) | What is left, and what blocks each item |
| [The contributing guide](CONTRIBUTING.md) | From a clean checkout to a merged change |
| [The review guide](REVIEW.md) | The three passes every change makes |
| [The playbook](docs/agentic-support-playbook.html) | The narrative argument for this design ([PDF](docs/agentic-support-playbook.pdf)) |

## Compliance position

This section states the compliance position, as DEC-19 requires. No machine
check can decide who controls the data, so this document carries it.

**Personal data stays in the runtime path (DEC-15).** The system removes no
personal data from a model call. Instead, you sign a Data Processing Agreement
with the model provider. It binds the provider to process the data on your
instructions alone. You are the data controller (section 6 of the register).

**The model data guarantee is configurable (DEC-17).** Retention is a
contract term, not a technical setting. You choose the data position with the
provider, and you document your choice. Set `AURACLE_ZDR_ONLY=1` to ask the
provider for zero retention on every call. Absence means off, as DEC-17
requires.

**The default chat model answers under that setting (DEC-26).** The default
is `z-ai/glm-5.3-flash`, and `MODEL_VER` overrides it. Not every model offers
a zero-retention endpoint. A model that offers none fails the call, so the
setting never degrades to silent retention. You own the pin and the position
it implies.

**The ledger stores customer message text (DEC-17, DEC-19).**
`turn.body_text` holds each inbound message. `turn.approved_reply_text` holds
the reply a person approves. Both live for the life of the conversation.

**The step journal stores drafted replies and cited documents (DEC-17,
DEC-19).** `step_journal.result` holds the claims of each draft, on every run
that composed one. Together the claims are the drafted reply, so the journal
holds it whether or not a person sees it.

The journal also holds the body of each document a claim cited. It holds the
title, owner and review date of every document the run retrieved. A run that
parks holds the draft a second time, under the park step. A closed case holds
the reason its reviewer records, beside that reviewer's name. An erasure path
that clears only the `turn` columns leaves all of this behind.

**The console shows each reviewer's figures to every reviewer (DEC-45,
DEC-46).** The team screen has a row for each active reviewer. The row gives
the cases each reviewer takes and their time on support, over seven days. It
also gives the documents each reviewer authors and the cases each one has now.

The console has no roles, so every reviewer on the roster sees every row.
These are figures about named members of your staff. You are the data
controller, so you decide whether your staff see them.

**You own retention and erasure.** This repository ships no retention job and
no purge job. Plan the retention period and the erasure path before you carry
real traffic.

**Labeled real history lives outside this repository (DEC-18, DEC-31).** The
offline jobs accept a labeled half drawn from your own mailbox. Such a half
holds real customer text, so it stays under `corpus/`, which git ignores. That
directory holds your real history, not the synthetic corpus. Keep `corpus/`
ignored.

An artifact fitted on such a half records `gold_source: "real"` and belongs to
your deployment alone. You own its retention and its erasure.

**The prompt-log path is off by default (section 6).** It needs an explicit
override. If you turn it on, the provider gains irrevocable commercial
rights to the inputs and the outputs. In return, the provider lowers its price
by 1 percent.

**No standard yet verifies Article 50(2) text marking (section 4.9).** The
register records that EU AI Act Article 50(1) applies now. It records that
Article 50(2) applies from 2 December 2026, after a grace period of four
months. That grace period covers only systems on the market before 2 August
2026. This system is not one of them.

So on the register's reading, Article 50(2) applies to this system now. Its
date is 2 August 2026, which is past. Confirm the date that applies to your
deployment with legal advice.

The system adds provenance metadata to each generated text (DEC-33). The
metadata is structured, so a machine can read it after export. A line of
disclosure text does not survive export, so it cannot mark the text alone.
Adapters carry the metadata in headers where the channel permits them.

C2PA, the content provenance standard, covers images, audio and video. Text
has no equivalent standard. The architecture cannot decide whether this method
satisfies Article 50(2). Get legal advice before you go live.

**Synthetic fixtures only (DEC-18).** The fixtures contain invented values
only. Never commit a real email address, phone number, name or account
identifier.

## Published numbers

The published numbers live in `gold-report/v9.json`. They exercise the
pipeline, and they do not measure answer quality. The artifact says so
itself: `scored_by` reads `stub`.

The offline stub model returns one fixed label for each ticket text. So the
classifier agrees with itself on every sample, and the agreement gate never
fires. The report also pins coverage at 1.0, so the groundedness gate never
fires either. What remains is the routing decision over synthetic turns.

The artifact scores the report half of the gold set, and first turns only
(DEC-31, DEC-39). The report half holds 4100 cases, and 3074 of them open a
conversation. A later turn carries the outcome of the whole conversation, so
it grades no single decision. The numbers below cover those 3074 cases:

- Containment: 0.9424. Interval 0.9336 to 0.9501. 3074 cases.
- Action match: 0.8630. Interval 0.8504 to 0.8747. 3074 cases.

**Containment is a property of the corpus.** A high-tier intent always goes to
a person (DEC-03, DEC-13). So the policy engine never sends its cases down the
automatic path. In the corpus a few intents are common and most are rare. The
high-tier intents are among the rare ones. Read the figure as a statement
about the corpus, never as a measure of the system.

**Action match** compares the routing decision with the observable
outcome, such as a refund or an escalation (DEC-32). An intent label records
only a prediction, so it cannot grade the system.

These rates move whenever the corpus changes. The generator draws every value
again, so both halves change together. Run `pnpm run gold-report` to score the
current corpus.

The artifact records an agreement threshold of 0.60, and its source. A
`gate_source` of `seed` names the seed in section 4.5 of the register. A
`gate_source` of `calibration` names the calibration artifact that fits it.
Read the two fields together, because a fitted gate and a seeded gate publish
different numbers. `gate_calibration_scope` names the turns a calibration
reads. `scope` names the turns the report scores.

`coverage_fit_version` reads 3, which is the fit the next section describes.
The report pins coverage at 1.0, so the groundedness gate cannot move a rate.
Read that field as provenance, not as a result.

## The groundedness gate's thresholds

The groundedness gate has two thresholds. They decide an internal write that
no earlier rule holds back and that clears the agreement gate. Coverage below
the block threshold escalates the turn, and the write never runs. Coverage
below the review threshold parks the write for a person.

Neither threshold decides a customer reply (DEC-12) or a
high-tier intent (DEC-13). Neither decides an irreversible write (DEC-34) or a
write through an adapter that lacks idempotency or read-back (DEC-06). Each of
those already waits for a person.

`pnpm run fit-groundedness` fits the pair on the fit half, which publishes
nothing (DEC-31). The reference fit holds block 0.67 and review 0.83, from
`z-ai/glm-5.3-flash`. It records a spend of at least 0.1484 US dollars.

**Read this pair as a pilot.** The reference fit uses
`GROUNDEDNESS_LIMIT=1100`, so it reads the drafts of the first 1100 cases.
That is 26.8 percent of a half that holds 4100 cases. The model scores 1098
drafts and returns no verdict for 2. The corpus orders its intents, so that
slice covers 10 intents of 25. It holds every high-tier draft and no low-tier
draft.

The slice shows that supported and unsupported drafts separate, and that the
job selects a pair rather than refusing. It is not a fit of the whole half.

These figures come from that slice, and they choose the pair:

- Block: negative predictive value 0.958. Interval 0.920 to 0.979. 192 drafts.
- Review: precision 0.998. Interval 0.990 to 1.000. 539 drafts.

Negative predictive value is the share of blocked drafts that truly lack
support. Precision is the share of passed drafts that truly have it. Higher
is better for both. The fit requires at least 0.9 and 0.985, and each lower
bound clears its requirement.

**No report-half run covers this pair yet.** The figures above choose the
thresholds, so DEC-31 forbids reading them as a measurement of those
thresholds. Measure the pair 0.67 and 0.83 on the report half with
`pnpm run report-groundedness` before you trust it.

The reference fit does not ship as a live artifact. Git ignores the fitted
files under `groundedness/`. A committed fit moves your gate to a number
fitted on this synthetic corpus. `groundedness/reference-v3.json` is a
tracked copy you can read, and no loader finds it.

To measure that pair, copy `groundedness/reference-v3.json` to
`groundedness/v3.json` and set `GROUNDEDNESS_MODEL_VER=z-ai/glm-5.3-flash`.
The copy also moves the gate of every process in that checkout. The loader
reads the highest version, so move any fit of your own out of `groundedness/`
first. Otherwise fit your own.

## Judge triage selects cases, and scores nothing

DEC-09 names three ways to score a replay: action match, a sample a person
reviews, and judge triage. `pnpm run triage` runs the third. A judge selects
the cases that a person should review, and it records each selection with its
reason. By default the judge is the deterministic stub. The job never
produces a published number.

A judge shares the failures of the system it tests, so its output is a review
queue only. On the synthetic gold set this job is a demonstration.
[The runbook](docs/operations.md) says how to feed it live cases.

## Contributing, security and conduct

- [CONTRIBUTING.md](CONTRIBUTING.md) takes you from a clean checkout to a
  merged change.
- [SECURITY.md](SECURITY.md) says how to report a vulnerability privately,
  and what the default setup does not protect.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) applies to everyone who takes part.
- Open an [issue](https://github.com/synaptiai/auracle/issues) for a bug or a
  question.
