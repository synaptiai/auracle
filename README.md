# auracle

Auracle is a reference architecture for support automation with evidence gates.
The core is TypeScript. The ledger is Postgres. No orchestration framework runs the flow.

## What the system does

The system processes inbound support tickets under two independent evidence gates (DEC-05).
Each gate catches a failure that the other one cannot see.
The agreement gate catches a classifier that answers inconsistently.
The groundedness gate catches an answer that no retrieved source supports.
A single blended score can pass while one gate has failed, so the gates never merge.

Internal writes run automatically when both gates pass (DEC-12).
These writes are reversible, so a wrong one costs little to undo.
A customer reply is not reversible: the customer reads it and acts on it.
So each reply waits for approval by a person (DEC-12).

The design authority is `docs/v1-architecture.md`.
That document holds decisions DEC-01 to DEC-51.
This README states the compliance position per DEC-19.
No machine check can decide who controls the data, so the documents carry that position.

## Where to read next

| Document | What it gives you |
|---|---|
| [The quick map](docs/quick-map.md) | One screen: which decisions each `src/` directory answers to, and what turns red |
| [The architecture map](docs/architecture-map.md) | Three diagrams of the system, with a legend for every box |
| [The decision register](docs/v1-architecture.md) | DEC-01 to DEC-51. The only design authority |
| [The runbook](docs/operations.md) | What an operator runs, and in what order |
| [The V2 roadmap](docs/v2-roadmap.md) | What is left, what blocks it, and who owns each blocker |
| [The contributing guide](CONTRIBUTING.md) | A clean checkout to a merged change |
| [The review guide](REVIEW.md) | The three passes every change makes |
| [The playbook](docs/agentic-support-playbook.html) | The narrative case for this design, for a reader of prose rather than a register ([PDF](docs/agentic-support-playbook.pdf)) |

## The flow

One ticket moves through these steps.
[The architecture map](docs/architecture-map.md) draws the same path.
The list below carries the decisions, and the map carries the picture.

1. Intake normalizes the inbound message into a ticket and a message.
2. The ledger stores the state change and the outbox insert in one transaction.
   A crash then leaves both records or neither.
3. The classifier takes nine samples at a temperature above zero.
   At temperature zero every sample matches, so agreement would measure nothing.
4. The sample agreement gate compares the samples against a threshold (DEC-13, DEC-41).
   Below the labelled-case trigger that is one global threshold. 25 separate
   thresholds need about 2 400 labelled tickets (section 3.3). Above it the gate
   reads the threshold fitted for the ticket's own intent. It falls back to the
   global one for an intent that could not be fitted.
5. The retriever merges BM25 ranks and dense ranks with reciprocal rank fusion (DEC-21).
   Ranks fuse because raw scores differ in scale: BM25 has no upper limit and cosine stops at one.
6. The composer writes the answer with citations or abstains (DEC-07).
   An abstain is a correct output: it beats an answer with no source.
7. The groundedness check tests each claim against the retrieved sources (DEC-07).
   Coverage below the block threshold stops an automatic write. Below the review threshold a person sees it.
   The seeds are 0.70 and 0.80. `pnpm run fit-groundedness` fits the pair, and a process that holds a fit runs that pair instead.
   This repository's own fit reads 0.67 and 0.83, and it does not travel: see `groundedness/reference-v3.json`.
   The two thresholds never decide a customer reply, because a reply already needs approval (DEC-12).
8. The policy engine applies the gates and the risk tier of the intent.
9. Internal writes leave through the transactional outbox and the relay sends them.
   The relay sends first and sets the status second, so a crash cannot hide a send.
10. Customer replies enter the draft state of the helpdesk adapter (DEC-11).
    Reviewers act in the helpdesk or in the operator console (DEC-40, DEC-44).
11. A person approves or rejects each draft through the approval bridge.

## Run it

You need Node 22.13 or later and Docker.

### Tests

```sh
pnpm install
pnpm test
```

`pnpm test` provisions its own Postgres for each run.
A Testcontainers helper starts one throwaway pgvector Postgres per run (src/test-support/containers.ts) and removes it at the end.
Tests need no `docker compose up` and no `DATABASE_URL`.
If you export `DATABASE_URL`, the tests target that database and skip the container.
The setup probes that database before the run starts. An unreachable one fails the run.

