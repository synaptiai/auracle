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
npm run db:apply
```

Compose starts Postgres 16 with pgvector on host port 5433. Host port 5432
stays free for another local stack. `npm run db:apply` applies every SQL file
under `db/` to that database. The test suite starts its own throwaway database
and does not touch this one.

Check the setup:

```sh
docker compose ps
psql "$DATABASE_URL" -c '\dt'
```

The second command lists the tables. You should see `run`, `ticket_epoch`,
`step_journal`, `outbox`, `document` and `intake`.

## 2. Running the processes

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
`hash(ticket_id)` at enqueue time (DEC-27). One consumer owns each partition
across the whole deployment. Two consumers on one partition is a configuration
error.

At startup the consumer claims its partitions and bumps the fencing epoch. An
old owner that still runs fails its next write with a stale epoch (DEC-28).
Optional settings: `CONSUMER_INTERVAL_MS` (default 5000) and
`TICKET_DEADLINE_MS` (default 60000). A run that reaches a limit goes to
`escalated` and keeps its partial work. This is not an error.

### Relay daemon

```sh
npm run relay
```

This command runs `dist/relay/main.js`. The relay scans the `outbox` table for
records with the `pending` status. It sends first and sets the status to `sent`
second (section 4.4). Each record carries its own delivery rule. The relay
reads the rule per record and reads no global setting (DEC-29).

The relay does not retry when the delivery state stays unknown. It sets the
record to `delivery_unknown` and moves the run to the approval path (DEC-30).
Optional settings: `RELAY_ADAPTER` (default `helpdesk`) and
`RELAY_INTERVAL_MS` (default 5000). The process drains the in-flight record on
SIGTERM or SIGINT before it exits.

### Ingress drivers

Ingress turns an inbound event into a ticket and a message. Three adapters
exist: IMAP with SMTP, a webhook and a helpdesk adapter. In V1 the webhook
server and the IMAP poller are library drivers. They expose no CLI. A driver
calls `enqueueTicket` on the intake table. The partition consumer picks the
ticket up from there.

## 3. The approval workflow

Customer replies never leave the system automatically (DEC-12). The flow has
these steps:

1. The policy engine sends each customer-visible action to the gated path.
2. The coordinator parks the reply in the draft state of the helpdesk adapter
   (DEC-11).
3. The run waits in the `awaiting_approval` state.
4. A person reviews the draft in the helpdesk.
5. A person approves with `npm run approve -- --run <run-id>`.
6. The approval writes a record to the outbox. The idempotency key comes from
   the action semantics (DEC-24).
7. The relay picks up the record and delivers the reply through the adapter.

Each customer reply carries a non-empty `disclosure` field (DEC-14). The
bridge refuses a reply without it. The approval also records the
approval-edit distance on the run. The CLI prints the outcome as JSON on
stdout. It exits non-zero when the run was not approved.

## 4. Offline jobs

The offline jobs run on demand. They read the synthetic fixture corpus only
(DEC-18).

| Command | Task |
|---------|------|
| `npm run calibrate` | Fits the global agreement threshold on the fit half of the gold set. Writes a versioned artifact. |
| `npm run replay` | Runs the action-match replay over the fixture corpus. Uses the offline stub model. Needs no network and no database. Prints the report as JSON. |
| `npm run gold-report` | Scores the report half of the gold set. Writes `gold-report/vN.json`. |
| `node dist/jobs/run-taxonomy-induction.js [output.json]` | Clusters the history and names each cluster. Writes a candidate list for a person. |

The split discipline holds (DEC-31). Calibration reads only the fit half. The
gold report reads only the report half. Each job imports exactly one half, so
a leak needs a code change and cannot happen by accident. Never fit and
publish on the same cases.

Calibration needs `OPENROUTER_API_KEY`. It classifies each fit-half ticket
through the classifier port. Replay needs no network access. The induction job
also needs the key. It accepts optional `CHAT_MODEL_VER` and
`EMBED_MODEL_VER` values. Its output is a candidate list only. A person
curates the list to a maximum of 25 intents and sets a risk tier for each
intent (DEC-13).

Rerun `npm run gold-report` after a change to a gate or to the model. Rerun it
only when the change should move a published number.

## 5. Observability

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
model versions (DEC-26):

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
Do not resend the action by hand. The run waits in the approval path (DEC-30).
A state of `escalated` means the run reached a limit on cost, steps or clock
time. The journal shows the partial work.

## 6. The phase model

DEC-20 gives two phases. There is no separate shadow phase. The policy engine
already sends each customer reply to the gated path.

**Phase 1. Replay.** No ticket reaches a live customer. You prepare everything
the live system needs. Induce the taxonomy and curate it to a maximum of 25
intents. Set a risk tier for each intent. Label 770 stratified tickets and fit
the threshold on 385 of them. Keep the other 385 for the reports.

Then run action match for a baseline (DEC-32). Careful labelling decides the
value of every later number.

**Phase 2. Live with gates.** The system does internal writes automatically.
Each customer reply parks as a draft and waits for approval. You measure the
approval-edit distance. This value is the most useful early signal. It shows
how far each draft was from a reply a person can send.

The criteria to leave Phase 2 are undecided. They are open item 1 for V2. Do
not invent exit criteria. Watch the bands and wait for the decision.
