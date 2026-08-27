# Operations runbook

This document is for team members who run the system day to day. It covers
setup, the running processes, the approval workflow, the offline jobs and
observability. The design authority is `docs/v1-architecture.md`. The README
states what the system does. This document states how you operate it.

## 1. Local setup

You need Node 22 or later and Docker.

```sh
docker compose up -d
export DATABASE_URL=postgres://auracle:auracle@localhost:5433/auracle
npm install
npm run build
npm run db:migrate
```

Compose starts Postgres 16 with pgvector on host port 5433. Host port 5432
stays free for another local stack. `npm run db:migrate` applies every pending
migration under `db/` to that database. The test suite starts its own throwaway
database and does not touch this one.

## Configuration files

Each CLI and daemon loads a `.env` file at startup, when one exists in the
working directory. Node reads it natively, so no extra dependency exists. A
variable set in the shell always wins over the same variable in `.env`.
`OPENROUTER_API_KEY` normally lives in `.env`. Never commit that file.

Example `.env`:

```sh
DATABASE_URL=postgres://auracle:auracle@localhost:5433/auracle
OPENROUTER_API_KEY=<your-key>
```


Check the setup:

```sh
docker compose ps
psql "$DATABASE_URL" -c '\dt'
```

The second command lists the tables. You should see `run`, `ticket_epoch`,
`step_journal`, `outbox`, `document`, `intake` and `schema_version`.

## 2. Schema migrations

The ledger schema evolves through numbered SQL files under `db/`. Each file is
named `NNN_description.sql`. The runner is `src/ledger/migrate.ts`, and you run
it with `npm run db:migrate`. There is no migration framework. Plain SQL stays
reviewable, and the architecture keeps its stance against orchestration layers.

The runner creates a `schema_version` table. It records the version number and
file name of every applied migration. On each run it applies the files that the
table does not list yet. Each file runs in one transaction together with its
record insert. A failure or a crash leaves no half-applied file and no false
record. The runner refuses a file whose version sits below the highest recorded
version. An out-of-order apply can break later migrations.

Rules for a new migration:

- Copy the next free number. Two files never share one number.
- Never edit a file that any database has already applied.
- Write plain SQL that works inside one transaction.

### Rollback story

Migrations are forward-only by design. A failed migration rolls itself back.
You only need a plan for a migration that succeeds and then proves wrong.

Take a snapshot before you run any migration.

```sh
pg_dump "$DATABASE_URL" > pre-migrate.sql
```

If a migration succeeds and then causes a problem in production, restore that snapshot.

```sh
psql "$DATABASE_URL" < pre-migrate.sql   # careful: replaces current data
npm run db:migrate                       # re-applies up to the last good version
```

Do not write reverse scripts per migration. A hand-written down-migration can
diverge from what the forward step really did. A snapshot cannot diverge,
because it is the database itself. For a small schema change on an empty dev database, drop the schema.
Then run `db:migrate` again instead of restoring a snapshot.

A v1 database predates `schema_version`. Its tables already exist, and the v1
files are idempotent. The first `db:migrate` run on such a database re-runs
those files as no-ops and records their versions. No manual step exists.

## 3. Running the processes

The system runs as separate processes. Each process reads `DATABASE_URL`.
Start each process in its own terminal.

### Partition consumer

```sh
export CONSUMER_PARTITIONS=0,1
export OPENROUTER_API_KEY=<your-key>
npm run consumer
```

The consumer runs the coordinator state machine. It polls the `intake` table
for tickets in its own partitions. A ticket enters a partition through
`hash(ticket_id)` at enqueue time (DEC-27). Every run on one ticket then lands
on the same consumer, so two runs never process one ticket at once. One consumer
owns each partition across the whole deployment. Two consumers on one partition
is a configuration error.

At startup the consumer claims its partitions and bumps the fencing epoch.
A rebalance can leave two owners for a short time.
The epoch is a number that increases on each claim.
The ledger refuses any write with an older epoch than the highest one it has seen (DEC-28).
An old owner that still runs therefore fails its next write instead of corrupting the state.

