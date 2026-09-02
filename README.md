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
That document holds decisions DEC-01 to DEC-39.
This README states the compliance position per DEC-19.
No machine check can decide who controls the data, so the documents carry that position.

## The flow

One ticket moves through these steps.

1. Intake normalizes the inbound message into a ticket and a message.
2. The ledger stores the state change and the outbox insert in one transaction.
   A crash then leaves both records or neither.
3. The classifier takes nine samples at a temperature above zero.
   At temperature zero every sample matches, so agreement would measure nothing.
4. The sample agreement gate compares the samples against one global threshold (DEC-13).
   One threshold exists because 25 separate thresholds need about 2 400 labelled tickets (section 3.3).
5. The retriever merges BM25 ranks and dense ranks with reciprocal rank fusion (DEC-21).
   Ranks fuse because raw scores differ in scale: BM25 has no upper limit and cosine stops at one.
6. The composer writes the answer with citations or abstains (DEC-07).
   An abstain is a correct output: it beats an answer with no source.
7. The groundedness check tests each claim against the retrieved sources (DEC-07).
   Coverage below the block threshold stops an automatic write. Below the review threshold a person sees it.
   The seeds are 0.70 and 0.80. `pnpm run fit-groundedness` fits the pair, and a process that holds a fit runs that pair instead.
   This repository's own fit reads 0.75 and 1.00, and it does not travel: see `groundedness/reference-v2.json`.
   The two thresholds never decide a customer reply, because a reply already needs approval (DEC-12).
8. The policy engine applies the gates and the risk tier of the intent.
9. Internal writes leave through the transactional outbox and the relay sends them.
   The relay sends first and sets the status second, so a crash cannot hide a send.
10. Customer replies enter the draft state of the helpdesk adapter (DEC-11).
    Reviewers act inside the helpdesk they already use, so approval adds no new tool.
11. A person approves or rejects each draft through the approval bridge.

## Run it

You need Node 22 or later and Docker.

### Tests

```sh
pnpm install
pnpm test
```

`pnpm test` provisions its own Postgres for each run.
A Testcontainers helper starts one throwaway pgvector Postgres per run (src/test-support/global-setup.ts) and removes it at the end.
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

The live-database guard blocks a bare `pnpm run db:migrate`, because the
command names no target. Name the target on the same line inside a session:
`DATABASE_URL=postgres://auracle:auracle@localhost:5433/auracle pnpm run db:migrate`.

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
`turn.body_text` holds each inbound message and `turn.approved_reply_text`
holds the reply a person approved. Both live for the life of the conversation.
Earlier versions kept that text only until the queue row was acked.
This repository ships no retention job and no purge job.
You are the data controller, so you own the retention period and the erasure
path. Plan both before you carry real traffic.

**Labeled real history lives outside this repository (DEC-18, DEC-31).**
The offline jobs accept a labeled half drawn from your own mailbox.
Such a half holds real customer text, so it stays under `corpus/`.
That directory is gitignored and must stay that way.
Every number this repository publishes is measured on the synthetic corpus.
An artifact fitted on your history records `gold_source: "real"` and belongs
to your deployment alone.
You are the data controller, so you own its retention and its erasure.

**The prompt-log path is off by default (section 6).**
It needs an explicit override.
If you activate it, you give irrevocable commercial rights to the inputs and the outputs.
The provider pays a discount of 1 percent for this right.

**No standard yet verifies Article 50(2) text marking (section 4.9).**
EU AI Act Article 50(1) applies now.
Article 50(2) applies from 2 December 2026.
This system adds provenance metadata to each generated text (DEC-33).
The metadata is structured, so a machine can read it after export.
A line of disclosure prose does not survive that test.
Adapters carry this metadata in headers where they permit it.

C2PA covers images, audio and video. Text has no equivalent standard.
The architecture cannot decide if this method satisfies Article 50(2).
Get legal advice before you go live.

**Synthetic fixtures only (DEC-18).**
The fixtures contain only invented values.
Never commit real emails, phone numbers, names or account identifiers.

## Published numbers

The published numbers live in `gold-report/v7.json`.
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
The fit half never touches a published number.

The report half holds 1062 cases and 815 of them open a conversation.
The numbers below cover those 815 cases.
A later turn carries the disposition of the whole thread, so it grades no
single decision.

Do not read the move from `v3.json` as the effect of that filter alone.
The corpus gained conversations, so the generator drew every value again.
Both halves changed, and the two numbers moved for both reasons at once.

The source corpus is fully synthetic (DEC-18).
Run `pnpm run gold-report` to regenerate it.

- Action match: 0.793. Interval 0.763 to 0.819. 815 cases.
- Containment: 0.805. Interval 0.776 to 0.831. 815 cases.

The artifact records an agreement gate threshold of 0.60.

It also records where that number came from. A `gate_source` of `seed` names
the section 4.5 seed. A `gate_source` of `calibration` names the artifact
version that fitted it. A fitted gate and a seeded gate publish different
numbers, so read the two fields together.

`gate_calibration_scope` names the turn population the threshold was fitted
on. The `scope` field names the population this report scored, which DEC-39
fixes at first turns. The two can differ.

A fitted threshold does not move these rates. The offline stub answers every
sample of one ticket alike, so agreement is 1.0 on all 815 scored cases and no
threshold below 1.0 changes a decision. The gate is wired and it binds at
runtime. This corpus cannot show it.

## The coverage gate, measured

The second gate has been fitted and then measured on the half that fitted
nothing (DEC-31). Both runs used `z-ai/glm-5.3-flash`.

`pnpm run fit-groundedness` chose the pair on the fit half: block 0.75 and
review 1.00. Two full passes produced that same pair, and the second reports a
spend of at least 0.1708 US dollars over 1043 drafts.
`pnpm run report-groundedness` then measured the pair on the report half, over
1053 drafts.

- Block: negative predictive value 0.9847. Interval 0.9647 to 0.9935. 327 drafts.
- Review: precision 0.9923. Interval 0.9804 to 0.9970. 520 drafts.

Read the review interval. Its lower bound is below the 0.985 target the fit
aims at. Four drafts of 520 scored full coverage and still carried a claim the
sources do not support.

The measured precision, 0.9923, is above the target. The interval is too wide
to prove that. At this error rate the proof needs 1050 drafts above the gate
and this half offers 520. So the gate is not shown to fail, and it is not
shown to hold.

No threshold fixes that. Review is already 1.00 and nothing is stricter, so
the residual is the judge's error. Plan for roughly 8 automatic writes in a
thousand acting on an unsupported claim, and size the blast radius of an
internal write accordingly.

The fit does not ship as a live artifact. `groundedness/` is ignored, because
a committed fit would move your gate to a number fitted on this repository's
synthetic corpus. `groundedness/reference-v2.json` is a tracked copy you can
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

On the synthetic 2124-case gold set this job is a demonstration, not a tool.
It earns its keep when real volume exists to triage.
Inject live cases through `runTriageJob`; each case records its origin.
