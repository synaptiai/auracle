# Operations runbook

This document is for team members who run the system day to day. It covers
setup, the running processes, the approval workflow, the offline jobs and
observability. The design authority is `docs/v1-architecture.md`. The README
states what the system does. This document states how you operate it.

Read `docs/architecture-map.md` first if you have not seen the system before.
It draws the processes, the jobs and the tables this runbook operates.
`docs/v2-roadmap.md` says what is left in V2 and what blocks each item.

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
| `CONSUMER_INTERVAL_MS` | Ceiling on the wait between scans, in milliseconds. Intake signals an arrival and the consumer wakes on it, so this bounds the wait when a signal is lost. | 5000 |
| `TICKET_DEADLINE_MS` | Per-ticket clock budget (DEC-25). | 60000 |
| `PARTITION_COUNT` | Partition count for hashing (DEC-27). | 8 |
| `MODEL_VER` | Chat model pin. Overridable at any time. | `z-ai/glm-5.3-flash` |
| `EMBED_MODEL_VER` | Embedding model pin for retrieval. The chat model does not embed, so this pin is separate. | `openai/text-embedding-3-small` |
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
| `RELAY_ADAPTER` | Egress adapter name: `helpdesk`, `imap-smtp` or `freescout`. | `helpdesk` |
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

#### The `freescout` egress adapter

The `freescout` adapter talks to a FreeScout instance over its REST API.
It parks each gated reply as a draft thread and posts the approved text after
approval.
The selectors are `RELAY_ADAPTER`, `EGRESS_ADAPTER` and `APPROVE_ADAPTER`.

The adapter declares two guarantees as false, and each has a reason.
FreeScout accepts no idempotency key on thread create.
So every write gates through approval (DEC-06, DEC-12).
FreeScout also records no such key on a thread.

So the relay cannot ask whether one delivery landed.
The adapter declares no read-back, and the relay escalates on unknown state
(DEC-30).

The API has no endpoint that updates a thread.
So an approved send posts a second thread and the parked draft stays.
Remove the draft in the FreeScout UI after the send.

| Variable | Meaning | Default |
|----------|---------|---------|
| `FREESCOUT_BASE_URL` | Instance root, such as `http://localhost:8088`. Required. | none |
| `FREESCOUT_API_KEY` | Value of the `X-FreeScout-API-Key` header. Required. | none |
| `FREESCOUT_USER_ID` | FreeScout user the threads belong to. Required. | none |

##### Bringing an instance up

`docker-compose.freescout.yml` carries a FreeScout service and its database.
It is a separate file, so a bare `docker compose up -d` starts the ledger
database alone and reads none of it.

Set `FREESCOUT_ADMIN_EMAIL` and `FREESCOUT_ADMIN_PASSWORD` in `./.env` first.
This repository commits no credential.
Compose refuses to start without both and names the missing one.

```sh
docker compose -f docker-compose.yml -f docker-compose.freescout.yml up -d
```

Never weaken those two references so that an empty value passes.
The image reads the admin password with a shell default.
That default applies to an empty value as well as to an absent one.
So an empty value becomes a published default password.

FreeScout answers on `127.0.0.1:8088`. It takes no route from the network,
because the adapter runs on the host. Its database publishes no port at all.

##### The API needs a module that this repository cannot ship

A stock FreeScout install answers `404` to every `/api/` route.
The REST API lives in the `API & Webhooks` module, and a person buys and
installs that module.
FreeScout 1.8.239 ships an empty `Modules` directory.

So the adapter cannot reach a stock instance, and no automated test in this
repository claims it can.
Install the module, mint a key under `Manage`, then check the route by hand.
A person does both in the FreeScout UI:

```sh
curl -H "X-FreeScout-API-Key: $FREESCOUT_API_KEY" \
  http://localhost:8088/api/conversations
```

A `404` means the module is absent. A JSON body means the adapter can run.

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
| `pnpm run calibrate` | Fits the global agreement threshold on the fit half of the gold set. Writes `calibration/vN.json`, the next version. |
| `pnpm run fit-groundedness` | Fits the two coverage thresholds on the fit half. Writes `groundedness/vN.json`. Needs `OPENROUTER_API_KEY` and `GROUNDEDNESS_MODEL_VER`. |
| `pnpm run report-groundedness` | Measures the fitted coverage pair on the report half. Prints precision and negative predictive value with their intervals. Selects nothing and writes no artifact. Needs the same two variables. |