Optional settings: `CONSUMER_INTERVAL_MS` (default 5000) and
`TICKET_DEADLINE_MS` (default 60000).
A run that reaches a limit goes to `escalated` and keeps its partial work.
This is not an error.
The limit makes a high cost visible in operations, not a surprise in the invoice.

The consumer reads this configuration:

| Variable | Meaning | Default |
|----------|---------|---------|
| `CONSUMER_PARTITIONS` | Comma-separated partitions this process owns. Required. | none |
| `CONSUMER_INTERVAL_MS` | Milliseconds between scans. | 5000 |
| `TICKET_DEADLINE_MS` | Per-ticket clock budget (DEC-25). | 60000 |
| `PARTITION_COUNT` | Partition count for hashing (DEC-27). | 8 |
| `MODEL_VER` | Chat model pin. Overridable at any time. | `stealth/ox-alpha` |
| `EMBED_MODEL_VER` | Embedding model pin for retrieval. Stealth chat models do not embed, so this pin is separate. | `openai/text-embedding-3-small` |
| `PROMPT_VER` | Prompt version pin (DEC-26). | `consumer-prompt-v1` |
| `ACTION_CLASS` | Action class each run executes. | `route_ticket` |
| `ACTION_DELIVERY` | Delivery rule: `at_most_once` or `at_least_once`. | `at_most_once` |
| `ACTION_IS_CUSTOMER_VISIBLE` | `true` gates every action as a customer reply (DEC-12). | `false` |
| `DISCLOSURE_TEXT` | Disclosure on gated replies (DEC-14). Required when `ACTION_IS_CUSTOMER_VISIBLE=true`. Startup fails fast without it. | see DEC-14 text |

A reply-generating profile for dogfood looks like this:

```sh
export ACTION_CLASS=customer_reply
export ACTION_IS_CUSTOMER_VISIBLE=true
export DISCLOSURE_TEXT='This reply was drafted by an automated assistant and reviewed by a person.'
```

Each customer-visible action then parks as a draft and waits in the approval
workflow (section 3).

### Relay daemon

```sh
npm run relay
```

This command runs `dist/relay/main.js`. The relay scans the `outbox` table for
records with the `pending` status. It sends first and sets the status to `sent`
second (section 4.4). A crash between the status write and the send hides an
undelivered action.

Each record carries its own delivery rule.
The relay reads the rule per record and reads no global setting (DEC-29).
The safer rule changes with the action: a duplicate refund costs money, while a
repeated ticket close costs nothing.

The relay does not retry when the delivery state stays unknown.
A network failure can leave the outcome unreadable, and a retry could pay a
second refund.
So the relay sets the record to `delivery_unknown` and moves the run to the
approval path (DEC-30).
Escalation is the only action that does not pick a failure for you.

The process drains the in-flight record on SIGTERM or SIGINT before it exits.

| Variable | Meaning | Default |
|----------|---------|---------|
| `RELAY_ADAPTER` | Egress adapter name. | `helpdesk` |
| `RELAY_INTERVAL_MS` | Milliseconds between scans. | 5000 |

The relay reads no action configuration. Every record carries its own delivery
rule in `outbox.delivery`, and the relay reads that rule per record (DEC-29).

### Ingress drivers

Ingress turns an inbound event into a ticket and a message. Three adapters
exist: IMAP with SMTP, a webhook and a helpdesk adapter. In V1 the webhook
server and the IMAP poller are library drivers. They expose no CLI. A driver
calls `enqueueTicket` on the intake table. The partition consumer picks the
ticket up from there.

## 4. The approval workflow

Customer replies never leave the system automatically (DEC-12).
A sent reply is irreversible: the customer reads it and acts on it.
So a person reads every reply before it goes out.
The flow has these steps:

1. The policy engine sends each customer-visible action to the gated path.
2. The coordinator parks the reply in the draft state of the helpdesk adapter
   (DEC-11). Reviewers act in the helpdesk they already use, with no new tool.