### Dev database

```sh
docker compose up -d
export DATABASE_URL=postgres://auracle:auracle@localhost:5433/auracle
pnpm install
pnpm run build
pnpm run db:migrate
```

Compose starts Postgres 16 with pgvector on host port 5433.
`pnpm run db:migrate` applies every pending migration under `db/` to that database and records each version in `schema_version`.
Use this database for the daemons and the CLI tools below.
The daemons and the CLI tools refuse to start without `DATABASE_URL`.
A process that guesses its database processes real traffic against the wrong
one and reports health while it does. Set `AURACLE_ALLOW_COMPOSE_DEFAULT=1` to
allow the compose address for a local run.

| Command | Task |
|---------|------|
| `pnpm run calibrate` | Fits the agreement threshold on the fit half of the gold set. Writes a versioned artifact that the daemons then adopt. |
| `pnpm run fit-groundedness` | Fits the two coverage thresholds on the fit half. Refuses when the measured classes do not separate. |
| `pnpm run replay` | Runs the action-match replay over the fixture corpus. Uses the offline stub model. Needs no network and no database. |
| `pnpm run gold-report` | Scores the report half of the gold set. Writes `gold-report/vN.json`, the next version. |
| `pnpm run triage` | Selects cases for human review with the offline judge. Writes `triage/vN.json`, the next version. |
| `pnpm run relay` | Starts the outbox relay daemon. Configure `RELAY_ADAPTER` and `RELAY_INTERVAL_MS` if needed. |
| `pnpm run consumer` | Starts the partition consumer daemon. Set `CONSUMER_PARTITIONS` (for example `0,1`). Configure `CONSUMER_INTERVAL_MS` and `TICKET_DEADLINE_MS` if needed. |
| `pnpm run webhook` | Starts the webhook ingress server. Set `WEBHOOK_PORT` (default 8080) and `PARTITION_COUNT` (default 8). |
| `pnpm run imap` | Starts the IMAP ingress poller. Set `IMAP_HOST`, `IMAP_USER` and `IMAP_PASS`. |
| `pnpm run load-docs -- <dir>` | Embeds each markdown file in the directory into the `document` table. Needs `OPENROUTER_API_KEY`. |
| `pnpm run approve -- --run <run-id>` | Approves one gated customer reply through the approval bridge. |
| `pnpm run escalations` | Lists the runs that need a person now, with the reason. The command only reads the ledger. |
| `pnpm run latency` | Reports queue wait and service time per partition, so a partition falling behind is visible. Writes `latency/vN.json`. The command only reads the ledger. |
| `pnpm run bands` | Reports the four control-band metrics for one day against the 30 most recent measured days before it. Writes `bands/v<n>.json`. The command only reads the ledger. |

Notes on the consumers:

- The relay daemon and the partition consumer read work from the transactional outbox.
- Each action class declares its delivery rule (DEC-29). The daemons send according to that rule.
  A refund must not repeat, so it sends at most once and escalates when unsure.
  An abandoned ticket close costs nothing, so that class retries freely.
- The queue partitions by `conversation_id`, and one consumer owns each partition
  (DEC-27, DEC-36). All work on one conversation then lands on one consumer, so
  two runs never race on it. A message with no conversation keys on the ticket id.
- The webhook server and the IMAP poller run as their own daemons: `pnpm run webhook` and `pnpm run imap`.

## Compliance position

**Personal data stays in the runtime path (DEC-15).**
The system removes no personal data from requests.
Instead, you sign a Data Processing Agreement with the model provider.
The agreement binds the provider to process the data on your instructions alone.
You are the data controller (section 6).

**The model data guarantee is configurable (DEC-17).**
Retention is a contract term, not a technical setting.
You choose the data position with the provider and you document your choice.
Set `AURACLE_ZDR_ONLY=1` to ask the provider for zero retention on every call.
Absence means off, which DEC-17 requires: it rejects forcing the setting.

**The default chat model answers under that setting (DEC-26).**
The default is `z-ai/glm-5.3-flash`, and `MODEL_VER` overrides it.
Not every model offers a zero-retention endpoint.
A model that offers none fails the call, so the setting never degrades to
silent retention. You own the pin and the position it implies.

