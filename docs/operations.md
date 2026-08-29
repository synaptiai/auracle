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
pnpm install
pnpm run build
pnpm run db:migrate
```

Compose starts Postgres 16 with pgvector on host port 5433. Host port 5432
stays free for another local stack. `pnpm run db:migrate` applies every pending
migration under `db/` to that database. The test suite starts its own throwaway
database and does not touch this one.

## Configuration files

Every CLI and daemon loads a `.env` file at startup, when one exists in
the working directory. Node reads it natively, so no extra dependency
exists. A variable set in the shell always wins over the same variable in
`.env`. `OPENROUTER_API_KEY` normally lives in `.env`. Never commit that
file.

Three commands read no `.env` file: `pnpm run escalations`, `pnpm run triage`
and `pnpm run export-corpus`.

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
`step_journal`, `outbox`, `document`, `intake`, `conversation`, `turn` and
`schema_version`.

## 2. Schema migrations

The ledger schema evolves through numbered SQL files under `db/`. Each file is
named `NNN_description.sql`. The runner is `src/ledger/migrate.ts`, and you run
it with `pnpm run db:migrate`. There is no migration framework. Plain SQL stays
reviewable, and the architecture keeps its stance against orchestration layers.

The runner creates a `schema_version` table. It records the version number and
file name of every applied migration. On each run it applies the files that the
table does not list yet. Each file runs in one transaction together with its
record insert. A failure or a crash leaves no half-applied file and no false
record.

The runner refuses a file whose version sits below the highest recorded
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
pnpm run db:migrate                       # re-applies up to the last good version
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

### Start order

Bring the internal deployment up in this order. Each step needs the one
before it.

```sh
docker compose up -d                    # 1. Postgres with pgvector
DATABASE_URL=$DATABASE_URL pnpm run db:migrate   # 2. ledger schema
pnpm run load-docs -- <dir-of-markdown>  # 3. knowledge base for retrieval
pnpm run consumer                        # 4. runs the state machine
pnpm run relay                           # 5. delivers approved actions
pnpm run imap                            # 6. polls the support mailbox
pnpm run webhook                         # 7. listens for webhook events
```

Steps 1 and 2 prepare the database. Step 3 fills the knowledge base before
the first run retrieves from it. Steps 4 and 5 process what ingress creates.
Steps 6 and 7 turn the deployment towards the customers.

Export the variables from the subsections below before you start. The
consumer needs `CONSUMER_PARTITIONS` and `OPENROUTER_API_KEY`. Use the
reply-generating profile below when you dogfood the approval workflow.

### Partition consumer

```sh
export CONSUMER_PARTITIONS=0,1
export OPENROUTER_API_KEY=<your-key>
pnpm run consumer
```

The consumer runs the coordinator state machine. It polls the `intake` table
for tickets in its own partitions. A message enters a partition through
`hash(conversation_id)` at enqueue time (DEC-36). A message with no
conversation keys on the ticket id instead, which is the DEC-27 form.

Every run on one conversation lands on the same consumer, so two runs never
process one conversation at once. One consumer owns each partition across the
whole deployment. Two consumers on one partition is a configuration error.

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
| `DISCLOSURE_TEXT` | Disclosure on gated replies (DEC-14). Required when `ACTION_IS_CUSTOMER_VISIBLE=true`. Startup fails fast without it. | `This reply was drafted by an automated assistant and reviewed by a person.` |
| `EGRESS_ADAPTER` | Egress adapter that parks gated replies: `helpdesk` or `imap-smtp`. The policy engine reads the selected adapter's capabilities. | `helpdesk` |

A reply-generating profile for dogfood looks like this:

```sh
export ACTION_CLASS=customer_reply
export ACTION_IS_CUSTOMER_VISIBLE=true
export DISCLOSURE_TEXT='This reply was drafted by an automated assistant and reviewed by a person.'
```

Each customer-visible action then parks as a draft and waits in the approval
workflow (section 4).

### Relay daemon

```sh
pnpm run relay
```

This command runs `dist/relay/main.js`. The relay scans the `outbox` table for
records with the `pending` status. It sends first and sets the status to `sent` second (section 4.4). A crash
between the send and the status write can send an action twice.

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
| `RELAY_ADAPTER` | Egress adapter name: `helpdesk` or `imap-smtp`. | `helpdesk` |
| `RELAY_INTERVAL_MS` | Milliseconds between scans. | 5000 |

The relay reads no action configuration. Every record carries its own delivery
rule in `outbox.delivery`, and the relay reads that rule per record (DEC-29).

#### The `imap-smtp` egress adapter

The `imap-smtp` adapter sends mail through one IMAP/SMTP account.
It parks each gated reply as a draft in the Drafts mailbox and sends it over
SMTP after approval.
SMTP accepts no idempotency key, so every customer reply gates through
approval (DEC-06, DEC-12).
Sent-folder presence after an SMTP failure is a weak signal.
The adapter therefore declares no read-back, and the relay escalates on unknown
state (DEC-30).

Set these variables when a process uses the `imap-smtp` adapter.
The selectors are `RELAY_ADAPTER`, `EGRESS_ADAPTER` and `APPROVE_ADAPTER`.
Every process that selects the adapter reads the same variables:

| Variable | Meaning | Default |
|----------|---------|---------|
| `IMAP_HOST` | IMAP server host. Required. | none |
| `IMAP_PORT` | IMAP server port. Required. | none |
| `IMAP_USER` | IMAP login. Required. | none |
| `IMAP_PASS` | IMAP password. Required. | none |
| `IMAP_SECURE` | Use implicit TLS on connect. | `false` |
| `IMAP_DRAFTS_MAILBOX` | Mailbox for parked replies. | `Drafts` |
| `SMTP_HOST` | SMTP server host. Required. | none |
| `SMTP_PORT` | SMTP server port. Required. | none |
| `SMTP_SECURE` | Use implicit TLS on connect. | `true` |
| `EMAIL_FROM_ADDRESS` | Address the replies are sent from. Required. | none |

### Ingress drivers

Ingress turns an inbound event into a ticket and a message. Two adapters take
messages in: IMAP with SMTP, and the webhook. The helpdesk adapter is egress
only and runs no daemon. A driver calls `enqueueTicket` on the intake table.
The partition consumer picks the ticket up from there.

Start the webhook server:

```sh
pnpm run webhook
```

It listens on `WEBHOOK_PORT` (default 8080). It enqueues into
`PARTITION_COUNT` partitions (default 8). Set the count to the number of
partitions your consumers own.

**Set `WEBHOOK_SECRET` before you expose this port.** The driver verifies an
`X-Auracle-Signature` header, which holds the hex HMAC-SHA256 of the raw body
under that key. Without the variable the driver accepts every caller and logs
`webhook_unauthenticated` at startup. An open port lets anybody enqueue a
ticket, and each ticket spends your model budget.

Put the driver behind a proxy that authenticates, or set the key. Do not run
it open on a reachable address.

Start the IMAP poller:

```sh
pnpm run imap
```

The poller requires `IMAP_HOST`, `IMAP_USER` and `IMAP_PASS`.
Optional settings: `IMAP_PORT` (default 993), `IMAP_SECURE` (default `true`)
and `IMAP_INTERVAL_MS` (default 60000).
These ingress defaults differ from the egress `imap-smtp` table in section 3.
That egress adapter defaults `IMAP_SECURE` to `false`.
The variable names overlap, but the two configs stay separate.

## 4. The approval workflow

Customer replies never leave the system automatically (DEC-12).
A sent reply is irreversible: the customer reads it and acts on it.
So a person reads every reply before it goes out.
The flow has these steps:

1. The policy engine sends each customer-visible action to the gated path.
2. The coordinator parks the reply in the draft state of its egress adapter
   (DEC-11). With the helpdesk adapter, reviewers act in the helpdesk they
   already use. With the mail adapter, reviewers act in the Drafts mailbox.
3. The run waits in the `awaiting_approval` state.
4. A person reviews the draft in the helpdesk or in the Drafts mailbox.
5. A person approves with `pnpm run approve -- --run <run-id>`.
6. The approval writes a record to the outbox. The idempotency key comes from
   the action semantics (DEC-24). Two runs of one action then produce the same
   key, so a retry cannot deliver the reply twice.
7. The relay picks up the record and delivers the reply through the adapter.

Each customer reply carries a non-empty `disclosure` field (DEC-14).
The disclosure tells the customer that a machine produced the text.
The bridge refuses a reply without it.

The approval also records the approval-edit distance on the run.
This value shows how much the person changed the draft before sending it.

Add `--read-back` to measure the real edit.
The CLI then fetches the current draft body from the adapter before the approval commits.
It reads the adapter named by `APPROVE_ADAPTER`.
Known values are `helpdesk` and `imap-smtp`.
The default is `helpdesk`.

Read-back refuses the approval when the adapter holds no draft.
Approving a missing draft would fabricate the metric.
Reconcile the draft by hand, then approve again.
The CLI prints the outcome as JSON on stdout.
It exits non-zero when the run was not approved.

### The email flow end to end

The approval flow runs over a real mailbox when both daemons use the
`imap-smtp` adapter. Set `EGRESS_ADAPTER=imap-smtp` before you start the
consumer. Set `RELAY_ADAPTER=imap-smtp` before you start the relay. The
mailbox then keeps the draft state, so it survives across processes. The
flow has these steps:

1. A customer mail arrives. The IMAP poller turns it into a ticket.
2. The consumer runs the ticket. Its egress adapter parks the reply as a
   draft in the Drafts mailbox.
3. You open the draft in your mail client and edit it there.
4. You approve with read-back over the mail account:

```sh
APPROVE_ADAPTER=imap-smtp pnpm run approve -- --run <run-id> --read-back
```

5. The CLI reads the edited draft back from the Drafts mailbox.
6. The approval records the true edit distance on the run.
7. The relay sends the approved draft over SMTP. The customer receives it.

The default `helpdesk` adapter parks drafts in memory instead. Read-back
across processes therefore works only over the mail account. Keep the three
adapter variables aligned when you use the mail flow.

### The escalations command

Make `pnpm run escalations` the first command of your workday.
It shows every run that waits for a person.
It prints a JSON array by default. The flag `--pretty` prints a table.
Filter with `--since 24h` or `--state awaiting_approval`.

The command runs SELECT statements only, so it is safe on a live database.
The command reads no `.env` file, so export `DATABASE_URL` in the shell
when the target differs from the compose default.

## 5. Offline jobs

The offline jobs run on demand. The evaluation jobs read the synthetic fixture
corpus only (DEC-18). The knowledge-base loader reads a directory of markdown
that you pass.

| Command | Task |
|---------|------|
| `pnpm run calibrate` | Fits the global agreement threshold on the fit half of the gold set. Writes a versioned artifact. |
| `pnpm run replay` | Runs the action-match replay over the fixture corpus. Uses the offline stub model. Needs no network and no database. Prints the report as JSON. |
| `pnpm run gold-report` | Scores the report half of the gold set. Writes `gold-report/vN.json`, the next version. |
| `pnpm run triage` | Selects cases for human review with the offline judge. Writes `triage/vN.json`, the next version. |
| `pnpm run load-docs -- <dir>` | Embeds each markdown file into the `document` table for retrieval. Needs `OPENROUTER_API_KEY`. |
| `pnpm run induce [-- output.json]` | Clusters the history and names each cluster. Writes a candidate list for a person. |

The loader onboards the knowledge base for the deployment. It embeds each
markdown file in the directory you pass. It needs `OPENROUTER_API_KEY`.
Set `EMBED_MODEL_VER` to pin the embedding model. A model outside the price
table needs `EMBEDDINGS_USD_PER_MTOK`, or the loader refuses to run.

Each file needs a frontmatter block at the top. The loader rejects unknown
fields. These fields are required:

```yaml
---
doc_id: refund-policy-v1
kind: document
title: Refund policy
owner: support-ops
review_by: 2026-06-01
---
```

`doc_id` holds no whitespace and stays unique in one run. `kind` is
`document` or `resolution`. `review_by` is an ISO date. The loader skips
every file that does not end in `.md`.

Exit code 1 means at least one file failed validation. Fix the file and run
the loader again.

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

Rerun `pnpm run gold-report` after a change to a gate or to the model. Rerun it
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
CORPUS_FETCH_CMD='node fetch-mailbox.mjs' pnpm run export-corpus
```

The command feeds every message through the IMAP poller path. It merges each
thread into one ticket, marks it `intent: 'unlabeled'` and writes
`corpus/history-<date>.json`. A message that fails normalization is excluded
and reported.

### Step 2: Run induction on the corpus (machine)

```sh
CORPUS_PATH=corpus/history-2026-01-31.json \
OPENROUTER_API_KEY=<your-key> \
pnpm run induce -- corpus/taxonomy-candidates-real.json
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
  "SELECT state, steps_used, cost_micros FROM run WHERE run_id = '<run-id>';"
```

A status of `delivery_unknown` means the relay could not confirm the delivery.
Do not resend the action by hand.
The first copy may have arrived, so a resend can act twice.
The run waits in the approval path (DEC-30).
A state of `escalated` means the run stopped and waits for a person.

The journal shows the partial work and names the cause. The causes are a limit
on cost, steps or clock time. A relay that cannot send escalates too. So does a
queued message that failed `MAX_INTAKE_ATTEMPTS` times, which the journal
reports as `intake_abandoned`.

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