3. The run waits in the `awaiting_approval` state.
4. A person reviews the draft in the helpdesk.
5. A person approves with `npm run approve -- --run <run-id>`.
6. The approval writes a record to the outbox. The idempotency key comes from
   the action semantics (DEC-24). Two runs of one action then produce the same
   key, so a retry cannot deliver the reply twice.
7. The relay picks up the record and delivers the reply through the adapter.

Each customer reply carries a non-empty `disclosure` field (DEC-14).
The disclosure tells the customer that a machine produced the text.
The bridge refuses a reply without it.

The approval also records the approval-edit distance on the run.
This value shows how much the person changed the draft before sending it.
The CLI prints the outcome as JSON on stdout.
It exits non-zero when the run was not approved.

## 5. Offline jobs

The offline jobs run on demand. They read the synthetic fixture corpus only
(DEC-18).

| Command | Task |
|---------|------|
| `npm run calibrate` | Fits the global agreement threshold on the fit half of the gold set. Writes a versioned artifact. |
| `npm run replay` | Runs the action-match replay over the fixture corpus. Uses the offline stub model. Needs no network and no database. Prints the report as JSON. |
| `npm run gold-report` | Scores the report half of the gold set. Writes `gold-report/vN.json`. |
| `node dist/jobs/run-taxonomy-induction.js [output.json]` | Clusters the history and names each cluster. Writes a candidate list for a person. |

The split discipline holds (DEC-31). Calibration reads only the fit half. The
gold report reads only the report half. A threshold picked on the report cases
inflates every published number. Each job imports exactly one half, so a leak
needs a code change and cannot happen by accident. Never fit and publish on
the same cases.

Calibration needs `OPENROUTER_API_KEY`. It classifies each fit-half ticket
through the classifier port. Replay needs no network access. The induction job
also needs the key. It accepts optional `CHAT_MODEL_VER` and `EMBED_MODEL_VER`
values.

The induction output is a candidate list only.
A person curates the list to a maximum of 25 intents and sets a risk tier for
each intent (DEC-13).
Rare intents never collect enough labelled examples, so more intents add no
accuracy.
Confidence measures how sure the classifier is.
It does not measure what a mistake costs.
So a person assigns the tier from the cost of an error, not from a score.

Rerun `npm run gold-report` after a change to a gate or to the model. Rerun it
only when the change should move a published number.

## 6. The real-corpus curation loop

The fixture corpus carries the offline jobs until phase 1 starts on real
data. This section moves real mailbox history through the same jobs. Every
file in this loop holds real customer text (DEC-18). The exporter writes to
`corpus/`, and that directory is gitignored. Never move a corpus file into
the repository.

### Step 1: Export the mailbox (machine)

Set `CORPUS_FETCH_CMD` to a mailbox reader command. It prints one JSON
object per line. Each object holds a `sourceId` and the full RFC 5322 text
in `rfc5322Text`. Emit inbound customer messages only. Agent replies merge
into thread bodies and skew the induction. Then run:

```sh
CORPUS_FETCH_CMD='node fetch-mailbox.mjs' npm run export-corpus
```

The command feeds every message through the IMAP poller path. It merges each
thread into one ticket, marks it `intent: 'unlabeled'` and writes
`corpus/history-<date>.json`. A message that fails normalization is excluded
and reported.

### Step 2: Run induction on the corpus (machine)

```sh
CORPUS_PATH=corpus/history-2026-01-31.json \
OPENROUTER_API_KEY=<your-key> \
node dist/jobs/run-taxonomy-induction.js corpus/taxonomy-candidates-real.json
```

The job embeds each thread and clusters the embeddings. A model gives each
cluster a name. Its output is a candidate list only.

### Step 3: Review the candidate clusters (human)

Open the candidate file. Read the sample threads of each cluster. Decide for
each cluster: keep, merge with another cluster, or fold into `other`. Examine
the `other` group before you decide. A thread that fits no cluster goes there.