Each fitting artifact states how much of its half it could not read.
`groundedness/vN.json` carries `faulted_drafts`, the drafts it dropped.
`calibration/vN.json` carries `unreadable_samples` and
`tickets_with_unreadable`, the samples that yielded no answer and the cases
they fell in. The gold report carries `unreadable_samples` for the same
reason. A number fitted or published through unreadable answers is not the
same number as one measured on answers, so each job says which it is.
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
inflates every published number. Never fit and publish on the same cases.

On the committed corpus each job opens exactly one half. On halves of your own
history each job also opens the other file, to prove the two are disjoint. It
reads identifiers from that file and never a case. So a case-level leak still
needs a code change and cannot happen by accident.

Calibration needs `OPENROUTER_API_KEY`. It classifies each fit-half ticket
through the classifier port. Replay needs no network access. The induction job
also needs the key. It accepts optional `CHAT_MODEL_VER` (default
`openai/gpt-4o-mini`) and `EMBED_MODEL_VER`
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
in `rfc5322Text`.

Emit both sides of each thread. The export models turns now, so an agent
reply becomes the reply to the turn it answered (DEC-37). Set
`CORPUS_AGENT_ADDRESSES` to your support addresses, separated by commas.
Mail ingress marks every inbound message as the customer. Without this list
the export cannot tell the two sides apart.

```sh
CORPUS_FETCH_CMD='node fetch-mailbox.mjs' \
CORPUS_AGENT_ADDRESSES='support@acme.example,help@acme.example' \
pnpm run export-corpus
```

The command feeds every message through the IMAP poller path. It writes one
record per customer turn to `corpus/history-<date>.json`. It refuses any other
output directory, because the file holds real customer text (DEC-18). Records of one
thread share a `conversation_id` and count from turn 1. Each record carries
`intent: 'unlabeled'` until you label it.

Turn order comes from each message's own Date header. The header must state a
zone. A date without one resolves against the clock of the machine you run the
export on. That is a fact about the machine and not about the message, so it
counts as unreadable.

A thread where one message states no readable date falls back to delivery
order. The export
reports every fallback, and it reports every message it dropped: a message
with no body text, a message from neither party, and an agent message that
precedes every customer turn. Read those counts. They name what the corpus
does not hold.

Leave `CORPUS_AGENT_ADDRESSES` unset and the export records the customer's
half of each conversation. It warns when you do. A threshold fitted on half a
conversation covers a prompt the runtime never sends.

### Step 2: Run induction on the corpus (machine)

```sh
CORPUS_PATH=corpus/history-2026-01-31.json \
OPENROUTER_API_KEY=<your-key> \
pnpm run induce -- corpus/taxonomy-candidates-real.json
```

The job embeds each first turn and clusters the embeddings. A model gives
each cluster a name. Its output is a candidate list only.

Later turns are excluded. A follow-up names no topic of its own. A cluster of
follow-ups therefore spends one of the 25 intents on a group no person can
name (DEC-10). The job prints how many turns it excluded.

A corpus file written before the export modeled turns fails to load. The
message says a record names no conversation. Run Step 1 again to replace the
file. Older exports hold no turn structure and nothing can add it after the
fact.

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

### Step 6: Fit and publish on your own halves (machine)

Write the two labeled halves as `corpus/fit.json` and `corpus/report.json`.
Each file holds `split`, `source`, `count` and `tickets`. Set `source` to
`real` in the file and in every record. Keep both files under `corpus/`.
That directory is gitignored, and a labeled half never enters the repository
(DEC-18).

Name both halves on every command. The job you run reads one of them. It takes
identifiers from the other to prove the two are disjoint (DEC-31), and reads
none of that half's cases.
A job that gets one path without the other refuses to run.

```sh
export GOLD_FIT_PATH=corpus/fit.json
export GOLD_REPORT_PATH=corpus/report.json

CALIBRATION_MODEL_VER=<model> pnpm run calibrate
GROUNDEDNESS_MODEL_VER=<model> pnpm run fit-groundedness
GROUNDEDNESS_MODEL_VER=<model> pnpm run report-groundedness
pnpm run gold-report
```

