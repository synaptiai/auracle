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
That document holds decisions DEC-01 to DEC-33.
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
   Coverage below 0.70 blocks the reply. Coverage below 0.80 sends it to a person.
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
npm install
npm test
```

`npm test` provisions its own Postgres for each run.
A Testcontainers helper starts one throwaway pgvector Postgres per run (src/test-support/global-setup.ts) and removes it at the end.
Tests need no `docker compose up` and no `DATABASE_URL`.
If you export `DATABASE_URL`, the tests target that database and skip the container.

### Dev database

```sh
docker compose up -d
export DATABASE_URL=postgres://auracle:auracle@localhost:5433/auracle
npm install
npm run build
npm run db:migrate
```

Compose starts Postgres 16 with pgvector on host port 5433.
`npm run db:migrate` applies every pending migration under `db/` to that database and records each version in `schema_version`.
Use this database for the daemons and the CLI tools below.
Without an explicit `DATABASE_URL`, they fall back to the compose address (src/db/config.ts).

| Command | Task |
|---------|------|
| `npm run calibrate` | Fits the agreement threshold on the fit half of the gold set. Writes a versioned artifact. |
| `npm run replay` | Runs the action-match replay over the fixture corpus. Uses the offline stub model. Needs no network and no database. |
| `npm run gold-report` | Scores the report half of the gold set. Writes `gold-report/v1.json`. |
| `npm run triage` | Selects cases for human review with the offline judge. Writes `triage/v1.json`. |
| `npm run relay` | Starts the outbox relay daemon. Configure `RELAY_ADAPTER` and `RELAY_INTERVAL_MS` if needed. |
| `npm run consumer` | Starts the partition consumer daemon. Set `CONSUMER_PARTITIONS` (for example `0,1`). Configure `CONSUMER_INTERVAL_MS` and `TICKET_DEADLINE_MS` if needed. |
| `npm run approve -- --run <run-id>` | Approves one gated customer reply through the approval bridge. |

Notes on the consumers:

- The relay daemon and the partition consumer read work from the transactional outbox.
- Each action class declares its delivery rule (DEC-29). The daemons send according to that rule.
  A refund must not repeat, so it sends at most once and escalates when unsure.
  An abandoned ticket close costs nothing, so that class retries freely.
- The queue partitions by `ticket_id`, and one consumer owns each partition (DEC-27).
  All work on one ticket then lands on one consumer, so two runs never race on one ticket.
- The webhook server and the IMAP poller are library drivers in V1. They expose no CLI.

## Compliance position

**Personal data stays in the runtime path (DEC-15).**
The system removes no personal data from requests.
Instead, you sign a Data Processing Agreement with the model provider.
The agreement binds the provider to process the data on your instructions alone.
You are the data controller (section 6).

**The model data guarantee is configurable (DEC-17).**
Retention is a contract term, not a technical setting.
You choose the data position with the provider and you document your choice.

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

The published numbers live in `gold-report/v1.json`.
The artifact scores the report half of the gold set only (DEC-31).
Numbers from the fitting cases flatter the system, so reporting uses untouched cases.
The fit half never touches a published number.
The source corpus is fully synthetic (DEC-18).
Run `npm run gold-report` to regenerate it.

- Action match: 0.797. Interval 0.754 to 0.835.
- Containment: 0.800. Interval 0.757 to 0.837.

The artifact records an agreement gate threshold of 0.60.
Action match scores the routing decision against observable dispositions (DEC-32).
A disposition records what actually happened, for example a refund or an escalation.
An intent label records only a prediction, so it cannot grade the system honestly.
It does not measure answer quality.

## Judge triage is a selection tool, not a score

`npm run triage` runs replay method 3 (section 4.10, DEC-09).
A judge model selects the cases that go to a person for review.
It writes each selection and its reason to `triage/v1.json`.
It never gives a published number.

A judge shares the failures of the system it tests.
It is weakest where the evaluation matters most, so its output is a review queue only.
The numbers for the README come from `npm run gold-report` alone.

On the synthetic 770-case gold set this job is a demonstration, not a tool.
It earns its keep when real volume exists to triage.
Inject live cases through `runTriageJob`; each case records its origin.