### Step 4: Curate the taxonomy (human)

Name each kept intent. Set a risk tier of `low`, `medium` or `high` for each
intent (DEC-13). Keep the total at or below 25 intents including `other`
(DEC-10). Write the result as a `taxonomy.json` beside the corpus file.

### Step 5: Label the stratified sample (human)

Draw a stratified sample over the risk tiers. For each sampled thread,
record the intent from the curated taxonomy. Record also the queue that
handled the thread. Then record the `escalated`, `macro_applied`,
`refund_issued` and `first_reply_minutes` values.

These labels replace the placeholders that the exporter wrote. Split the
labeled sample into fit and report halves of equal size (DEC-31).

### Step 6: Calibrate on the fit half (deferred)

Calibration on a real labeled fit half does not work yet. The calibration
job accepts a synthetic fit half of 385 tickets only (DEC-18). Real-half
calibration needs a provenance-aware change to that job. That change is
follow-up work outside this loop. Until then the operator keeps the labeled
halves under `corpus/` and never commits them.


## 7. Observability

### Control bands

The file `bands.yaml` defines four metrics. Until Phase 2 produces data, each
metric is a target definition, not a live signal. The baseline mean and sigma
stay null until a full window of daily samples exists. The window is 30 days.

| Metric | Source | Direction |
|--------|--------|-----------|
| `abstain_rate` | composer and groundedness results | high is bad |
| `gate_pass_rate` | classifier agreement gate | low is bad |
| `approval_edit_distance` | `run.approval_edit_distance`, set at approval | high is bad |
| `relay_delivery_unknown_count` | outbox delivery status | any nonzero count needs eyes |

The bands define three actions:

- 1 sigma: log. No action.
- 2 sigma: diagnose read-only. Read dashboards and journals. Change nothing.
- 3 sigma: propose a change through a pull request.

### What happened on this run

Two ledger tables answer this question. The `step_journal` table holds one row
per step of a run. Each row has the status, the result JSON and the prompt and
model versions (DEC-26). The pinned versions let you reproduce later exactly
which prompt and model produced each step:

```sh
psql "$DATABASE_URL" -c \
  "SELECT step_id, status, result FROM step_journal WHERE run_id = '<run-id>';"
```

The `outbox` table holds each action before the relay sends it. Check it when
a customer says the reply never arrived:

```sh
psql "$DATABASE_URL" -c \
  "SELECT step_id, action_class, delivery, status FROM outbox WHERE run_id = '<run-id>';"
```

The `run` table shows where a run stopped:

```sh
psql "$DATABASE_URL" -c \
  "SELECT state, steps_used, cost_cents FROM run WHERE run_id = '<run-id>';"
```

A status of `delivery_unknown` means the relay could not confirm the delivery.
Do not resend the action by hand.
The first copy may have arrived, so a resend can act twice.
The run waits in the approval path (DEC-30).
A state of `escalated` means the run reached a limit on cost, steps or clock
time. The journal shows the partial work.

## 8. The phase model

DEC-20 gives two phases.
There is no separate shadow phase.
A gated live phase already shows every reply to a person before it ships.
A shadow phase would add cost and no new signal, so the design skips it.
The policy engine sends each customer reply to the gated path.

**Phase 1. Replay.** No ticket reaches a live customer, and you prepare
everything the live system needs.
Induce the taxonomy and curate it to a maximum of 25 intents.
Set a risk tier for each intent.
Label 770 stratified tickets.
Fit the threshold on 385 of them and keep the rest for the reports.

Then run action match for a baseline (DEC-32).
Action match compares each routing decision with the disposition people
actually recorded.
Careful labelling decides the value of every later number.

**Phase 2. Live with gates.** The system does internal writes automatically.
Each customer reply parks as a draft and waits for approval. You measure the
approval-edit distance. This value is the most useful early signal. It shows
how far each draft was from a reply a person can send.

The criteria to leave Phase 2 are undecided. They are open item 1 for V2. Do
not invent exit criteria. Watch the bands and wait for the decision.