Run the coverage report after the fit, never before it. It reads the pair from
the highest groundedness artifact and refuses when none exists. It applies that
pair to the half that chose nothing, which is what makes the number publishable
(DEC-31). It refuses the fit half outright.

The two coverage jobs cost about the same. Each makes one model call per claim,
so a half of this size is some four thousand calls across several hours.

Each job appends every scored draft to a resume file under `groundedness/`.
A run that dies continues from where it stopped when you start it again.
Three runs died before this existed and each discarded every draft it had paid
for: a provider having a bad hour, a connect timeout that outlasted every
retry, and a killed shell.

The file records a hash of each case identifier, never the identifier (DEC-18).
Its header names the model, the prompt and the half. A file describing any
other run is refused rather than mixed in, because samples from two runs
publish a number from neither. Delete the file to start over, and set
`GROUNDEDNESS_RESUME` to put it elsewhere.

The exported file carries a provenance block. It records every counter and it
names each conversation whose turn order the mailbox decided. Read that list
before you label: those turn numbers are a guess.

`pnpm run fit-groundedness` needs one more thing than the other two. It
resolves each cited document against the shipped fixture set, so a real half
whose claims cite your own documents is refused. The refusal names the case
and the document by digest, not in the clear (DEC-18). That job stays on
synthetic data until a real knowledge base reaches it.

Each job prints the half it read and its provenance. Each artifact records
that provenance, so a number always names the data behind it. Restart the
consumers to adopt a new threshold, then read the `gate_thresholds_fitted`
line and check that `gold_source` says `real`.

The overlap check compares identifiers exactly. An archive that changed the
case of a message identifier defeats it. A message identifier is case
sensitive, so a loose match would refuse halves that are genuinely disjoint.

The jobs also do not check where you keep the two halves. The export refuses
to write outside `corpus/`; reading is your own path to name.

The jobs refuse an overlap. Two halves that share a case fail, and so do two
that share a conversation: a thread split across the halves would fit and
publish on one customer's problem.

The size rule of the shipped corpus does not apply here. Your halves hold
whatever size your labeled sample yields. They must be equal, as DEC-31 asks.
The jobs refuse a pair of different sizes.

A conversation may not straddle the halves, so an odd case total never splits.
Hold a whole conversation back from the larger half until the two match.
Keep the held-back cases; they join the next split.

Each artifact records a digest of both case sets. Compare the digests of your
calibration artifact and your gold report. Two runs that name different sets prove
different data, and the report does not cover the gate.

Keep the two files unchanged between the fit and the report. Pruning a half
between runs passes every check and invalidates the pair.

The published numbers in this repository stay synthetic. Your artifacts
describe your deployment and nobody else's. Never commit one.


## 7. Observability

### Which gate numbers a process runs on

Every process that evaluates policy resolves its gate numbers once at startup.
It reads the highest artifact under `calibration/` and logs what it adopted.
Read that line before you trust a gate number.

```
{"event":"gate_thresholds_seeded","reason":"no calibration artifact found","agreement":0.6,...}
{"event":"gate_thresholds_fitted","version":3,"scope":"all_turns","agreement":0.72,...}
```

A `gate_thresholds_seeded` line means no fit has run. The documented seeds of
section 4.5 and section 4.7 apply. This is the ordinary state of a fresh
checkout and it is not a fault.

A `gate_thresholds_fitted` line names the artifact version behind the number.
Run `pnpm run calibrate` to produce the next one, then restart the consumers.
A running process never re-reads the artifact, so a fit takes effect at the
next start.

Both gates have a job that fits them: `pnpm run calibrate` and
`pnpm run fit-groundedness`. Both numbers now reach the runtime. Each gate
reads its own artifact and keeps its own seed when that artifact is absent.
So one gate can run fitted beside a gate that runs seeded.

Each gate logs a line of its own at startup. Read `gate_thresholds_fitted` or
`gate_thresholds_seeded` for the agreement number. Read
`coverage_thresholds_fitted` or `coverage_thresholds_seeded` for the pair.
One line covering both gates could not report a mixed state.

The gates stay independent. Neither artifact supplies a number to the other
gate, and no path joins a coverage value to an agreement value (DEC-05).