**The ledger stores customer message text (DEC-17, DEC-19).**
`turn.body_text` holds each inbound message and `turn.approved_reply_text` holds the reply a person approved. Both live for the life of the conversation.
Earlier versions kept that text only until the queue row was acked.

**The step journal stores drafted replies and cited documents (DEC-17, DEC-19).**
`step_journal.result` holds the claims of each draft on every run that composed one. The claims joined are the drafted reply. So the journal holds that reply, whether or not a person saw it.

It also holds the body of each document a claim cited. It holds the title, owner and review date of every document the run retrieved. A run that parks holds the draft a second time, under the park step. A closed case holds the reason its reviewer gave. The name beside it is an operator's and not a customer's. An erasure path that clears the `turn` columns alone leaves all of this behind.

**The console shows each reviewer's figures to every reviewer (DEC-45, DEC-46).**
The team screen has a row for each active reviewer. The row gives the cases
they held and their time on support over seven days. It also gives the
documents they wrote and the cases they hold now.

The console has no roles, so every reviewer on the roster sees every row.
These are figures about named members of your staff. You are the data
controller, so you decide whether your staff see them.

This repository ships no retention job and no purge job.
You are the data controller, so you own the retention period and the erasure
path. Plan both before you carry real traffic.

**Labeled real history lives outside this repository (DEC-18, DEC-31).**

The offline jobs accept a labeled half drawn from your own mailbox. Such a half holds
real customer text, so it stays under `corpus/`. That directory is gitignored
and must stay that way. Every number this repository publishes is measured on
the synthetic corpus. An artifact fitted on your history records `gold_source:
"real"` and belongs to your deployment alone. You are the data controller, so
you own its retention and its erasure.

**The prompt-log path is off by default (section 6).**
It needs an explicit override.
If you activate it, you give irrevocable commercial rights to the inputs and the outputs.
The provider pays a discount of 1 percent for this right.

**No standard yet verifies Article 50(2) text marking (section 4.9).**

EU AI Act Article 50(1) applies now. Article 50(2) applies from 2 December
2026. This system adds provenance metadata to each generated text (DEC-33). The
metadata is structured, so a machine can read it after export. A line of
disclosure prose does not survive that test. Adapters carry this metadata in
headers where they permit it.

C2PA covers images, audio and video. Text has no equivalent standard.
The architecture cannot decide if this method satisfies Article 50(2).
Get legal advice before you go live.

**Synthetic fixtures only (DEC-18).**
The fixtures contain only invented values.
Never commit real emails, phone numbers, names or account identifiers.

## Published numbers

The published numbers live in `gold-report/v9.json`.
They exercise the pipeline. They do not measure answer quality.
The artifact says so itself: `scored_by` reads `stub`.

The offline stub model returns one fixed label for each ticket text.
The classifier then agrees with itself on every sample.
So the agreement gate never fires.
The report also pins groundedness at 1.0, so that gate never fires either.

What remains is the routing decision over synthetic tickets.
The containment figure is the share of report tickets whose tier is not high.
Read these numbers as a smoke test of the pipeline.

The artifact scores the report half of the gold set only (DEC-31).
It scores first turns only, and records that scope (DEC-39).
Numbers from the fitting cases flatter the system, so reporting uses untouched cases.
No rate in this section comes from the fit half.
The coverage section below does quote fit-half figures, and it says there what they do and do not measure.

The report half holds 4100 cases and 3074 of them open a conversation.
The numbers below cover those 3074 cases.
A later turn carries the disposition of the whole thread, so it grades no
single decision.

These rates move whenever the corpus grows, and the first-turn filter is not
the only reason. The generator draws every value again, so both halves change
and a rate moves for both reasons at once. This repository tracks one gold
report at a time, so an earlier artifact is not here to compare against.

The source corpus is fully synthetic (DEC-18).
Run `pnpm run gold-report` to regenerate it.

- Containment: 0.9424. Interval 0.9336 to 0.9501. 3074 cases.
- Action match: 0.8630. Interval 0.8504 to 0.8747. 3074 cases.

**Read the containment figure with its cause.** It was 0.7970, and it did not
rise because the system improved. A high-risk intent always goes to a person
(DEC-03, DEC-13), so it is never contained.