The `gold_source` field on that line names the data behind the number. It
reads `synthetic` for the shipped corpus and `real` for a half of your own
history. The `model_ver` and `prompt_ver` fields name the pins the fit ran
under.

Read those two. The consumer refuses to start when a fitted coverage pair was
produced under a model that is not the one `MODEL_VER` names.

A threshold is one model's judgement of what coverage means. A model that
reads claims more generously reaches the same number on weaker evidence.
So a pair fitted under another pin runs a gate nobody measured (DEC-26).

The refusal does not fall back to the seeds, and that is deliberate.
The shipped seeds are looser than this repository's own fit.
Falling back would open the gate wider at the moment it became unjustified.
Re-fit with `pnpm run fit-groundedness`, or set `MODEL_VER` to the fitted pin.
`pnpm run report-groundedness` refuses a pin mismatch for the same reason.

A corrupt artifact stops the process. It does not fall back to the seeds. A
truncated write must not read as "not calibrated yet" behind a gate that still
looks healthy.

Artifacts under `calibration/` are run output and the repository ignores them.
Never commit one. A committed artifact reaches every checkout and moves each
adopter's gates to numbers fitted on somebody else's corpus. Each deployment
runs `pnpm run calibrate` against its own fit half.

Never rename an artifact by hand. The loader picks the file by its name and
reads the version from inside it, and it refuses a file where the two
disagree. Copy the whole `calibration/` directory instead.

Keep one file per version. A case-sensitive filesystem holds `v1.json` and
`V1.json` as two files, and both name version 1. The loader refuses that
directory, because nothing records which file a gate read.

A file the loader refuses also stops `pnpm run calibrate`. The job cannot
write its way out of the fault, so remove the file the message names. The job
reads the directory before it samples, so a fault costs no model call.

The gold report, the triage job and the groundedness fit apply the same rules.
Each reads its own directory before its own loop.
One scan and one pre-check serve them all.

### When the groundedness fit refuses

`pnpm run fit-groundedness` makes one model call per claim, so a full fit half
is roughly a thousand calls. It can refuse, and a refusal is a result.

The job refuses when the measured coverage of a grounded draft and an
ungrounded one do not separate. A threshold there would be satisfied by any
candidate, so the message names the coverage values both classes share. Read
that as a fault in the judge or the corpus, not in the job.

It also refuses when the two thresholds land on one value. Section 4.7 needs three outcomes and a
single value gives two. Everything is escalated or everything runs
automatically, and no draft reaches a person. That happens
when the judge scored no draft ambiguously. Widen the corpus, or keep the
seeds.

The block value is the lowest that holds its floor, not the highest. A draft under it is escalated by the
coverage gate. That draft never reaches a person as a draft to approve. A person still handles the escalation, and
`pnpm run escalations` lists it.

The thresholds decide the automatic path only.
A customer reply is gated before either one is read (DEC-12). It reaches a
person whatever its coverage. The review band is what puts an internal draft
in front of a person. A larger blocked band leaves fewer drafts a person
can approve. That is the opposite of what the band is for.

The artifact reports coverage for each grade of unsupported claim. An
`unstated_detail` names a specific the document gestures at and never states,
and it is the grade that matters. A fit whose separation comes from the easy
grades alone protects nothing, and the per-grade figures are how you see it.

A job creates and reads the directory before it spends, and reads it again to
mint the version it writes. The first step creates the directory the way the
writer does, so a revoked permission on the parent faults before the first
model call. A file dropped in during a run still costs that run. The check
removes a directory that was already unusable, not every fault.

Every gate journal row records the numbers that decided it. A rolling restart
gives one consumer a new fit while another still holds the old one, so two
identical tickets can decide differently for a legitimate reason. The journal
row says which numbers each run applied.

`pnpm run gold-report` reads the calibration artifact. A clean checkout carries none,
so it scores through the seeds and the artifact says `gate_source: seed`. A
machine that holds a fit publishes different rates, and its artifact names the
version and the turn population behind them. The gate is part of the number.


### Control bands

The file `bands.yaml` defines four metrics. The window is 30 days.

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

#### Reading a day

`pnpm run bands` reports all four metrics for one day.

```sh
DATABASE_URL=... pnpm run bands
DATABASE_URL=... pnpm run bands -- --day 2026-09-01
```

The command reads the ledger and writes `bands/v<n>.json`. Every statement is
a SELECT, so it is safe against a live database. The default day is the most
recent complete UTC day. A part of today compares against whole days, and
every morning would then look like an excursion.

The baseline covers the 30 most recent measured days before the day you
asked for. It never
includes that day. A day inside its own baseline pulls the mean toward
itself, so a bad day reads less bad the worse it gets.

The baselines in `bands.yaml` stay null. They are your production numbers, and
the file is in the repository. The command computes a baseline from your
ledger each time you run it.

#### When a day carries no band

The report states a band, or it states why it has none. It never states both.

| Line | Meaning | What to do |
|---|---|---|
| `no baseline: 7 of 30 days` | Too few days in reach measured anything. | Wait. The count rises as the ledger fills. |
| `the day measured nothing` | No run that day reached the step this metric measures. | Check that traffic reached the consumer. |
| `steady at 0 over 30 days` | The metric held one value all window, and today matches it. | Nothing. This is the healthy reading for the delivery count. |
| `no spread over 30 days, and today moved to 3` | The metric held one value all window, and today left it. | Look now. There is no sigma to measure the step against. |
| `the day measured a value that is not a number` | The ledger holds a value no arithmetic can use. | Read the ledger for that day. This needs a person. |
| `the window spans more than one provider: stub and model` | The days compared did not all run against one model provider. | Wait out the window, or read the days on each side of the change separately. |

Each line has a code in the artifact, in `shortfall_code`. Read that rather
than the sentence if a tool consumes the file.

The provider line has a cost worth knowing before you meet it. A band
compares a day against the thirty before it, so a change of provider silences
every metric until the window clears. Upgrading this software is such a
change: a run records its provider from this version onward, and a run written
before it recorded none. The first day carrying both is a day that disagrees
with itself, and the window covering that day emits no verdict for about a
month.

The artifact names the day's own provider in `provider`. It reads `mixed` when
the day's runs disagreed, and null when none of them recorded one. An artifact
written before the field existed has no `provider` key, and the reader treats
that as null.

The baseline is 30 daily samples, not 30 calendar days. The job reads 60 days
to find them. A quiet day yields no sample, so demanding 30 consecutive days
would let one quiet weekend blind the band for a month.

#### The counts beside each metric

Each metric reports the runs behind its value. Three counts can sit beside it.

`not reached` counts runs that never reached the step. A customer reply never
reaches the agreement gate, because DEC-12 gates it first. The gate metric
excludes those runs rather than counting them as failures. Otherwise the rate
would follow your traffic mix instead of the classifier.

`still to land` counts runs whose contribution may still arrive. It sits
beside the two values that settle late, and the next section explains them.

`unrecorded` counts runs whose journal cannot answer. A run written before the
gate step recorded which rule decided carries no such answer. The count falls
to zero as the ledger turns over. A high count means the numbers rest on few
runs, so read the `over N runs` figure beside them.

#### Two values that settle late

The report files `approval_edit_distance` and `relay_delivery_unknown_count`
under the day it picked the run up. Both values arrive later. A person writes
one at approval, and the relay writes the other when it gives up on a
delivery. Neither table records that moment, so the run is the only day the
report can use.

So a recent day is provisional. Running the command again for the same day can
return a different value, and each run writes a new version rather than
replacing the last. The edit distance prints the count of runs still awaiting
approval beside it, and the delivery count prints the records the relay has
not resolved. Both say how much of that day could still arrive.

A count of zero means no known contribution is outstanding. It does not prove
the day is final. A run of that day which is still working, or which stopped
between steps, appears in neither count and can still acquire a value later.

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

The journal shows the partial work and names the cause. Every cause the
coordinator can record appears below. A queued message that failed
`MAX_INTAKE_ATTEMPTS` times also escalates, which the journal reports as
`intake_abandoned`.