The corpus now carries a Zipf-distributed intent frequency, which puts the
high-risk intents in the tail. The high tier fell from 635 first turns to 177.
Containment counts the cases a person never touched. A corpus holding fewer
high-risk cases therefore reports a higher rate at identical behaviour.

Containment is a property of the corpus, so it is measured here. Read it as a
statement about the fixture and never as a measure of the system.

Action match needs a classifier, so it needs a run. The figure above is the
first over the current corpus, scored by the offline stub. The earlier 0.793
covered 815 cases of a 2124-case corpus that no longer exists.

The artifact records an agreement gate threshold of 0.60.

It also records where that number came from. A `gate_source` of `seed` names
the section 4.5 seed. A `gate_source` of `calibration` names the artifact
version that fitted it. A fitted gate and a seeded gate publish different
numbers, so read the two fields together.

`gate_calibration_scope` names the turn population the threshold was fitted
on. The `scope` field names the population this report scored, which DEC-39
fixes at first turns. The two can differ.

`coverage_fit_version` reads 3, which is the fit the section below describes.
Rerunning the report at the new pair moved these three provenance fields and
no rate. The report pins groundedness at 1.0, so the coverage gate never fires
and cannot move a rate. Read the field as provenance and not as a result.

A fitted threshold does not move these rates. The offline stub answers every
sample of one ticket alike, so agreement is 1.0 on all 3074 scored cases. No
threshold below 1.0 changes a decision. The gate is wired and it binds at
runtime. This corpus cannot show it.

## The coverage gate, fitted

The second gate has been fitted on the half that publishes nothing (DEC-31).
The run used `z-ai/glm-5.3-flash`, and it read a slice of that half.

`pnpm run fit-groundedness` chose the pair on the fit half: block 0.67 and
review 0.83. It reports a spend of at least 0.1484 US dollars over 1098
drafts.

**Read this pair as a pilot.** The run was limited to 1100 drafts, and the
job takes a prefix. So it read 26.8 percent of a half holding 4100. The corpus
orders its intents, so that prefix covers 10 intents of 25. It holds every
high-tier draft and no low-tier draft.

It shows the classes separate and the job selects rather than refuses. It is
not a fit of the half. Run `pnpm run fit-groundedness` with no limit to get
one.

Those are the scored slice's own numbers, and they chose the pair:

- Block: negative predictive value 0.958. Interval 0.920 to 0.979. 192 drafts.
- Review: precision 0.998. Interval 0.990 to 1.000. 539 drafts.

Read both against the lower bound. Each clears its floor there.

**The report half is not measured at this pair.** The corpus was reshaped and
the pair moved with it. An earlier measurement stood here. It read the old
pair over the old corpus, so it is withdrawn and not restated.

So this gate carries no independent check today. The numbers above chose the
threshold, so DEC-31 forbids reading them as a measurement of it. They do
measure the slice they were fitted on, and nothing wider. Run `pnpm run
report-groundedness` on the report half before you trust the pair.

One planning figure went with the withdrawal. The old section priced the
residual error an adopter must plan around. No current measurement supports a
figure, so this README states none.

The fit does not ship as a live artifact. `groundedness/` is ignored. A
committed fit would move your gate to a number fitted on this repository's
synthetic corpus. `groundedness/reference-v3.json` is a tracked copy you can
read. No loader finds it. Fit your own.

Action match scores the routing decision against observable dispositions (DEC-32).
A disposition records what actually happened, for example a refund or an escalation.
An intent label records only a prediction, so it cannot grade the system honestly.
It does not measure answer quality.

## Judge triage is a selection tool, not a score

`pnpm run triage` runs replay method 3 (section 4.10, DEC-09).
A judge model selects the cases that go to a person for review.
It writes each selection and its reason to a versioned artifact.
It never gives a published number.

A judge shares the failures of the system it tests.
It is weakest where the evaluation matters most, so its output is a review queue only.
The numbers for the README come from `pnpm run gold-report` alone.

On the synthetic 8200-case gold set this job is a demonstration, not a tool.
It earns its keep when real volume exists to triage.
Inject live cases through `runTriageJob`; each case records its origin.