| Reason | What happened | What you do |
|---|---|---|
| `limit_cost` | The run reached its cost budget. | Read the journal for the step that spent it. Raise the budget or fix the prompt. |
| `limit_steps` | The run reached its step budget. | Look for a loop between steps. |
| `limit_clock` | The run reached its deadline. | Run `pnpm run latency`. A high service time on one partition is the model; a high queue wait is the partition falling behind. |
| `composer_abstained` | The composer could not cite every claim. | A knowledge gap. Write or correct the document. |
| `policy_escalated` | A gate or the policy rules sent the action to a person. | Read the draft and decide. |
| `park_unresolved` | An approval could not be parked. | Check the egress adapter. |
| `egress_refused` | The egress refused, and a retry can never clear it. | Fix the target system or the action. |
| `classifier_unreadable` | Every classifier sample came back unreadable, so agreement measured nothing. | An answer budget too small for the model. Check `MODEL_VER` and the budget it needs. |
| `classifier_no_label` | Samples were readable and named no intent this taxonomy holds. | A taxonomy or prompt fault, not a budget one. Compare the answers against `fixtures/taxonomy.json`. |
| `retriever_unreadable` | The embedder answered with something the retriever could not read. | Check the embedding model pin and the provider response. |
| `composer_unreadable` | The composer answered nothing at all. | The same cause, on the compose step. |
| `gate_unreadable` | The coverage judge answered with no verdict. | The same cause, on the gate step. |

Four of these name a model answer this system could not read:
`classifier_unreadable`, `retriever_unreadable`, `composer_unreadable` and
`gate_unreadable`. They are not a verdict and not an abstain, so the run stops
rather than record one. `classifier_no_label` is not one of them: those
samples were readable.

The journal entry carries the shape of the fault, and `costUnknown` when the
provider reported no cost for the call it refused. The shapes are `truncated`
(the answer budget ran out), `no-content` (the response carried no text),
`no-cost`, `no-usage`, `no-choices`, `no-choice`, `no-message`, `no-data`,
`no-item`, `no-vector` and `bad-vector` (the response had a shape this system
cannot read), `empty` (the
model answered nothing), `no-verdict` and `conflicting` (the judge named no
verdict, or two), and `no-label` (no sample named a known intent).

The coverage fit retries a transport fault five times before it gives up.
It waits four times longer after each attempt, because the faults arrive in
clusters. A run over the whole fit half makes some four thousand calls across
hours.
An answer the provider will reproduce is not retried. That draft is dropped
and counted, and the attrition ceiling decides whether the run still means
anything.

Both coverage jobs write each draft to a resume file as that draft lands.
A run that dies continues from there instead of starting over.
The file records the model, the prompt and the half.
It also records what the judge was asked, so an edited claim retires it.
A file from another run is refused rather than mixed in.
A run that cannot write that file stops rather than carry on uncheckpointed.

Four messages come from that file. Each names its own remedy.

`is held by a running job` means another run already owns the file.
Both runs would pay for every draft the other has not finished.
Wait for the first run, or set `GROUNDEDNESS_RESUME` to another path.
A lock whose owner is gone is taken over, so a crash needs no cleanup.

`ends in a partial line` is the normal message after a killed run.
The torn line is dropped and every draft before it is kept.

`describes a different run` means the model, prompt or half changed.
`was scored against different claims` means the corpus changed under them.
Both refuse rather than mix two runs into one published number.
Delete the file to start over, once you know which run you want.

`the resume file could not be written` stops the run on a disk fault.
Fix the disk and start again. The drafts already recorded are still there.

Both jobs report what they spent in micro-dollars.
A faulted draft and a retried attempt cost money nothing can attribute.
The figure then says it is a floor and not a total.

The classifier samples nine times, so one run can meet several shapes.
It names the shape that the most samples reported.
A tie breaks on the shape name.
So the order the provider answered in never decides your remedy.

## 7.1 Seeing a partition fall behind

One consumer owns each partition (DEC-27). A slow run therefore holds up every
ticket behind it in that partition. The register calls this head-of-line delay
and says V1 does not correct it.

Intake signals the consumer when a message arrives, so the consumer does not
sleep through it. A healthy partition therefore reads a queue wait far below
`CONSUMER_INTERVAL_MS` at `p50` and at `p95`. What remains is the signal and
the pickup. No published figure states that number, because no measurement
here has taken it from a live deployment.

Read the partitions against each other, as everywhere else in this section.
An absolute number is not the signal. One partition sitting well above the
others is.

`CONSUMER_INTERVAL_MS` is the ceiling for a lost signal. A partition whose
`p50` sits near half that value has lost its signal, and every partition
sitting there means the database refused the listener. Check the consumer log
for `arrival_signal_lost` or `arrival_signal_unavailable`.

`pnpm run latency` shows it. The job reads the ledger and writes
`latency/vN.json`.

```sh
pnpm run latency
pnpm run latency --since 2026-09-01T00:00:00Z
```

Every statement it runs is a SELECT, so it is safe against a live database.
It writes nothing to the ledger.

It reports two quantities per partition. The queue wait is the time from a
ticket arriving to a consumer picking it up. The service time is the time from
pickup to a terminal state. The two separate a slow model from a busy queue.

Read the partitions against each other, not the totals.

| What you see | What it means | What you do |
|---|---|---|
| One partition's wait far above the others | Head-of-line delay. A slow run is holding up its queue. | Read `pnpm run escalations` for a run stuck in that partition. |
| Every partition's wait `p50` near half `CONSUMER_INTERVAL_MS` | The arrival signal is down. Every consumer is back on the poll. | Check the consumer log for `arrival_signal_lost`, then the database. |
| Every partition's wait rising together, above the poll ceiling | Not head-of-line delay. The system is behind overall. | Add consumers, or look at intake volume. |
| Wait low and service high | The queue is fine and the work is slow. | Check the provider and the deadline setting. |
| Service `max` far above `p99` | A few runs are much slower than the rest. | Read the journal for those runs. |

The last row needs a hundred finished runs in the partition before it says
anything. Below that count `p99` selects the maximum itself, so the two agree
by construction. `p95` needs twenty for the same reason.

Each figure is a duration some run actually recorded, not an interpolation
between two of them. Percentiles, never an average: a partition whose every
hundredth ticket waits an hour has an unremarkable mean.

Read the counts beside the figures. A `p99` over four runs is not a `p99`.

`--since` filters on pickup time, not on arrival. So a run picked up before
the window and still running falls outside it, and that is the run holding up
a partition. Drop the window when you hunt a stalled one.

## 7.2 The counts beside the figures

The job reports five counts rather than folding them into the figures. Each
names one cause, because each sends you somewhere different.

| Count | What it means | What you do |
|---|---|---|
| `unmeasured` | The run carried no arrival time, so it has no wait. | Nothing, unless it grows. A run with no intake row reaches this. |
| `unordered` | The pickup precedes the arrival, so the wait is not a duration. | Check clock synchronisation between the ingress host and the consumer host. |
| `unfinished` | The run has not reached a terminal state. | This separates an idle partition from a stalled one. Both show few finished runs. |
| `unstamped` | The run finished before `db/005` added the column. | Nothing. The count falls as the ledger turns over. |
| `never_ran` | The run reached a terminal state without executing, such as an intake abandonment. | Read `pnpm run escalations`. This count rises when a partition is failing. |

A run the job could not measure never enters a figure as a zero. A zero would
flatter exactly the runs the ledger understands least.

The job observes. It does not correct the delay, and V2 open item 7 stays
open until an adopter chooses a correction on data like this.
`docs/v2-roadmap.md` states what that choice needs.

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
Label the stratified tickets and split them in two equal halves.

Fit the thresholds on one half and keep the other for the reports.
The shipped synthetic corpus holds 2124 cases, 1062 to each half.
A half needs enough drafts to hold the precision floor on its interval.
`scripts/generate-fixtures.mjs` states the sizes the floors imply.

Then run action match for a baseline (DEC-32).
Action match compares each routing decision with the disposition people
actually recorded.
Careful labelling decides the value of every later number.

**Phase 2. Live with gates.** The system does internal writes automatically.
Each customer reply parks as a draft and waits for approval. You measure the
approval-edit distance. This value is the most useful early signal. It shows
how far each draft was from a reply a person can send.

`pnpm run bands` computes it, and the other three band metrics, for one day.
Run it daily. See "Control bands" above for the command and for the lines it
prints when a day carries no band.

The criteria to leave Phase 2 are undecided. They are open item 1 for V2. Do
not invent exit criteria. Watch the bands and wait for the decision.
`docs/v2-roadmap.md` states what blocks that decision and who owns each part.
