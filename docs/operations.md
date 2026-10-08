# Operations runbook

This document is for team members who run the system day to day. It covers
setup, the running processes, the approval workflow, the offline jobs and
observability. The design authority is `docs/v1-architecture.md`. The README
states what the system does. This document states how you operate it.

Read `docs/architecture-map.md` first if you have not seen the system before.
It draws the processes, the jobs and the tables this runbook operates.
`docs/v2-roadmap.md` says what is left in V2 and what blocks each item.

## Contents

1. [Local setup](#1-local-setup)
2. [Schema migrations](#2-schema-migrations)
3. [Running the processes](#3-running-the-processes)
4. [The approval workflow](#4-the-approval-workflow)
5. [Offline jobs](#5-offline-jobs)
6. [The real-corpus curation loop](#6-the-real-corpus-curation-loop)
7. [Observability](#7-observability)
8. [The operator console](#8-the-operator-console)
9. [The phase model](#9-the-phase-model)
10. [Every command this repository defines](#10-every-command-this-repository-defines)

## 1. Local setup

The [Quickstart](../README.md#quickstart) in the README is the only full setup
sequence. It takes a fresh clone to passing tests and a running console. This
runbook starts where it ends.

`pnpm run bootstrap` runs the same script as `./scripts/bootstrap.sh`. It does
the steps that need no choice from you. It starts no container and runs no
migration.

Compose publishes Postgres on host port 5433, and `AURACLE_DB_PORT` moves it.
GreenMail sits behind the `test` profile on 3025 and 3143, moved by
`AURACLE_SMTP_PORT` and `AURACLE_IMAP_PORT`. That server accepts any
credentials, so the profile keeps it out of a deployed stack. A plain
`docker compose up -d` starts the ledger alone.

The compose Postgres reads a `pg_hba.conf` rule from `docker-compose.yml`. It
lets `auracle_reader` log in to the ledger and the test databases only. The
section "The readers' role" explains why.

Check the setup:

```sh
docker compose ps
psql "$DATABASE_URL" -c '\dt'
```

The second command lists the tables `docs/architecture-map.md` draws.

### Configuration files

Most CLIs and daemons load a `.env` file at startup, when one exists in the
working directory. Node reads the file natively, so no extra dependency
exists. A variable set in the shell always wins over the same variable in
`.env`. `OPENROUTER_API_KEY` normally lives in `.env`. Never commit that file.
`.env.example` names every variable, with a comment on each.

These commands read no `.env` file: `pnpm run escalations`,
`pnpm run triage`, `pnpm run export-corpus` and `pnpm run seed-history`. The
operator console reads none either. Export what they need in the shell.

Set `OPENROUTER_BASE_URL` to send model calls somewhere else. Every job that
calls a model reads it, so a gateway or a proxy applies to all of them.

An integer setting set to an empty string is a fault, not an absence.
`PARTITION_COUNT=` refuses the start rather than taking the default. Unset the
variable to get the default. DEC-27 gives each partition one owner, so two
daemons that read the same variable differently break that ownership.

### Running the image

One image holds every process, and its command picks one:

```sh
docker build -t auracle:local .
docker run --rm auracle:local            # prints the commands it accepts
cp .env.example .env                     # OPENROUTER_API_KEY at least
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

The overlay sets `DATABASE_URL` and `READER_DATABASE_URL` itself, and ignores
both in `.env`. That file names `localhost:5433`, which is right for a
checkout. Inside a container, that address is the container's own loopback.

The stack runs the migration first, as a service the daemons depend on. So no
process opens a connection to a ledger that lacks a table. `AURACLE_IMAGE`
selects the tag, and defaults to a local build.

Every published port binds `127.0.0.1`. The webhook accepts every request
while `WEBHOOK_SECRET` is empty. The console serves only an active reviewer,
and a trusted proxy authenticates that reviewer (DEC-45). So put an
authenticating proxy in front of anything another machine reaches.

A merge to `main` runs `.github/workflows/release.yml`. It builds the image
and pushes it to GHCR, tagged with the commit SHA and never `latest`. Nobody
can roll back to a tag that moves.

### The dev host

The `dev` GitHub environment names a host, and
`.github/workflows/release.yml` deploys the image to it on a merge to
`main`. Nothing provisions that host. Prepare it once:

1. Create the directory the deploy writes to. The default is `/srv/auracle`;
   set the `DEV_APP_DIR` repository variable to change it.
2. Put a filled `.env` in that directory. Start from `.env.example`. The
   deploy overwrites both compose files on every run, so `.env` is the only
   durable place for host configuration.
   Set `AURACLE_DB_PASSWORD` and `AURACLE_READER_PASSWORD` in it before the
   first deploy. `openssl rand -hex 24` makes each one. Postgres reads the
   ledger's password only when it creates its data volume.
3. Give the deploy user membership of the `docker` group.
4. Set the `dev` environment's deployment branch policy to `main` only.

Five secrets on the `dev` environment, and the deploy reports which are
missing rather than failing:

| Secret | What it is |
|---|---|
| `DEV_SSH_HOST` | the host the deploy reaches |
| `DEV_SSH_USER` | the account it connects as |
| `DEV_SSH_KEY` | that account's private key |
| `DEV_SSH_KNOWN_HOSTS` | the host's public key, pinned |
| `GHCR_READ_TOKEN` | a `read:packages` token, because the package is private |

Two optional repository variables: `DEV_APP_DIR` and
`DEV_COMPOSE_PROFILES`. Set the second to `mail` to run the IMAP intake.

The ports bind as "Running the image" describes. So put a proxy that
authenticates in front of the console and the webhook before another machine
reaches them. That proxy sets the header `CONSOLE_IDENTITY_HEADER` names,
and strips any copy a client sent (DEC-42). `CONSOLE_ALLOWED_HOSTS` must then
name the host. Without it the console refuses the `Host` the browser sends.

Add each reviewer the proxy names to the roster before the console serves
them:

```sh
pnpm run reviewers -- --add reviewer@example.com
```

## 2. Schema migrations

The ledger schema evolves through numbered SQL files under `db/`. The runner
is `src/ledger/migrate.ts`, and you run it with `pnpm run db:migrate`. There is
no migration framework. Plain SQL stays reviewable, and the architecture keeps
its stance against orchestration layers.

`db/README.md` states what the runner guarantees and the rules for a new file.
One rule matters most to an operator: never edit a file that any database has
already applied.

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

On a database with no `schema_version` table, `db:migrate` applies the files
from 001 onward. Those files are idempotent, so the tables that already exist
stay as they are. No manual step exists.

### The readers' role

The console's readers and `pnpm run latency` connect as a role of their own,
`auracle_reader`. Each read refuses any other session, so the writer's
`DATABASE_URL` cannot stand in for it. The role reads the tables the readers
read.

The role is the barrier against code that holds the readers' URL or pool. It
is not a barrier against a superuser who grants the role more by hand. Each
`db:migrate` restates the role, as described below. The restate takes back
attributes, settings and memberships. It does not look for
every other right a person can grant.

In the ledger's database the role cannot end or cancel a session, or call
`pg_logical_emit_message`. It cannot create a replication slot or origin. It
cannot take an advisory lock, so it cannot hold the migration lock. It cannot
create a large object, a temporary table or an object in `public`. It
holds no membership in another role, and it owns nothing. A read refuses the
role when it holds any attribute beyond a login, any membership, or any
object it owns.

The role logs in to the ledger's database and to no other. In another
database the role gets the rights PUBLIC holds there, so `pg_hba.conf` refuses
that login. The compose stack ships this rule. On any other server, put these
lines above every other line that matches the role:

```
local  auracle  auracle_reader        scram-sha-256
host   auracle  auracle_reader  all   scram-sha-256
local  all      auracle_reader        reject
host   all      auracle_reader  all   reject
```

Replace `auracle` with the name of the ledger's database. In a checkout, the
compose rule also admits the databases a test run clones. Their names begin
`auracle_clone_` or `auracle_tmpl_`. The deploy overlay admits the ledger
alone.

When `READER_DATABASE_URL` is set, `db:migrate` logs in as the role to every
other database after each restate. It uses that URL's host and transport, so
it tests the `pg_hba.conf` lines for that route only. A warning names each
database that admits the role. In a database that is not another ledger,
limit the login in `pg_hba.conf`. A login can also fail for another reason,
such as a timeout. That login decides nothing, and a second warning names it.

Postgres bounds these effects, which stay open to the role:

- A read can raise its own statement timeout. The client still gives up at its
  deadline, but the server runs the query on. The role holds at most 10
  connections, so at most 10 such queries run at once.
- A read can claim memory up to the server's limits. Each process may write at
  most 1 GB of temporary files. A parallel query has more than one process.
- The role can change its own password and its own settings. It can also
  change the default rights on objects it would create. Each is a write to the
  catalog. The next `db:migrate` resets the settings. With
  `READER_DATABASE_URL` set, it also resets the password.
- A read takes a transaction ID when it calls a function that needs one.
  Vacuum reclaims transaction IDs, as it does for every role.

Nothing bounds these effects, so a person ends the session:

- A read can send a NOTIFY, and a session can listen. A session that listens
  and holds a transaction open keeps every notification on the server. When
  the queue fills, intake cannot signal the consumer and refuses tickets.
- A session opened outside a read can hold a lock on a table, or a
  snapshot. It holds each for as long as it stays open. A migration that
  needs that table waits for it.
- A server can allow prepared transactions, with `max_prepared_transactions`
  above zero. There the role can leave one that holds its locks after the
  session ends.

Migration 041 creates the role without a login. `pnpm run db:migrate` then
restates the role on every run. The restate sets the role's attributes, limits
and settings, and removes every membership, whoever granted it. It also removes
any grant the role made from a membership. Then it grants the role CONNECT on
the ledger, USAGE on `public`, and SELECT on the tables the readers read.

The restate also revokes from PUBLIC some rights that act beyond a read, in
the ledger's database only. These are the WAL message, session signal, large
object and advisory lock functions. They are also CREATE on the `public`
schema and TEMP on the database. A role that is not a superuser in that database loses them
too. No process in this repository uses them.

The restate commits, then reads back what it states. It fails `db:migrate`
when the role differs from that. It also fails when the role owns an object
in the ledger's database or on the server. The error names each difference,
and the role's login is unchanged. The restate never gives an object the role
owns to another role.

The restate also creates the role when the server lacks it. A ledger restored
onto a server where migration 041 has not run is such a case.

A person must clear a right PUBLIC holds, a membership, or an object the role
owns. A person must also find what takes a right the role lacks. A rerun
clears an attribute or limit that another session changes, once that session
ends. It also clears a setting the role changes for itself.

Migration 041 and each `db:migrate` after it need a superuser. On PostgreSQL 16
no other role can strip a role's attributes or revoke a predefined role. The
compose stack's role is a superuser.

When `READER_DATABASE_URL` is set, `db:migrate` also gives the role its login,
after a clean read-back. The URL must name the user `auracle_reader`, and the
migrator refuses any other before it applies a file. The server receives a
SCRAM verifier, never the password. So the password appears in no server log.
Without the variable the login does not change.

Before it applies a file, the migrator compares the two URLs. It reads each
as the driver does, and compares the host, port and database. It connects
nowhere for this, so no credential goes to a host `READER_DATABASE_URL` names.
On any difference it fails and migrates nothing.

It also refuses a weaker TLS setting on the readers' URL. The role's own login
uses that URL, so a weaker setting could send its password in clear. The
migrator ranks four levels: none, no certificate check, a certificate check
without the server name, and a full check. When `DATABASE_URL` names a
certificate authority, the readers' URL must name the same one. A client
certificate is each login's own, and the migrator does not compare it.

A host name matches in any case, but two spellings of one server do not.
`localhost` and `127.0.0.1` are two hosts. A socket directory and a host name
are two hosts too. So spell the host alike in both URLs.

After the restate, the migrator logs in as the role through that URL and
checks that it reaches this server. The console makes that check when it
starts.

Supply the password in one of two ways:

- Compose stack: set `AURACLE_READER_PASSWORD` in the host's `.env`. The
  overlay builds `READER_DATABASE_URL` from it for the migration and the
  console. Without it the stack uses the local default, `auracle_reader`.
- Checkout: set `READER_DATABASE_URL` in `.env` for the migration and
  `pnpm run latency`. Export it in the shell for the console, which reads no
  `.env` file.

The password is part of a URL, so percent-encode `@`, `/`, `:`, `?`, `#`, `%`
and a space in it. That advice is for a URL you write yourself. The compose
stack writes both passwords into its URLs unencoded, so give
`AURACLE_DB_PASSWORD` and `AURACLE_READER_PASSWORD` URL-safe characters only.
In a URL you write yourself, use printable ASCII. The migrator refuses a `%`
in the password that starts no escape.

The console reads the URL as the Node `pg` driver does. The migrator refuses a
URL that driver reads with another user or password than the URL standard
does. A leading space causes it. A space elsewhere causes it when the password
holds an escape such as `%2F`. So does a `%` elsewhere that starts no escape.

Set your own password on a host that serves traffic. Anyone who reads this
repository knows the default.

The role belongs to the whole server, as every Postgres role does. Two ledgers
on one server share the readers' role and its password, and each keeps its own
CONNECT grant. They also share its connection limit. When the consoles and latency reports
fill it, the login of the migrator fails.

Two migrations on one ledger at once run in turn. The second waits up to 30
seconds for the migration lock while the first applies its files. It waits
again while the first sets and checks the login. A longer wait fails the
second run, and the message names the migration lock and what applied. Two
migrations from two ledgers on one server can fail with "tuple concurrently
updated". A rerun is safe, so run it again.

A test run sets that password to the default and raises the connection limit.
It does so only on a server on this machine, unless you set
`AURACLE_TEST_ALLOW_REMOTE_DB=1`. The next `db:migrate` restates the limit of
the role.

## 3. Running the processes

The system runs as separate processes. Each process in this section reads
`DATABASE_URL`.
Start each process in its own terminal.

### Start order

Bring a stack up from a checkout in this order. Each step needs the one
before it. For local development, follow the README's Quickstart instead. A
deployed stack runs the image, as "The dev host" in section 1 describes.

```sh
docker compose up -d --wait             # 1. Postgres with pgvector
pnpm run db:migrate                     # 2. ledger schema
pnpm run load-docs -- <dir-of-markdown>  # 3. knowledge base for retrieval
pnpm run consumer                        # 4. runs the state machine
pnpm run relay                           # 5. delivers approved actions
pnpm run imap                            # 6. polls the support mailbox
pnpm run webhook                         # 7. listens for webhook events
```

Steps 1 and 2 prepare the database. Step 3 fills the knowledge base before
the first run retrieves from it. Steps 4 and 5 process what ingress creates.
Steps 6 and 7 turn the stack toward the customers.

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
for messages in its own partitions. A message enters a partition through
`hash(conversation_id)` at enqueue time (DEC-36). A message with no
conversation keys on the ticket id instead, which is the DEC-27 form.

Every run on one conversation lands on the same consumer, so two runs never
process one conversation at once. One consumer owns each partition across the
whole deployment. Two consumers on one partition is a configuration error.

At startup the consumer claims its partitions and raises the fence.
A rebalance can leave two owners for a short time.
The epoch is a number that increases on each claim that moves it.
The ledger refuses a write with an older epoch than the highest one it has seen (DEC-28).
It makes one exception: the approval of a reply parked for a person.
An old owner that is still walking a run fails its next write instead of corrupting the state.

The claim raises the fence of a ticket only while a run of that ticket is in flight.
A reply parked for a person and a record whose run has finished keep their fence.
A restart therefore leaves both alone: the reply stays approvable, and the relay still sends the record.
When the relay refuses a record, it moves the run to `escalated` with the reason, so an operator sees it.

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
| `MODEL_VER` | Chat model pin. The consumer reads it at startup, so a change takes effect at the next start. | `z-ai/glm-5.3-flash` |
| `EMBED_MODEL_VER` | Embedding model pin for retrieval. The chat model does not embed, so this pin is separate. | `openai/text-embedding-3-small` |
| `EMBEDDINGS_USD_PER_MTOK` | Embedding price in US dollars per million tokens, for a gateway whose answer carries no cost (DEC-25). OpenRouter reports the cost itself. | none |
| `PROMPT_VER` | Prompt version pin (DEC-26). | `consumer-prompt-v1` |
| `ACTION_CLASS` | Action class each run executes. | `route_ticket` |
| `ACTION_DELIVERY` | Delivery rule: `at_most_once` or `at_least_once`. | `at_most_once` |
| `ACTION_IS_CUSTOMER_VISIBLE` | `true` gates every action as a customer reply (DEC-12). It must be `true` for `customer_reply` and `false` for every other class. Startup refuses any other pairing. | `false` |
| `DISCLOSURE_TEXT` | Disclosure on gated replies (DEC-14). Required when `ACTION_IS_CUSTOMER_VISIBLE=true`. Startup fails fast without it. A blank value counts as unset: a visible profile refuses it, and a hidden one takes the default. | `This reply was drafted by an automated assistant and reviewed by a person.` |
| `EGRESS_ADAPTER` | Egress adapter that parks gated replies: `helpdesk`, `imap-smtp` or `freescout`. The policy engine reads the selected adapter's capabilities. A hidden `ACTION_CLASS` must be one this adapter performs, or startup refuses. | `helpdesk` |

A reply-generating profile for dogfood looks like this:

```sh
export ACTION_CLASS=customer_reply
export ACTION_IS_CUSTOMER_VISIBLE=true
export DISCLOSURE_TEXT='This reply was drafted by an automated assistant and reviewed by a person.'
```

Each customer-visible action then parks as a draft and waits in the approval
workflow (section 4).

The consumer refuses to start when the two settings disagree. The relay sends
a draft only for `customer_reply`, and it performs every other class as an
internal write. So a customer-visible profile with another class parks a draft
that nobody sends. The reply class with `ACTION_IS_CUSTOMER_VISIBLE=false`
can skip approval (DEC-12), and it parks no draft that the relay can send.

The refusal names both settings and the value it read. The consumer also
refuses a near-miss of `customer_reply`, such as `Customer_Reply` or
`customer-reply`. Hiding the action makes its writes automatic wherever the
gates pass (DEC-12).

A hidden action must also be one the egress adapter performs. The helpdesk
performs `close_ticket`, `route_ticket` and `compensate`. The `imap-smtp` and
`freescout` adapters perform no internal action. The consumer refuses to start
with a class its adapter does not perform. It also refuses a class whose
payload field it does not send. So it refuses `compensate`, because its payload
carries no reason.

Each refusal names only a remedy that starts. That is a class the adapter runs
with the payload, or else the whole customer-reply profile. No refusal names
another adapter, because the relay keeps the adapter it names itself. A refusal
of a visible class offers to hide it only where `EGRESS_ADAPTER` runs that
class.

### Document embedding

A document written in the console waits for its embedding, because the console
calls no model. Every consumer embeds waiting documents on each scan, with
`EMBED_MODEL_VER`. Both retrieval channels ignore a document until a consumer
embeds it. The constants in `src/kb/embed-pending.ts` set each figure in this
part.

A consumer leases a few documents at a time and holds each lease for three
minutes. So two consumers never embed one document, and a consumer that stops
leaves its lease for the next one.

The ledger keeps each failed embedding try and its reason. Only a refusal of
the input uses one of the three tries of a document. That is an HTTP 400, 413
or 422. The
provider also answers 400 for a model pin that names no model. So after a
refusal the consumer embeds a short fixed text with the same model. The
refusal counts only when the model takes that text.

A later scan tries a refused document again after one minute, and after five
more minutes for the third try. After three refusals the document is
`failed`, and it stays out of retrieval.

Any other fault uses no try: an outage, a rate limit, a key, a timeout or a
model pin. The document waits five minutes, and the log carries the reason.
So an outage fails no document, and it needs no step from you afterward.

After its first refusal or deferral, a document goes to the model on its own.
So a document the model refuses costs another document one try at most. A
fault that one document causes, such as a short answer, stops failing its
batch after one call. Of the documents that go alone, the one whose delay ends
first goes first. So a document that keeps failing never blocks the others.

A scan makes two embedding calls. One call is for a document that goes alone,
and one is for up to four new documents. A refusal adds the
probe call after it, so a scan makes four calls at most. The scan waits for its
calls, and the queue waits for the scan. Each call has a deadline of 15
seconds, so a stalled model delays customer messages by one minute at most.

A consumer that stops also waits for its calls. If the process ends first,
its lease holds for three minutes, and then another consumer takes the
document.

A consumer writes no vector, and records no failure, when its lease runs out
during the call. It writes no vector when the text changes during the call. It
never waits for a row another writer holds. A later scan leases that document
once its lease runs out.

The consumer logs these events:

| Event | Fields |
|---|---|
| `documents_embedded` | `docIds` |
| `documents_embedding_retrying` | `failures`, each with `docId` and `reason`: the model refuses the input |
| `documents_embedding_deferred` | `failures`, each with `docId` and `reason`: a fault that uses no try |
| `documents_embedding_failed` | `failures`, each with `docId` and `reason`: the third refusal |
| `documents_embedding_lost` | `failures`, each with `docId` and `reason`: nothing written. The lease runs out or passes on, another writer holds the row, or the text changes |
| `documents_embedding_unrecorded` | `failures`, each with `docId` and `reason`: the ledger does not record the outcome, and the lease runs out |
| `document_embedding_cost` | `costMicros` for the scan's calls, and `costUnknown` when an answer carries no cost it can read |
| `document_embedding_scan_failed` | `error`, a fault of the ledger that costs no document a try |

Read the reasons of all documents that are not embedded:

```sh
psql "$DATABASE_URL" -c \
  "SELECT doc_id, embedding_status, embedding_failures, embedding_error FROM document WHERE embedding_status <> 'embedded';"
```

A `documents_embedding_deferred` event that repeats names a fault to fix,
often the key or the model pin. A `failed` document is one the model refuses.
A body longer than the model accepts fails each time, so shorten the document.
Then return the document to the queue, and the next scan embeds it:

```sh
psql "$DATABASE_URL" -c \
  "UPDATE document SET embedding_status = 'pending', embedding_failures = 0, embedding_error = NULL WHERE doc_id = '<doc-id>' AND embedding_status = 'failed';"
```

A change of embedding model can accept inputs the old one refused. After such
a change, return every failed document at once:

```sh
psql "$DATABASE_URL" -c \
  "UPDATE document SET embedding_status = 'pending', embedding_failures = 0, embedding_error = NULL WHERE embedding_status = 'failed';"
```

### Re-runs from a published document

A document a reviewer publishes from a case also asks for a new attempt of
that case (DEC-50, DEC-49). This runbook calls that request a re-run. It waits
in `document_rerun` until a consumer embeds the document. Each scan then reads
the waiting re-runs of its own partitions, after it embeds documents.

The scan starts the attempt only while the case is as the reviewer left it. A
re-run ends when a person approves, closes or snoozes the case first. A turn
whose reply or action the relay sends, or holds to send, ends it too.
So does another attempt that somebody asks for first, or a later message from
the customer. An automatic write that resolves the case ends it as well.

A person may save or rewrite a reply on the turn after the publish. The re-run
then ends too, so a new attempt never throws their work away (DEC-46). A
failed embedding never starts the attempt. A re-run on a run the system still
walks waits for a person. After `RERUN_STALE_HOURS` in the system's hands,
three hours, the scan takes the run as dead and ends the re-run. The case page draws the same
answer, from the same rule, before the scan records it.

The same post from the case then asks for that re-run again. The new request
keeps the time and the replies of the first one. So a reply that a person
saved since then still ends it. A re-run that a person's act ends stays ended.

Two documents from one case wait for each other. The scan starts one attempt
once a consumer embeds both, and marks both re-runs started.

A case that waits for a person ends `superseded`, as a send-back ends it, with
no note. An escalated case keeps its state and its finish time. So its service
time stays the system's work in `pnpm run latency`. Either way the turn moves
to the next attempt. The scan clears a reply saved on the turn and journals
it. The send-back scan then walks the attempt, with the published document in
reach.

`pnpm run bands` counts a case whose final attempt is above one as assisted.
A send-back note and a published document both raise the attempt. So a case a
published document answers counts as assisted: a person writes the answer.

Bands also counts a case once, on the day of its final attempt. So a re-run of
an older case moves it to the day of its new attempt, as a send-back does. The
figures of that earlier day and the baseline change with it.

A publish on a case that the system cannot attempt again still publishes, and
records the reason at once. A run with no turn gives that reason. So does a
case with a helpdesk copy a person could send, or a case that already ended.

The escalation reasons of an attempt that a document asks for begin `rerun_`,
as a send-back's begin `send_back_`. The console and every consumer must
declare the same egress adapter. The page reads the console's declaration,
and the scan reads the consumer's.

A scan reads ten waiting re-runs per pass, the ones it read longest ago first.
`RERUN_BATCH` in `src/knowledge/rerun-start.ts` sets that count, and no
variable changes it.
So a re-run that waits or faults cannot hold the others up. After a fault, no
scan reads the re-run again for a minute per fault, ten at most. The case page
says how often the consumer fails to start it.

A publish waits five seconds at most for a lock or a statement.
`PUBLISH_TIMEOUT_MS` in `src/knowledge/publish.ts` sets that bound. Past that it
writes nothing, and the page says to publish again. The same post twice from
one case publishes once, and the console logs the second as
`console_publish_repeated`. The console refuses a post with the same title and
answer that differs otherwise. Such a post is a second copy of one answer.

The consumer logs these events:

| Event | Fields |
|---|---|
| `reruns_started` | `requests`: the documents whose attempt started |
| `reruns_dropped` | `requests`, each with `docId` and `reason` |
| `reruns_failed` | `requests`: the documents whose embedding failed |
| `reruns_unsettled` | `requests`, each with `docId` and `error`. The request waits for the next scan |
| `rerun_scan_failed` | `error`, a fault of the ledger that settles no request |

Read the requests that are still waiting:

```sh
psql "$DATABASE_URL" -c \
  "SELECT doc_id, run_id, attempt, requested_at FROM document_rerun WHERE status = 'waiting';"
```

### Relay daemon

```sh
pnpm run relay
```

This command runs `dist/relay/main.js`. The relay scans the `outbox` table for
records with the `pending` status. It sends first and sets the status to `sent` second (architecture section 4.4). A crash
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

A send can fail before anything reaches the customer.
The `imap-smtp` adapter reports this when the draft read fails on a dropped connection or a timeout.
It does the same for a throttle and a goodbye before the login.
So does a refusal with the try-later code `UNAVAILABLE` or `INUSE`.
The relay then leaves the record pending, and the next scan sends it.

The `record_relayed` line names the cause in `sendError`, after `no SMTP send was attempted`.
No limit stops these retries. A long run of these lines means the mail server is down, throttled or unreachable.

Some faults are permanent: they recur on every scan, and no attempt can ever reach the customer through them.
These faults are a draft with no To address and a bad draft id or key.
The relay escalates such a record as `not_sent`, and stops retrying it.

The mail server can refuse the login, or refuse to open Drafts or the draft.
The draft or the Drafts mailbox can also be gone.
Each of these escalates as `delivery_unknown`.
A person can send a draft from a mail client, and that moves it out of Drafts.
A relay that stops after its send leaves the draft, and the reply is out.
So a refusal or a missing draft does not show that the customer has no reply.

The ledger can refuse the escalation itself. The relay process then keeps it, and writes it on a later scan.
The `record_failed` line names the escalation the relay owes.
A relay that restarts in that window, or a second relay process, can send the record once more.
An `already_settled` line with a `sendError` means another relay settled a record this one tried to send.
Check the customer's mailbox before anyone sends that reply again.

The process drains the in-flight record on SIGTERM or SIGINT before it exits.

| Variable | Meaning | Default |
|----------|---------|---------|
| `RELAY_ADAPTER` | Egress adapter name: `helpdesk`, `imap-smtp` or `freescout`. | `helpdesk` |
| `RELAY_INTERVAL_MS` | Milliseconds between scans. | 5000 |

The relay reads no action configuration. Every record carries its own delivery
rule in `outbox.delivery`, and the relay reads that rule per record (DEC-29).

### The `imap-smtp` egress adapter

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

### The `freescout` egress adapter

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
| `FREESCOUT_INTERNAL_NOTE` | `true` once the proof below passes. | `false` |

#### The API needs a module that this repository cannot ship

A stock FreeScout install answers `404` to every `/api/` route.
The REST API lives in the `API & Webhooks` module, and a person buys and
installs that module.
A stock FreeScout image ships an empty `Modules` directory.

So the adapter cannot reach a stock instance, and no automated test in this
repository claims it can.
Install the module, mint a key under `Manage`, then check the route by hand.
A person does both in the FreeScout UI:

```sh
curl -H "X-FreeScout-API-Key: $FREESCOUT_API_KEY" \
  http://localhost:8088/api/conversations
```

A `404` means the module is absent. A JSON body means the adapter can run.

#### Bringing an instance up

`docker-compose.freescout.yml` carries a FreeScout service and its database.
It is a separate file, so a bare `docker compose up -d` starts the ledger
database alone and reads none of it.

Set `FREESCOUT_ADMIN_EMAIL` and `FREESCOUT_ADMIN_PASSWORD` in `./.env` first.
This repository commits no FreeScout admin credential.
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

#### The internal-note mode, and the proof it needs

DEC-44 lets the ledger hold the reply instead of the helpdesk.
The adapter declares that capability only where the helpdesk cannot send the
copy it parks.
A FreeScout internal note cannot reach a customer, so a note is such a copy.

Set `FREESCOUT_INTERNAL_NOTE=true` only after proving that your own instance
accepts one.
With it set, the park posts a note instead of a draft thread. The ledger then
holds the approved reply, and a reviewer edits that reply on the console.
Without it, the draft thread is what sends. The declaration reads the variable, so the console offers no editor
until an operator sets it.

Every process that reads the variable must agree.
They are the consumer that parks, the relay that sends, and the console that
approves.
A relay that reads it as false cannot send a reply the console recorded.
It escalates that record instead of posting a copy a person edited.
So the run reaches a person, and no text leaves the ledger unseen.

The proof needs the `API & Webhooks` module, which "The API needs a module
that this repository cannot ship" describes. Open a real conversation, mint a key, then post one note through the API:

```sh
curl -X POST -H "X-FreeScout-API-Key: $FREESCOUT_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"type":"note","text":"Synthetic check: the internal note API works.","user":1,"state":"published"}' \
  http://localhost:8088/api/conversations/<conversation-id>/threads
```

A `201` with a `Resource-ID` header is the proof.
The note must then appear in the FreeScout UI as internal, and the customer
must receive no mail.
Check both before setting the variable.
A `404` means the module is absent, and the adapter cannot take this mode.

No test in this repository covers that proof.
It needs a paid module and a live instance, and this repository ships neither.

### Ingress drivers

Ingress turns an inbound event into a ticket and a message. Two adapters take
messages in: the IMAP poller and the webhook. The helpdesk adapter is egress
only and runs no daemon. A driver calls `enqueueTicket` on the intake table.
The partition consumer picks the ticket up from there.

Start the webhook server:

```sh
pnpm run webhook
```

It listens on `WEBHOOK_PORT` (default 8080) at `WEBHOOK_HOST` (default
`127.0.0.1`). It enqueues into
`PARTITION_COUNT` partitions (default 8). Set the count to the number of
partitions your consumers own.

Both ingress drivers read the channel map at startup (DEC-47). The map is
`products.json` at the working directory, and `PRODUCTS_FILE` names another
path. Each entry maps a channel to a product. The run records the product of the
channel its message arrived on. A process refuses to start when the map is
unreadable, so no message enqueues with an unresolvable product.

A ticket whose channel the map does not name records no product. Its run then
retrieves only the documents that declare none.

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
These ingress defaults differ from the table in "The `imap-smtp` egress adapter".
That egress adapter defaults `IMAP_SECURE` to `false`.
The variable names overlap, but the two configs stay separate.

## 4. The approval workflow

Customer replies never leave the system automatically (DEC-12).
A sent reply is irreversible: the customer reads it and acts on it.
So a person reads every reply before it goes out.
The flow has these steps:

1. The policy engine sends each customer-visible action to the gated path.
2. The coordinator parks the reply in the draft state of its egress adapter
   (DEC-11). The default `helpdesk` adapter is a reference adapter that holds
   drafts in memory. The `imap-smtp` adapter parks them in the Drafts mailbox.
3. The run waits in the `awaiting_approval` state.
4. A person reviews the case in the operator console (DEC-44).
5. A person approves in the console, or with
   `pnpm run approve -- --run <run-id>`.
6. The approval writes a record to the outbox. The idempotency key comes from
   the action semantics (DEC-24). Two runs of one request then produce the
   same key, so a retry cannot deliver the reply twice.
7. The relay picks up the record and delivers the reply through the adapter.

Each customer reply carries a non-empty `disclosure` field (DEC-14).
The disclosure tells the customer that a machine produced the text.
The approval refuses a reply without it.

The approval also records the approval-edit distance on the run.
This value shows how much the person changed the draft before sending it.

Add `--read-back` to measure the real edit.
The CLI then fetches the current draft body from the adapter before the approval commits.
It reads the adapter named by `APPROVE_ADAPTER`.
Known values are `helpdesk`, `imap-smtp` and `freescout`.
The console reads the same variable, as "The operator console" says.
The default is `helpdesk`.

Read-back refuses the approval when the adapter holds no draft.
Approving a missing draft would fabricate the metric.
Reconcile the draft by hand, then approve again.
The CLI prints the outcome as JSON on stdout.
It exits non-zero when the approval does not commit.

### The email flow end to end

The approval flow runs over a real mailbox when both daemons use the
`imap-smtp` adapter. Set `EGRESS_ADAPTER=imap-smtp` before you start the
consumer, with the reply profile above. That adapter performs no internal
action, so the consumer refuses any other profile. Set `RELAY_ADAPTER=imap-smtp`
before you start the relay. The mailbox then keeps the draft state, so it
survives across processes. The flow has these steps:

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
across processes therefore works over the `imap-smtp` and `freescout` adapters
only. Keep the three
adapter variables aligned when you use the mail flow.

### The escalations command

Make `pnpm run escalations` the first command of your workday.
It shows every run that waits for a person.
It prints a JSON array by default. The flag `--pretty` prints a table.
Filter with `--since 24h` or `--state awaiting_approval`.

The REASON column names why the run needs a person. It carries the escalation
reason for a run that escalated. It carries the gate rule for a run that
waits, because a waiting run has not escalated.

The DRAFT column names what an approval acts on. It reads `payload` for a
gated write that parked no customer draft (DEC-34).

The command runs SELECT statements only, so it is safe on a live database.
The command reads no `.env` file, so export `DATABASE_URL` in the shell
when the target differs from the compose default.

## 5. Offline jobs

The offline jobs run on demand. The evaluation jobs read the synthetic fixture
corpus only (DEC-18). The knowledge-base loader reads a directory of markdown
that you pass.

| Command | Task |
|---------|------|
| `pnpm run calibrate` | Fits the global agreement threshold on the fit half of the gold set. Writes `calibration/vN.json`, the next version. Needs `OPENROUTER_API_KEY` and `CALIBRATION_MODEL_VER`. |
| `pnpm run fit-groundedness` | Fits the two coverage thresholds on the fit half. Writes `groundedness/vN.json`. Needs `OPENROUTER_API_KEY` and `GROUNDEDNESS_MODEL_VER`. |
| `pnpm run report-groundedness` | Measures the fitted coverage pair on the report half. Prints precision and negative predictive value with their intervals. Selects nothing and writes no artifact. Needs the same two variables. |
| `pnpm run replay` | Runs the action-match replay over the fixture corpus. Uses the offline stub model. Needs no network and no database. Prints the report as JSON. |
| `pnpm run gold-report` | Scores the report half of the gold set. Writes `gold-report/vN.json`, the next version. |
| `pnpm run triage` | Selects cases for human review with the offline judge. Writes `triage/vN.json`, the next version. |
| `pnpm run load-docs -- <dir>` | Embeds each markdown file into the `document` table for retrieval. Needs `OPENROUTER_API_KEY`. |
| `pnpm run induce [-- output.json]` | Clusters the history and names each cluster. Writes a candidate list for a person. Needs `OPENROUTER_API_KEY`. |

`pnpm run triage` reads the synthetic gold set. To triage live cases, call
`runTriageJob` from `src/triage/run.ts` with `cases` and `goldSource`. The job
refuses injected cases that name no source, because the artifact records
where its cases came from (DEC-18).

Each fitting artifact states how much of its half it could not read.
`groundedness/vN.json` carries `faulted_drafts`, the drafts it dropped.
`calibration/vN.json` carries `unreadable_samples` and
`tickets_with_unreadable`, the samples that yielded no answer and the cases
they fell in. The gold report carries `unreadable_samples` for the same
reason. A number fitted through unreadable answers differs from one measured
on answers. So each job says which kind it is.

The loader onboards the knowledge base for the deployment. It embeds each
markdown file in the directory you pass. It needs `OPENROUTER_API_KEY`.
Set `EMBED_MODEL_VER` to pin the embedding model. A model outside the price
table needs `EMBEDDINGS_USD_PER_MTOK`, or the loader refuses to run.

Each file needs a frontmatter block at the top. The loader rejects unknown
fields. One field is optional: `products`, the products the document serves
(DEC-47). Each file needs these fields:

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

A document written in the console shares the `document` table. The loader
never rewrites one. A file with the same `doc_id` fails, and the report names
the file and the id. Give the file another `doc_id`, or leave the console
document as it is.

The split discipline holds (DEC-31). Calibration reads only the fit half. The
gold report reads only the report half. A threshold picked on the report cases
inflates every published number. Never fit and publish on the same cases.

On the committed corpus each job opens exactly one half. On halves of your own
history each job also opens the other file, to prove the two are disjoint. It
reads identifiers from that file and never a case. So a case-level leak still
needs a code change and cannot happen by accident.

Calibration needs `OPENROUTER_API_KEY`. It classifies each case of the fit
half through the classifier port. Replay needs no network access. The induction job
also needs the key. It accepts optional `CHAT_MODEL_VER` (default
`openai/gpt-4o-mini`) and `EMBED_MODEL_VER`
values.

The induction output is a candidate list only.
A person curates the list to a maximum of 25 intents and sets a risk tier for
each intent (DEC-13).
Rare intents never collect enough labeled examples, so more intents add no
accuracy.
Confidence measures how sure the classifier is.
It does not measure what a mistake costs.
So a person assigns the tier from the cost of an error, not from a score.

Run `pnpm run gold-report` again after a change to a gate or to the model. Run
it again only when the change should move a published number.

### Artifacts on disk

A corrupt artifact stops the process. It does not fall back to the seeds. A
truncated write must not read as "not calibrated yet" behind a gate that still
looks healthy.

Artifacts under `calibration/` are run output and the repository ignores them.
Never commit one. A committed artifact reaches every checkout and moves each
adopter's gates to numbers fitted on somebody else's corpus. Each deployment
runs `pnpm run calibrate` against its own fit half.

Never rename an artifact by hand. The loader picks the file by its name and
reads the version from inside it. It refuses a file where the two disagree.
Copy the whole `calibration/` directory instead.

Keep one file per version. A case-sensitive filesystem holds `v1.json` and
`V1.json` as two files, and both name version 1. The loader refuses that
directory, because nothing records which file a gate read.

A file the loader refuses also stops `pnpm run calibrate`. The job cannot
write its way out of the fault, so remove the file the message names. The job
reads the directory before it samples, so a fault costs no model call.

The gold report, the triage job and the coverage fit apply the same rules.
Each reads its own directory before its own loop.
One scan and one pre-check serve them all.

### When the coverage fit refuses

`pnpm run fit-groundedness` makes one model call per claim, so a full fit half
takes hours. It can refuse, and a refusal is a result.

The job refuses when the measured coverage of a grounded draft and an
ungrounded one do not separate. Any candidate would satisfy a threshold
there, so the message names the coverage values both classes share. Read
that as a fault in the judge or the corpus, not in the job.

It also refuses when the two thresholds land on one value. Architecture
section 4.7 needs three outcomes, and a single value gives two. The gate then
escalates everything or runs everything automatically, and no draft reaches a
person. That happens when the judge scores no draft as ambiguous. Widen the
corpus, or keep the seeds.

The block value is the lowest that holds its floor, not the highest. The groundedness gate escalates a draft
under it. That draft never reaches a person as a draft to approve. A person still handles the escalation, and
`pnpm run escalations` lists it.

The thresholds decide the automatic path only.
DEC-12 gates a customer reply before the gate reads either one. It reaches a
person whatever its coverage. The review band is what puts an internal draft
in front of a person. A larger blocked band leaves fewer drafts a person
can approve. That is the opposite of what the band is for.

The artifact reports coverage for each grade of unsupported claim. An
`unstated_detail` names a specific the document gestures at and never states,
and it is the grade that matters. A fit whose separation comes from the easy
grades alone protects nothing. The per-grade figures are how you see it.

A job creates and reads the directory before it spends, and reads it again to
mint the version it writes. The first step creates the directory the way the
writer does. So a revoked permission on the parent faults before the first
model call. A file dropped in during a run still costs that run. The check
removes a directory that is unusable before the run, not every fault.

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

Emit both sides of each conversation. The export models turns, so an agent
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
conversation share a `conversation_id` and count from turn 1. Each record carries
`intent: 'unlabeled'` until you label it.

Turn order comes from each message's own Date header. The header must state a
zone. A date without one resolves against the clock of the machine you run the
export on. That is a fact about the machine and not about the message, so it
counts as unreadable.

A conversation where one message states no readable date falls back to delivery
order. The export reports every fallback, and it reports every message it
dropped. A dropped message may have no body text or come from neither
party. It may also be an agent message that precedes every customer turn.
Read those counts. They name what the corpus does not hold.

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

The job excludes later turns. A follow-up names no topic of its own. A cluster of
follow-ups therefore spends one of the 25 intents on a group no person can
name (DEC-10). The job prints how many turns it excluded.

A corpus file with no `conversation_id` fails to load, and the message says a
record names no conversation. Run Step 1 again to replace the file.

### Step 3: Review the candidate clusters (human)

Open the candidate file. Read the sample conversations of each cluster. Decide for
each cluster: keep, merge with another cluster, or fold into `other`. Examine
the `other` group before you decide. A conversation that fits no cluster goes there.

### Step 4: Curate the taxonomy (human)

Name each kept intent. Set a risk tier of `low`, `medium` or `high` for each
intent (DEC-13). Keep the total at or below 25 intents including `other`
(DEC-10). Write the result as a `taxonomy.json` beside the corpus file.

### Step 5: Label the stratified sample (human)

Draw a stratified sample over the risk tiers. For each sampled conversation,
record the intent from the curated taxonomy. Record also the queue that
handled the conversation. Then record the `escalated`, `macro_applied`,
`refund_issued` and `first_reply_minutes` values.

These labels replace the placeholders that the exporter wrote. Split the
labeled sample into fit and report halves of equal size (DEC-31).

### Step 6: Fit and publish on your own halves (machine)

Write the two labeled halves as `corpus/fit.json` and `corpus/report.json`.
Each file holds `split`, `source`, `count` and `tickets`. Set `source` to
`real` in the file and in every record. Keep both files under `corpus/`.
That directory is gitignored, and a labeled half never enters the repository
(DEC-18).

Name both halves on every command. The job you run reads one of them. It
takes identifiers from the other to prove the two are disjoint (DEC-31). It
reads none of that half's cases.
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

The two coverage jobs cost about the same. Each makes one model call per
claim, so a half takes hours.

Each job appends every scored draft to a resume file under `groundedness/`.
A run that dies continues from where it stopped when you start it again.

The file records a hash of each case identifier, never the identifier (DEC-18).
Its header names the model, the prompt and the half. The job refuses a file
that describes any other run, rather than mix it in. Samples from two runs would
publish a number from neither. Delete the file to start over, and set
`GROUNDEDNESS_RESUME` to put it elsewhere.

The exported file carries a provenance block. It records every counter and it
names each conversation whose turn order the mailbox decided. Read that list
before you label: those turn numbers are a guess.

`pnpm run fit-groundedness` needs one more thing than the other two. It
resolves each cited document against the shipped fixture set. So a real half
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
that share a conversation. A conversation split across the halves would fit and
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

### How a log line holds a value from outside

Every process writes each structured log line as one JSON object. Some values
come from outside, such as a request, an inbound message or an adapter's error.
Such a value can hold a character that a log reader treats as a line break. It
can also hold one that changes the order a person sees.

JSON leaves those characters raw, so every process writes each one as a JSON
escape. They are the C1 controls, the Unicode line and paragraph separators,
and the format characters, which include the bidi controls. So `\u2028` in a
line is a character the logged value holds. It is not damage to the log. A JSON
reader returns the value unchanged.

A command that prints a report for a person escapes the same characters. The
approval outcome, the escalations list and table, and the triage, replay and
gold reports do this. The fault a command prints when it fails does too.

A command also prints plain text: the escalations table, a fault or warning,
and the approval refusal. That text has one more rule. A backslash prints as
two backslashes. So `\u202e` there is a character the
value holds. `\\u202e` is the six characters a person typed.

The console draws a page, not a line, so it isolates such a value instead. A
value that holds a bidi control or a right-to-left letter is drawn inside a
`<bdi>` element. A run control or a paragraph separator shows as its name,
such as `U+202E`. So a value cannot reverse the text after it. The reply editor, a page title and a form field hold the text as it is.
There a tag would be text, and it would be saved with the reply.

### Which gate numbers a process runs on

Every process that evaluates policy resolves its gate numbers once at startup.
It reads the highest artifact under `calibration/` and logs what it adopted.
Read that line before you trust a gate number.

```
{"event":"gate_thresholds_seeded","reason":"no calibration artifact found","agreement":0.6,...}
{"event":"gate_thresholds_fitted","version":3,"scope":"all_turns","agreement":0.72,...}
```

A `gate_thresholds_seeded` line means no fit has run. The documented seeds of
architecture sections 4.5 and 4.7 apply. This is the ordinary state of a fresh
checkout and it is not a fault.

A `gate_thresholds_fitted` line names the artifact version behind the number.
Run `pnpm run calibrate` to produce the next one, then restart the consumers.
A running process never re-reads the artifact, so a fit takes effect at the
next start.

Both gates have a job that fits them: `pnpm run calibrate` and
`pnpm run fit-groundedness`. Both numbers reach the runtime. Each gate
reads its own artifact and keeps its own seed when that artifact is absent.
So one gate can run fitted beside a gate that runs seeded.

Each gate logs a line of its own at startup. Read `gate_thresholds_fitted` or
`gate_thresholds_seeded` for the agreement number. Read
`coverage_thresholds_fitted` or `coverage_thresholds_seeded` for the pair.
One line that covers both gates cannot report a mixed state.

The gates stay independent. Neither artifact supplies a number to the other
gate. No path joins a coverage value to an agreement value (DEC-05).

The `gold_source` field on that line names the data behind the number. It
reads `synthetic` for the shipped corpus and `real` for a half of your own
history. The `model_ver` and `prompt_ver` fields name the pins the fit ran
under.

Read those two. The consumer checks the model behind a fitted coverage pair.
It refuses to start when that model is not the one `MODEL_VER` names.

A threshold is one model's judgment of what coverage means. A model that
reads claims more generously reaches the same number on weaker evidence.
So a pair fitted under another pin runs a gate nobody measured (DEC-26).

The refusal does not fall back to the seeds, and that is deliberate.
The shipped review seed is looser than this repository's own fit.
Falling back opens the gate wider than the evidence supports.
Re-fit with `pnpm run fit-groundedness`, or set `MODEL_VER` to the fitted pin.
`pnpm run report-groundedness` refuses a pin mismatch for the same reason.

Every gate journal row records the numbers that decided it. A rolling restart
gives one consumer a new fit while another still holds the old one. So two
identical tickets can decide differently for a legitimate reason. The journal
row says which numbers each run applied.

The gate row also records the risk tier it judged the intent at (DEC-13). A
customer reply stops on its own rule before the `high_risk` rule runs. So the
rule alone never marks a waiting reply as high-tier. The tier does. A gate
row with no tier places its reply in the queue by its rule alone.

`pnpm run gold-report` reads the calibration artifact. A clean checkout carries none,
so it scores through the seeds and the artifact says `gate_source: seed`. A
machine that holds a fit publishes different rates. Its artifact names the
version and the turn population behind them. The gate is part of the number.

### When a connection to the ledger fails

Every process listens on each connection to the ledger, and on its pool. A
connection can fail when the ledger restarts, fails over or ends the session.
A statement in progress on it fails as usual, and that failure is the report.
The process also logs `db_client_failed` once the connection is gone. That
line can follow the statement's own failure. It holds the process, the reason,
and `held`: whether a caller has the connection when the event arrives.

Without the listeners Node ends the process. That ends the console with every
page, or a consumer in the middle of a scan.

### Control bands

The file `bands.yaml` defines the metrics and the window, in `window_days`.

| Metric | Source | Direction |
|--------|--------|-----------|
| `abstain_rate` | composer and groundedness results | high is bad |
| `gate_pass_rate` | classifier agreement gate | low is bad |
| `approval_edit_distance` | `run.approval_edit_distance`, set at approval | high is bad |
| `relay_delivery_unknown_count` | outbox delivery status | high is bad. Any count above zero needs a person to look |

The bands define three actions:

- 1 sigma: log. No action.
- 2 sigma: diagnose read-only. Read dashboards and journals. Change nothing.
- 3 sigma: propose a change through a pull request.

#### Reading a day

`pnpm run bands` reports every metric for one day.

```sh
DATABASE_URL=... pnpm run bands
DATABASE_URL=... pnpm run bands -- --day 2026-09-01
```

The command reads the ledger and writes `bands/v<n>.json`. Every statement is
a SELECT, so it is safe against a live database. The default day is the most
recent complete UTC day. A part of today compares against whole days, and
every morning would then look like an excursion.

The baseline covers the most recent measured days of the window before the day
you asked for. It never includes that day. A day inside its own baseline pulls
the mean toward itself. So a bad day reads less bad the worse it gets.

`bands.yaml` holds no baseline. `pnpm run bands` computes one from your ledger
whenever the window holds enough days, so that number stays with you. A
baseline is a production number, and this repository ships synthetic fixtures
only.

#### When a day carries no band

The report states a band, or it states why it has none. It never states both.

| Line | Meaning | What to do |
|---|---|---|
| `no baseline: 7 of 30 days` | Too few days in reach measured anything. | Wait. The count rises as the ledger fills. |
| `the day measured nothing` | No run that day reached the step this metric measures. | Check that traffic reached the consumer. |
| `steady at 0 over 30 days` | The metric held one value all window, and today matches it. | Nothing. This is the healthy reading for the delivery count. |
| `no spread over 30 days, and today moved to 3` | The metric held one value all window, and today left it. | Look now. There is no sigma to measure the step against. |
| `the day measured a value that is not a number` | The ledger holds a value no arithmetic can use. | Read the ledger for that day. This needs a person. |
| `the window spans more than one provider: stub and model` | The compared days span more than one model provider. | Wait out the window, or read the days on each side of the change separately. |

Each line has a code in the artifact, in `shortfall_code`. Read that rather
than the sentence if a tool consumes the file.

The provider line has a cost worth knowing before you meet it. A band
compares a day against the window before it. So a change of provider silences
every metric until the window clears. A run with no recorded provider differs
from every run that has one. So a window that holds both kinds emits no
verdict until it clears.

The artifact names the day's own provider in `provider`. It reads `mixed` when
the day's runs disagreed, and null when none of them recorded one. An artifact
with no `provider` key reads as null.

The baseline counts daily samples, not calendar days. The job reads 60 days,
`LOOKBACK_DAYS` in `src/bands/metrics.ts`, to find them. A quiet day yields no sample. A rule of consecutive days
lets one quiet weekend blind the band for a whole window.

#### The counts beside each metric

Each metric reports the runs behind its value. Three counts can sit beside it.

`not reached` counts runs that never reached the step. A customer reply never
reaches the agreement gate, because DEC-12 gates it first. The gate metric
excludes those runs rather than counting them as failures. Otherwise the rate
would follow your traffic mix instead of the classifier.

`still to land` counts runs whose contribution may still arrive. It sits
beside the two values that settle late, and the next section explains them.

`unrecorded` counts runs whose journal cannot answer. A gate row that names no
rule carries no such answer. A high count means the numbers rest on few
runs, so read the `over N runs` figure beside them.

#### Two values that settle late

The report files `approval_edit_distance` and `relay_delivery_unknown_count`
under the day it picked the run up. Both values arrive later. A person writes
one at approval, and the relay writes the other when it gives up on a
delivery. Neither table records that moment, so the run is the only day the
report can use.

So a recent day is provisional. Running the command again for the same day
can return a different value. Each run writes a new version rather than
replacing the last. The edit distance prints the count of runs still
awaiting approval beside it. The delivery count prints the records the relay
has not resolved. Both say how much of that day could still arrive.

A count of zero means no known contribution is outstanding. It does not
prove the day is final. A run of that day may still be working, or it may
have stopped between steps. Either way, it appears in neither count and can
still acquire a value later.

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

A status of `not_sent` means that no attempt on the record reaches the customer.
The relay stops retrying it, because no retry can send it.
The `escalate` journal row names the cause.
The turn stays open to a new attempt. A later message on the conversation parks one.
A send-back still refuses while the mail adapter's draft is in Drafts.

A status of `fenced` means the fence moves past a record whose run is still in flight.
The relay sends nothing, and the record keeps the key a re-run would collide with.
It moves the run to `escalated` with the cause, so a person decides what happens to that action.

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
| `park_unresolved` | The coordinator could not park the approval. | Check the egress adapter. |
| `egress_refused` | The egress refused, and a retry can never clear it. | Fix the target system or the action. |
| `classifier_unreadable` | Every classifier sample came back unreadable, so agreement measured nothing. | An answer budget too small for the model. Check `MODEL_VER` and the budget it needs. |
| `classifier_no_label` | Samples were readable and named no intent this taxonomy holds. | A taxonomy or prompt fault, not a budget one. Compare the answers against `fixtures/taxonomy.json`. |
| `retriever_unreadable` | The embedder answered with something the retriever could not read, or with no cost and no `EMBEDDINGS_USD_PER_MTOK` to price it. | Check the embedding model pin, the provider response and the price. |
| `composer_unreadable` | The composer answered nothing at all. | The same cause, on the compose step. |
| `gate_unreadable` | The coverage judge answered with no verdict. | The same cause, on the gate step. |
| `internal_fault` | An invariant inside the coordinator did not hold. | A defect in this system. Read `fault` on the escalate row, then file an issue with that message. |

Four of these name a model answer this system could not read:
`classifier_unreadable`, `retriever_unreadable`, `composer_unreadable` and
`gate_unreadable`. They are not a verdict and not an abstain, so the run stops
rather than record one. `classifier_no_label` is not one of them: those
samples were readable.

The last reason names this system rather than a model, a limit or a target
system. These checks raise it.

A step reads a value the step before it does not
write. A transition addresses a run row the ledger does not hold. The gate
meets an intent the taxonomy does not define. A final step asks the run to go
on. A newer walk cannot hand the turn back to the run that parked its draft.

The escalate row carries a `fault` field beside the reason. It holds the
message of the check that refused. The reason alone names no step and no
value, so quote that message in the issue you file. `pnpm run escalations`
prints it in the JSON output, and under the table with `--pretty`. A retry
never clears one of these, so the run escalates and the queued message is
acked.

One of them reaches no terminal state. It is the check that says the run
row is gone. The hand-back says the run "could not hand its turn back". It
fails the same way when the row of the walking run is gone, and otherwise it
escalates. Each escalation tries to move that missing row, so it fails
again.

The journal still records the escalate row, because it holds no foreign key
to the run. The queue selects runs by state, so it cannot show that row. Read
`step_journal` directly when a consumer logs either message and the queue
shows nothing.

The journal entry carries the shape of the fault. It also carries
`costUnknown` when the provider reported no cost for the call it refused.

The shapes are `truncated` (the answer budget ran out) and `no-content`
(the response carried no text). A third group names a response this system
cannot read. It holds `no-cost`, `no-usage`, `no-choices`, `no-choice`,
`no-message`, `no-data`, `no-item`, `no-vector`, `bad-vector` and
`bad-index`.
`empty` means the model answered nothing. `no-verdict` and `conflicting`
mean the judge named no verdict, or two. `no-label` means no sample named
a known intent.

Both coverage jobs try a draft five times on a transport fault. Then the job
stops, and a new start continues from the resume file. A retry asks each
claim of that draft again, so one fault can repeat earlier calls. Each job
waits four times longer after each try, because the faults arrive in
clusters.
The job does not retry an answer the provider reproduces. It drops that
draft and counts it, and the attrition ceiling decides whether the job's result still
means anything.

Both coverage jobs write each draft to a resume file as that draft lands.
A run that dies continues from there instead of starting over.
The file records the model, the prompt and the half.
It also records what the job asks the judge, so an edited claim retires it.
The job refuses a file from another run, rather than mix it in.
A run that cannot write that file stops rather than carry on uncheckpointed.

These messages come from that file. Each names its own remedy.

`is held by a running job` means another run already owns the file.
Both runs would pay for every draft the other has not finished.
Wait for the first run, or set `GROUNDEDNESS_RESUME` to another path.
The job takes over a lock whose owner is gone, so a crash needs no cleanup.

`ends in a partial line` is the normal message after a killed run.
The job drops the torn line and keeps every draft before it.

`describes a different run` means the model, prompt or half changed.
`was scored against different claims` means the corpus changed under them.
Both refuse rather than mix two runs into one published number.
Delete the file to start over, once you know which run you want.

`the resume file could not be written` stops the run on a disk fault.
Fix the disk and start again. The drafts already recorded are still there.

Three messages mean the file is damaged: `does not begin with a run header`,
`holds a line this job cannot read` and `holds a row whose sample this job
cannot read`. Delete the file to start over.

An operating-system error that names the file, such as `EACCES`, `ENOSPC` or
`EIO`, is a disk or permission fault. Fix it and start again. Do not delete
the file, because it holds drafts that already cost model calls.

Both jobs report what they spent in micro-dollars.
A faulted draft and a retried call cost money nothing can attribute.
The figure then says it is a floor and not a total.

The classifier samples nine times, so one run can meet several shapes.
It names the shape that the most samples reported.
A tie breaks on the shape name.
So the order the provider answered in never decides your remedy.

### Seeing a partition fall behind

One consumer owns each partition (DEC-27). A slow run therefore holds up every
ticket behind it in that partition. The register calls this head-of-line delay
and says V1 does not correct it.

Intake signals the consumer when a message arrives, so the consumer does not
sleep through it. A healthy partition therefore reads a queue wait far below
`CONSUMER_INTERVAL_MS` at `p50` and at `p95`. What remains is the signal and
the pickup. No published figure states that number, because no measurement
here comes from a live deployment.

Read the partitions against each other, as everywhere else in this section.
An absolute number is not the signal. One partition sitting well above the
others is.

`CONSUMER_INTERVAL_MS` is the ceiling for a lost signal. A partition whose
`p50` sits near half that value loses its signal. Every partition
sitting there means the database refuses the listener. Check the consumer log
for `arrival_signal_lost` or `arrival_signal_unavailable`.

`pnpm run latency` shows it. The job reads the ledger as the readers' role,
through `READER_DATABASE_URL`, and writes `latency/vN.json`.

```sh
pnpm run latency
pnpm run latency --since 2026-09-01T00:00:00Z
```

Its one statement is a SELECT, so it is safe against a live database. It
writes nothing to the ledger. The statement runs alone in one READ ONLY
transaction, with a 60-second timeout.

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
the window and still running falls outside it. That is the run holding up
a partition. Drop the window when you hunt a stalled one.

#### The counts beside the figures

The job reports six counts rather than folding them into the figures. Each
names one cause, because each sends you somewhere different.

| Count | What it means | What you do |
|---|---|---|
| `unmeasured` | The run carries no arrival time, so it has no wait. | Nothing, unless it grows. A run with no intake row reaches this. |
| `unordered` | The pickup precedes the arrival, or the finish precedes the pickup, so the figure is not a duration. | Check clock synchronization between the ingress host and the consumer host. |
| `unfinished` | The run is not in a terminal state. | This separates an idle partition from a stalled one. Both show few finished runs. |
| `unstamped` | The run carries no finish time. | Nothing, unless it grows. |
| `never_ran` | The run reaches a terminal state without executing, such as an intake abandonment. | Read `pnpm run escalations`. This count rises when a partition is failing. |
| `snoozed` | A reviewer puts the case aside (DEC-48). Its duration is the wait, not work. | Nothing. It is the wait the distribution leaves out, and it falls as reviewers answer those cases. |

A run the job cannot measure never enters a figure as a zero. A zero would
flatter exactly the runs the ledger understands least.

The job observes. It does not correct the delay. V2 open item 7 stays
open until an adopter chooses a correction on data like this.
`docs/v2-roadmap.md` states what that choice needs.

## 8. The operator console

### Starting the console

The console reads the ledger and approves a parked draft. It is a separate
package, so nothing it needs reaches the daemons.

```sh
pnpm install
pnpm run build
DATABASE_URL=postgres://auracle:auracle@localhost:5433/auracle \
READER_DATABASE_URL=postgres://auracle_reader:auracle_reader@localhost:5433/auracle \
CONSOLE_IDENTITY_HEADER=<header-your-proxy-sets> \
  pnpm --filter @auracle/console start
```

`pnpm run build` compiles the core and the console together, because the
solution references both. Without an identity source, the console refuses
every request. The README's Quickstart uses `CONSOLE_DEV_REVIEWER` from source
instead, for a checkout.

It listens on 127.0.0.1:8787. Set `CONSOLE_PORT` and `CONSOLE_HOST` to change
that.

The console reads no `.env` file. Name `DATABASE_URL` and
`READER_DATABASE_URL` on the command line, as above. It refuses to start without either, or when it cannot reach a
ledger through either. So a wrong URL fails at startup rather than one page at
a time. "The readers' role" says how the role gets its login.

### Host checks and the trusted proxy

The console answers only the host names it was started for. It refuses a
form post that did not come from one of its own pages. Those two checks stop
a browser attack. They are not access control. Anyone who reaches the port
can send both signals. So the network the console binds to decides who
approves a reply.

It derives the host names from the bind. That covers loopback under every
spelling a browser sends, and it covers no other name. Put a reverse proxy in
front, and the browser sends the proxy's name instead. Name it in
`CONSOLE_ALLOWED_HOSTS`, as a comma-separated list:

```sh
CONSOLE_ALLOWED_HOSTS=console.internal.example,console.internal.example:8443 \
  pnpm --filter @auracle/console start
```

Each entry is a host and a port, exactly as the browser sends it. Omit the
port only for port 80 or 443. An unnamed proxy gets every request refused,
and the console still looks healthy from the machine it runs on.

Naming any host replaces the derived names, so a loopback name no longer
passes. That stops a browser attack, not a caller who chooses its own `Host`
header. Only a network that lets nothing but the proxy reach the port keeps a
caller from skipping the proxy. Name loopback as well if you want it, and the
list then says so.

A read from a script needs no header. An approval does: send
`Sec-Fetch-Site: same-origin`, or an `Origin` the console answers to. Every
browser sends one of the two, and a page that did not come from this console
can send neither.

Binding to loopback is not a defense. Any page the operator has open can
post to a loopback port. A name an attacker controls can resolve to
127.0.0.1. That gives their page a same-origin handle on this console. A
reverse proxy that authenticates does not help either, because the browser
it acts through is already authenticated.

The console holds no credential of its own. It serves nothing to a request
with no active reviewer behind it, and a trusted proxy authenticates that
reviewer (DEC-45).

The header it reads is a bearer credential. So keep the port unreachable
except through the proxy. Have the proxy set that header on every request and
strip any copy a client sent.

A client that reaches the port directly is served when it sends the header
itself. The console cannot tell that request from a proxied one.

### The surfaces and the rail

These surfaces read live data: the queue, one case, the runs and one run in
detail. One conversation and one document. The knowledge screen, the team
screen and the routing screen. The control bands and the partition latency.

The rail is the navigation column at the left of every page. It holds most of
the surfaces and the design notes, in groups.

Work holds the queue, named Needs a person, which a reviewer comes to clear. Knowledge
holds the knowledge screen, named Knowledge base, and the team screen. Admin
holds the routing screen, the runs, the bands and the latency. Admin also holds
the design notes. The rail draws no group that has no surface.

### The knowledge screen

The knowledge screen is at `/knowledge`. It counts the cases a gap blocks over
the last 14 days (DEC-50). A case is a turn, or a run with no turn. A run of it
reaches a person when it parks for approval or escalates.

The latest run that reaches a person, and that drafts a reply or abstains,
decides the case. That run is the attempt of record. A run that does neither,
such as the end of a send-back, cannot hide an earlier gap. The gap blocks the
case when the composer abstains, or when the gate refuses a claim. A refusal
counts only where the case page draws one on the draft. A person may rewrite
the reply, and the gap still counts.

The page shows four cards. Cases blocked by a gap. Documents past their review
date, counted today. Documents a reviewer published in the window. Cases a
supported claim on one of those answers, when no gap blocks them. The first
card names any case whose journal it cannot read, since its figure leaves such
a case out.

The page ranks the gaps by blocked cases, grouped by intent and product. Each
gap names the documents the gate refuses claims on. The ranking and the cards
read each case's attempt of record.

The documents that need a person follow: a refused one, a failed embedding, or
one past review. This list reads every attempt a person saw in the window.
Each row gives its citations, its owner and a change flag. The flag reads not
cited, unchanged, changed since a case read it, or not compared.

A case page shows the same answer for its case, and names its attempt of
record. A case older than the window says that the screen does not count it.
So does a case whose journal it cannot read. A fault reading the cards logs
`console_knowledge_unread`. A fault reading one case's gap logs
`console_gap_unread`. Each page names the fault's tag and still draws.

The screen shares one read among the reviewers who load it together. The
read's statements have a deadline of three seconds in all, and its commit or
rollback has three more. So it holds a connection six seconds at most. A page
gives up on a read after six seconds. A read that fails after that logs
`console_read_late_fault`, with its reason.

A case page also holds the knowledge card. A reviewer writes the missing
document there: a title, the products, the answer, an owner and a review date.
The review date opens blank, and it must fall after today (DEC-23). The case's
own product is always among the products (DEC-47). A case whose channel maps no
product cannot publish, and the card says to map the channel first. The answer
takes 7,000 bytes at most, which the model reads in one piece.

The console refuses a document whose title, answer or owner names the case. It
looks for the customer address, in any case. It also looks for every ticket
id, message id and draft handle of the conversation. It matches each as a
whole token. It reads a number alone as a ticket id only after a mark. The
mark is `#`, or a word such as ticket, case or conversation.

The check reads the text after it folds look-alike characters, dashes, digits
of other scripts, and percent and HTML encoding. It finds the case's own
identifiers and nothing else. It is not a personal-data check.

A refused publish draws the form again, holding what the reviewer wrote. The
card lists each document published from the case, and the state of its new
attempt. The attempt waits, it has started, or it does not start. It does not
start when the embedding fails, with the reason, or when the case changes
first. A fault reading that list logs `console_reruns_unread`.

The console logs `console_published` and `console_publish_refused` with the
outcome. Each also holds the lengths of the title and the answer, never their
text. A fault logs `console_publish_failed` with a tag, and the page names the
tag.

### The team screen

The team screen is at `/team`. It shows how few cases reach the team, and how
long a case holds one of its people. Every figure comes from the ledger.

A case is a turn, and its final attempt decides how it ends, as `pnpm run bands`
counts one. A run with no turn is its own case.

One rule differs from bands. A run can strand partway, and a newer run of the
same attempt then hands the turn back to it. The newer run, superseded, never
stands for its attempt. The screen sorts each case by
how it ends:

| Ending | The final run |
|---|---|
| answered automatically | resolved, with no approver, no park and no earlier attempt |
| needed a person | parked, approved, closed, snoozed, rewritten, sent back, or on a later attempt |
| escalated | escalated |
| in progress | not finished |
| no answer | abandoned, or superseded by something other than a send-back |

The first card gives the share of today's cases that reach a person, with its
counts. It counts the cases that ended and the cases that wait for a person.
Today is the UTC day. A case in progress is outside the share, and the card
names it. This is a live figure, and it is not the published
containment figure. That figure comes from the gold report.

The second card gives the team's time on support over the last seven days. It
adds the reservation intervals from the reservation history (DEC-46). An interval runs from a
take or a handover to the next event on the case. No interval runs past its
lapse, so a lapse the console notices late adds no time.

An open reservation ends at the lapse its take recorded. An event records no lapse. So
a closed interval ends at most one lapse after it starts, at the console's
current setting.

The third card gives the median case, from the first take to the last send.
A send that a person undoes and sends again counts as one case. A send that
a person undoes and never sends again counts as no case sent.

The fourth card gives the oldest case that waits for approval, and who holds
it. A row for each active reviewer follows. It gives the products they cover,
their cases, their time, the documents they wrote and what they hold now. The
roster's products order the queue and grant no access.

A horizontal bar for each product then splits its cases into the first three
endings. A
legend names each part in words, and the row gives each count in words. A
product with no case draws a sentence and no bar. Every figure with no record
is a sentence, never a zero.

A fault reading the screen logs `console_team_unread`, and the page names the
tag. The page gives up on the read after six seconds, as the knowledge screen
does. The log line then names the wait it gave up on. A fault that arrives
later logs `console_read_late_fault` with the same wait, and gives the reason.

### The routing screen

The routing screen is at `/routing`. It shows what each product may do without
a person, and it writes nothing. It offers no toggle, threshold or new product.

A tab opens each product. Each intent of the taxonomy has a row on the screen,
with the risk tier a person set (DEC-13). The console holds neither the
calibration artifact nor a consumer's action profile, so the ledger answers.

The gate step keeps a gate record: the latest gate verdict of each product and
intent. Each gate record is one row of `gate_latest`. The gate step writes it in
the fenced move to `gated`, so a refused consumer writes none (DEC-28).

The screen reads the gate records and no journal. So the read costs one gate
record for each product and intent, whatever the history. Migration `db/037`
fills the table once from the journal. It reads only runs whose move to
`gated` commits.

Every gate of one product and intent writes the same gate record. So the gate
waits half a second at most for it. The gate skips a write that cannot finish,
and the run goes on to `gated`. The consumer logs `gate_latest_skipped` with
the run, the intent and the error code.

Code `55P03` is a wait for a lock. The gate record then catches up at the next
gate of that product and intent. Any other code repeats at every gate until
someone fixes it, so treat it as a fault.

The threshold is the one in force for that run. The row says whether the fit
chose it for the intent (DEC-41). When a rule stops a run, the gate does not
compare its agreement, and the row says so. A rule that stops an action
whatever the gates read means the product may not act alone. The rules are a
customer reply, an irreversible action, a high-tier intent and a missing
adapter capability. When no rule stops the run, the gates decide, so the
product may act when both pass.

An intent with no gate record says that no run reaches the gate. The backfill
keeps the newest journal row whose shape the gate writes. It counts the newer
journal rows it cannot read, and the row on the screen gives that count. When
it can read no journal row of an intent, the row gives the count instead of a
record. The first row, any reply to a customer, is fixed. Nobody can change
it, and it names DEC-12 as its reason.

An intent that the gate records and the taxonomy does not list has no row.
The product's list gives the count of those intents.

The backfill keeps each intent in the classifier's spelling. The gate keys it
as the policy engine does, so one intent can hold two gate records. The screen
then shows the newer one. It adds the unread journal rows that can be newer
than that record, and leaves out the rest. When some of those can also be
older, the row says "up to" that count.

The ledger records no intake channel. So the screen shows no channel's health,
and says so. It shows the signals the ledger does record for each product. They
are the last arrival of a run or a message, the messages that wait, and those
a consumer retries. A run with no arrival time counts from its start.

A fault reading the screen logs `console_routing_unread`, and the page names
the tag.

### The design notes

The design notes are at `/notes`, and the page reads no ledger. Each card states
one rule the console keeps, and the reason for it. A card joins the page only
when the console makes it true. So a card ships with the feature it describes.

### Addresses

The console opens on the queue, at `/`. The runs list is at `/runs`. Each case
has its own page, at `/case/<run>`. `/?state=` redirects to `/runs` and keeps
its query. `/approvals` redirects to `/` and keeps the queue filter.

A queue link that names a run, `/?run=<run>` or `/approvals?run=<run>`, opens
that case in one redirect. A value that is not a run id opens the queue.

### Reviewers and identity

A reviewer is an operator who approves a reply, and the roster holds the ones
that may. Every request resolves to one before the console builds any page, a
read included. The foot of the rail names the reviewer this request resolved
to. So the rail shows the name the ledger records (DEC-45).

A request resolves a reviewer from the header `CONSOLE_IDENTITY_HEADER` names.
The roster decides whether that name may review. A name that is absent,
inactive or not on the roster names nobody, and the console refuses the
request. A deactivated reviewer is refused exactly like a stranger.

The console refuses to start if the header you name is one a client sets for
itself, such as `cookie`. A name read from it proves nothing, because the
client writes it.

It also refuses a header that carries a credential, such as `authorization`.
The ledger records the name the console resolves, and a credential is not a
name. `hosts.ts` holds both lists.

Each list holds the common names, not every possible name. So have the proxy
name the reviewer in a header of its own: `X-Auth-Request-Email`, for
instance.

It also refuses a variable holding both that header and a development
reviewer, because those are two topologies.

Two commands change the roster, and a third prints it.
`pnpm run reviewers -- --add <identity>` adds a reviewer, and reactivates a
deactivated one. `--deactivate <identity>` deactivates one. `--list` prints
the roster with each date.

A console run from source on loopback may serve as one identity instead, named
by `CONSOLE_DEV_REVIEWER`. It is for working on the surfaces without a proxy.
The console refuses that variable from compiled output and off loopback. So an
image never serves it.

The console also refuses to start when the roster does not hold that identity.
It names the command that adds it. The two variables describe two topologies,
so a console holding both refuses to start as well.

The proxy may send the name as UTF-8 or as Latin-1. The console reads bytes
that decode as UTF-8 as UTF-8, and any other bytes as Latin-1. A Latin-1 name
whose bytes also form valid UTF-8 therefore reads as UTF-8. Such a name is
rare.

### The queue and reservations

The queue names the product of each waiting case (DEC-47). A chip, a small
filter button, for each product carries the count of the whole queue. The console reads the channel
map for the product labels, at the path `PRODUCTS_FILE` names. It refuses to
start when that file is unreadable, as the ingress processes do.

One reviewer holds a case at a time. Taking it reserves it for twenty
minutes. The queue shows the others who holds the reservation, and how long is
left. Set
`CONSOLE_HOLD_LAPSE_MS` to another period.

A reservation lapses on its own when nobody acts on the case. Any reviewer
may still approve a case somebody else holds, because the reservation refuses
no write.

A second reviewer takes it over from the case page, after confirming. A holder
may hand the case to a teammate on the roster, or release it. Taking another
case releases the first.

The case header shows the reservation and the case's place in its queue. That place
counts the cases the queue offers with its filters and its sort. It leaves out
a case somebody else holds.

"Take next case" on the queue takes the first free case in that order. It
passes over a case somebody holds and a case you hold already. It never takes
a case over. A row's Take holds that one case.

The action bar at the foot of the case holds one row of controls and the
send warning. Close, snooze,
hand over, rewrite and send back each open their form at the head of the case.

A case opens from its row on the queue. A conversation and a document open from
the run that names them. The ledger orders conversations by when a problem
opened. That is not when one last needed attention, so a listing would sort by
the wrong thing.

### Keyboard and the pinned script

The console ships one script, and no more. It lights the document a claim
cites. On the queue it moves on j and k, and c takes the focused case. Enter
with nothing focused takes the next case. Esc leaves a case by its back link.
Every surface works without it: a claim carries an anchor to its source, and a
queue row is a link.

The queue legend names only the keys that act, above the rows, where a long
queue cannot hide it.

On a case, Cmd+Enter or Ctrl+Enter presses the case's send button. A send
carries the reply the ledger holds. So in an editor with unsaved changes, the
chord saves them and sends nothing. The page also stops a send that would drop
them, or text typed in any other field on the case.

Without the script, the approval still refuses a change nobody saved. The send
posts the editor's text. The approval refuses a text that differs from the
one the editor drew, says why, and sends nothing.

A hash of its own text pins the script. So a script the page did not
ship cannot run, and neither does one injected into a page.

The console computes the hash from the script at startup. Nobody writes it
down. So the two
cannot drift apart. Neither can they catch an edit. A changed script gets a
changed hash and runs. The bound is what a page may execute, not what a
build may change.

### The runs list and the queue order

The runs surface filters by state. Each state in the ledger has a link, and
the link asks the ledger for that state. It does not hide rows after the read.
The runs list holds 200 rows. A filter applied after that read would show
the newest 200 runs and call them the gated ones. A state the ledger has no
such thing as answers 404.

The rail carries a theme toggle. It sets a cookie and returns to the surface
you were reading, with the queue filter you chose. The console answers dark
until the cookie says otherwise.

The queue sorts by risk first, by age, or by your products first. The sort is
a cookie too, so a take, a filter and the theme keep it. Risk first keeps the
groups. The other two list every case nobody else holds in one order, with
reserved cases last.

Only risk first draws the clean group. So the batch confirm and its `a` key
exist under risk first alone. The queue legend names `a` only there.

The queue lists every run that waits for approval, and each row opens its case.
The list holds every one, because a cap drops the oldest waiting replies off
the end. The queue draws no case beside the list, so its page stays small
however long the backlog grows. A chosen filter stays on each row's link, so
returning from a case keeps it.

An escalated run also waits for a person, but it has nothing to approve. So
the queue does not list it. A line under the header links to the escalated
runs on the runs list, which shows the newest 200. `pnpm run escalations`
lists every one.

The queue draws three groups, in the order a reviewer works them. The first
holds a case that the rule `irreversible` or `high_risk` stopped. It also holds
a case whose gate row records a high-tier intent, and a parked compensation.
The second, Both gates clean, holds a case whose agreement and coverage each
cleared their own line. The third holds every other waiting case. The oldest
case comes first in each group.

Clean compares each gate with its own line and never combines the two
(DEC-05). A gate the ledger did not measure clears nothing, so its case is not
clean. A recorded value outside [0, 1] clears no line either. A case whose rule
is missing or unknown is not clean. A note under the clean group says that
neither gate decided those cases.

Delivery does not move a case to the first group. Every action sends at most
once unless `ACTION_DELIVERY` says otherwise. So that rule would move the whole
queue.

The header states two counts for the UTC day. One is the messages that
arrived. The other is how many of those messages a run parked for a person.
A message counts once, on the day it arrived, however many runs retried it.
A run that recorded no message counts on the day it started. Such a run is not
among the arrivals, so the second count can exceed the first.

The header states no share of one count in the other. The published
containment comes from the gold report, and a live share would read as that
figure.

The count statement has a two-second timeout. Its statements share a
three-second deadline on the client, and its commit or rollback has three more.
The console closes a connection that outlasts either, and never returns it to
the pool. A request waits at most three seconds for a pool connection. The
console gives up on a count read after six seconds.

The console holds a successful count for 30 seconds, and never past the end of
the UTC day. When the console cannot read the counts, the header says so and
names a log tag. The queue still draws.

A run whose park finished counts as reaching the queue. The fence can still
refuse its move to waiting, which is rare. Such a run counts, although nobody
saw it.

The rail also names the ledger the console is bound to. It names the host and
the database, never the credentials. A refused request gets no rail at all, so
it learns no database name.

### The run detail and the case page

The run detail surface reads one run's journal. It shows the steps the run
journals and the documents the retriever returns. It shows the two gate values
beside the thresholds that judged them.

A case shows the reply before the button that sends it. An approver who cannot
read a reply cannot approve it (DEC-40).

The case has two columns. The main column holds the customer's message, the
reply sentence by sentence and the documents the reply cites. The context
column holds why the case reached a person, the two gates, the customer and
the run's steps. The columns sit side by side when the case is at least about
800px wide. Below that width the context column drops under the main column.
While a case is open, the rail marks Needs a person.

"Why this is yours" names the policy rule the journal recorded, and says what
that rule means. It never assumes a rule. On a FreeScout ledger every reply
stops on `no_idempotency` before `customer_visible`, and the case says so.
While the case waits, the card also says what approving does. It states the
delivery rule the park recorded in words.

The two gates are two rows, each against its own lines (DEC-05). A gate with no
value shows a dash, and the reason stands beside it as text.

"This customer" shows what the ledger holds. That is the turn, when the
conversation opened, its state and whether the ledger names a participant. The
ledger holds no name, plan, tenure or account history, and the card says so.
It shows no address.

A fault reading the customer names a log tag, and the case still draws. A
fault reading the run names a log tag too, and shows no outcome. The
approval's answer is then on its `console_approved` or `console_approve_failed`
log line.

The steps are a timeline with no durations. The approval sits in the action
bar. Its warning says whether an undo can reverse the act. A run that
is not waiting opens too. Its header says when the run opened, and its bar says
there is nothing to approve.

Each row names what the ticket is about and which policy rule sent it to a
person. It names how long the run has waited.

It names the agreement and the coverage as well, and whether each one decided
anything.

The gate row records both values on every run. DEC-12 gates a customer reply
before the engine reads either threshold. So most of a queue carries numbers
that judged nothing, and the row marks each such number `not read`. The
case's gate panel says the same, so the row and the case agree.
The rule comes from the gate row, not the escalate row. A run awaiting a
person has not escalated, so the escalate row is empty for every one of them.

Chips above the list narrow it to one rule. The count in the header stays the
whole queue, so a filter never reports a queue that has emptied.

A run parks a helpdesk draft, or an action payload in the ledger (DEC-34).
Both are approvable, and the button says which one it does. A run that parked
neither is one the approval path refuses, and the case says so instead.

A run that parked an action shows that action's payload, field by field. An
approver reads what they approve (DEC-40), and such a run has no drafted reply
to read. The payload names the amount and the target.

That payload can name an account. The console serves it to an active reviewer
only, so put the console behind a proxy that authenticates one (DEC-45).

The warning says whether an undo can reverse the act. Nobody can recall a
sent reply. No undo reverses a compensation either, because the coordinator
judges that class irreversible. It sends at most once, so an unconfirmed send
escalates (DEC-30).

The warning reads the action, not the rule that stopped the run. The engine
tests five rules in order and reports the first that fired. So a compensation
can stop on a rule that says nothing about permanence.

A case reads one journal, for its own run. The queue reads none. Reading one
for every waiting run would be a statement for each row of an uncapped list.

The page draws the reply sentence by sentence, because those sentences joined
are the draft. Each claim carries the document it cites. A claim the judge does not
support carries a mark, and a claim nobody judges carries a different mark. Those are
different facts, and only the first is a warning.

Each sentence also carries a word: accepted, refused, not judged or courtesy.
Color marks the verdict as well, but a reader who cannot see the color reads
the word.

Each cited document carries one of three flags: unchanged, changed since this
run read it, or not compared. The console compares nothing for a document with
no digest, and that includes a document the run did not retrieve.

A reply may open and close with a courtesy sentence (DEC-43). Such a sentence
cites nothing, and the console draws it quieter than the claims around it. The
summary line counts them, so an approver reads how much of the reply rests on
no document.

The heading says the system drafted this reply. It does not say the reply will
be sent. The relay sends the helpdesk copy, and a person may have edited it
since (DEC-11).

### The conversation surface

The conversation surface reads a conversation turn by turn. Each turn shows its number,
the time its message arrived and a chip for what became of it. The chip says
`auto-answered` for a resolved run with no approver and no reply text. An
approved run with no reply text reads the same way. A reply with
text says `approved`, because every customer reply waits for a person (DEC-12).
A turn no run joins says `no run`, and a waiting turn says `waiting for you`.

A resolved run commits its outbox row and does not send it. So only the relay's
`sent` status draws a chip in the success color. Any other status joins the
chip, as in `approved · pending`.

A turn shows its newest run and reads the newest outbox row of any of its runs.
On a turn with reply text, only the approval row that names the reply's draft
counts. So another action on the turn never speaks for the reply. The run and
the row can differ. A retry of the same action writes no row and stops
`superseded`, so its row belongs to an earlier run.

A settled run is a resolved or superseded run, or no run at all. On a turn with
reply text, a settled run reads as the row says. Any other run shows its state
beside the row, as in `approved · escalated · pending`. A turn with no reply
text shows a stopped or running run the same way, as in `superseded · sent`.

A newest run that waits for a person says `waiting for you` and opens its case.
This holds even when an earlier run of the turn sent a reply. The approval queue
lists that run, so the page agrees with it.

A message source can deliver a message again. The run that walks it parks
nothing when the turn is answered. It also parks nothing when another run
already waits with the reply. It stops `superseded`, and its run page names that run, as in
`superseded · the turn was answered by run 4f1c2b8e`. The consumer records the
same kind of reason for a waiting run it ends.

Two walks of one message on one ticket can overlap. A rebalance or a crash
retry causes this. The older walk parks a draft, and then its stale epoch
stops it (DEC-28).

The newer walk gives the turn back to the older run. That run then waits for a
person with its own draft. The newer run stops, and its run page says
`superseded · run 4f1c2b8e had parked the turn's draft`. No second draft
exists.

The park writes a marker before it calls the helpdesk, and the ledger fences
that write. A stale walk stops there and makes no draft. Its park row records
`superseded`. A marker the ledger accepted stays until the park records its
outcome. A newer walk that finds that marker escalates as `park_unresolved`.

A turn can still hold two waiting runs. Two tickets of one conversation can do
so. The approval and the consumer
hold such a turn to one reply. On a helpdesk that takes no idempotency key, the
second draft stays until a person deletes it.

The heading over reply text says what the customer has, and reads the row alone.
"The system replied" needs approved text and a sent row. A pending row says the
send is pending. A malformed row says the relay never sent the reply, because
the relay refuses that row before any send. A `not_sent` row says the same,
because the adapter shows that no delivery reaches the customer. A turn with
no row says only that a person approved the reply.

A fenced row or an unknown row says nobody can confirm the delivery. The relay
can fence a row after a send that timed out (DEC-28). That send may have
reached the customer.

The surface also names why a turn shows no reply. These are the reasons.

An internal write answers, and no reply goes to the customer. A person approves
an action, and the ledger holds no reply text. A run stops. A run is still
running.

Three reasons say a parked run waits for a person, and the park's journal row
says which. A reply is drafted in the helpdesk (DEC-11). An action waits with no
draft, because an internal write parks in the ledger alone (DEC-34). Or the park
names neither kind. That is a reply parked in the ledger alone, a crash marker,
or no park at all. The page then claims neither a draft nor an action.

No run joins the turn at all. A person closed the case with no reply (DEC-48).
A person put the case aside until its period ends.

A stopped run beside a row the relay did not refuse says what became of the
action on that row. The row can belong to an earlier run. So a run that sent
nothing does not show that nothing went out.

A reply a person approved with no text gets a sentence too. Two more reasons
say why a turn shows no message. Nobody kept it, or the customer wrote nothing.
None of these draws a blank.

### The document surface

The document surface shows one document of the index. A citation is worth
showing only if a person can check it. The text is today's, because the
loader rewrites the index in place. A run detail says whether the body moved since that run read it.

One block of the design does not ship. It needs data the ledger does not hold.

No step carries a duration. `step_journal` has no timestamp and no sequence
column, so no step has a start or an end. The order the surface draws is the
reader module's own, and the module says so. `cost_micros` on a journal row is
the run's cost when that step finished, not the step's own cost.

No document carries a rank. The retriever fuses ranks and keeps no score
(DEC-21), and it journals an ordered list of ids. The reranker may reorder
that list, and nothing stored names which order this is. So the surface shows the
recorded position and calls it that. It names no channel either, because
naming the fusion would claim the fusion set the order.

### What the console logs and refuses

The console trims an escalation reason at its first colon. The coordinator writes a
reason from a closed set. The relay and the consumer interpolate a message
into the same field. An adapter message can quote a customer address. Read the
whole text with `pnpm run escalations`.

The console shows the parked draft. A console may approve a reply, and an
approver has to read one first (DEC-40).

Edit the draft in the helpdesk, which is where DEC-11 keeps it. This console
captures no reply text. It measures an edit only by reading the draft back.

The console records the approval it makes. The line names the run, the
outcome, the reviewer, the `Host` and the address it came from. The ledger
records that a run was approved, and the source that named the approver. The
console keeps the client's own record itself.

A fault answers a tag, not a reason. The log carries the reason under the same
tag. An adapter or a driver message can quote a customer address, and this
console serves pages to a reviewer alone. Every other read here withholds such
text, and the fault page does the same.

A refused request answers as a refusal. An oversized approval form answers
413. An address the console cannot read answers 400. Neither reports the
console as broken by a request it declined.

A park step names what the ledger holds. A park that crashed records a key and
no draft. So a draft may sit in the helpdesk that nobody can name. A park the
adapter refused records the fault. The surface names both, and shows neither
message.

### What the ledger stores about a customer

The console shows this, so an operator reading it reads what the ledger holds.
State the position before you carry real traffic (DEC-17, DEC-19).

The table names each place that holds text a customer wrote, would read, or is
named in. Nothing removes any of it by age. A send-back clears the reply a
person saves on its turn, as described below. An undo clears the approved
reply and deletes the outbox record that holds the reply.

| Where | What | Written by |
|---|---|---|
| `turn.body_text` | the inbound message | intake, on every turn |
| `turn.approved_reply_text` | the reply an approval dispatched | the approval path alone |
| `turn.saved_reply_text` | the reply a reviewer edited and saved | the console's save |
| `outbox.reply` | the reply text the relay sends from a record, when the ledger holds it (DEC-44) | the approval path |
| `intake.ticket_text` | the inbound message, until the consumer acks or abandons it | intake, on every message |
| `step_journal.result` on `park` | the drafted reply | every gated run |
| `step_journal.result` on `park` | the fault an adapter raised | a park the adapter refused |
| `step_journal.result` on `compose` | the reply, sentence by sentence | every run that composed |
| `step_journal.result` on `compose` | the body of each cited document | every run that cited one |
| `step_journal.result` on `escalate` | the reason, which interpolates adapter text | the relay and the consumer |
| `step_journal.result` on `close` | the reason the reviewer closed the case | the console's close |
| `run.send_back_note` | the note that steers a new attempt | the console's send-back |
| `step_journal.result` on `send_back` | the same note | the console's send-back |
| `conversation.customer_address` | the participant the messages come from | the first sender that names itself |
| `document.embedding_error` | the provider's message when an embedding call fails, which may quote any document of the same call | every consumer. The knowledge screen and the case page show it to reviewers |
| `document.title` and `document.body` on a console row | a document a reviewer wrote from a case. The check refuses the case's own identifiers, not a name or other personal data | the console's publish |
| `step_journal.result` on `send_back` | the title of the document whose publishing asked for the attempt | the consumer's re-run scan |
| `step_journal.result` on `retrieve` | the title of each document the run read, a reviewer's words when the document comes from a case | every run that retrieved |

A failed call records one message on every document it carries, so a waiting
document's row can quote another. Removing a document does not clear such a
quote from the others. This statement clears it for one document:

```sh
psql "$DATABASE_URL" -c \
  "UPDATE document SET embedding_error = NULL WHERE doc_id = '<doc-id>';"
```

The knowledge screen shows the message of a failed document only. A document
fails on its third refused call, and after its first failure it goes to the
model alone. So the message the screen shows quotes that document and no
other.

The consumer logs the same embedding message in five events:
`documents_embedding_retrying`, `documents_embedding_deferred`,
`documents_embedding_failed`, `documents_embedding_lost` and
`documents_embedding_unrecorded`. It keeps 500 characters at most, and never
the API key. From a JSON error body it keeps the provider's own message and
nothing else. A JSON body with no message becomes a fixed sentence. A body that
is not JSON stays whole, because it is then all the diagnosis there is.

The park fault and the escalation reason hold an address rather than a message.
An adapter builds a fault naming the expected recipient, and an SMTP rejection
quotes one. Both reach a journal row verbatim.

A close reason is a reviewer's own words, and it can quote the customer. The
journal records it on the run, and the console draws it on the case.

A send-back note is a reviewer's own words too. The console writes it in two
places.
The next attempt reads `run.send_back_note` as an instruction. The journal row
records who asked. Clearing the column stops a later attempt from reading it.
Clearing the journal row removes the copy a person reads.

A send-back also clears the reply a person saved on that turn. It records
what it cleared in `clearedReply`, on the same row. `clearedBy` and
`clearedBySource` name who saved it. They are an operator's identifier, kept
as `run.approved_by` is, so the statement below leaves them. The approval
prefers the saved text over the new attempt's reply, so the save cannot stand.
The journal statement below clears `clearedReply` for that reason.

The consumer deletes the `intake` row on the ack and on the abandon. So the
row clears itself, and no statement below names it. A message stuck in retry holds
text until one of those happens.

No statement below removes a document a reviewer writes from a case, either.
Such a document answers later cases, so it outlives the case it comes from. The
console refuses one that names the case's own identifiers.

Remove such a document by hand when it holds other personal data. "Removing a
document written from a case" below gives the steps.

The sentences are the reply. So a run that composed holds a drafted reply,
whether or not a person saw one. An automatic run holds one although it sent
nothing to a customer.

`run.approved_by` holds an operator's own identifier, not a customer's. The
column beside it says what the name proves. `roster` is a name a console
checked against the reviewer roster. `header` is a claim a caller supplied
(DEC-42). `none` says nobody was named.

`turn.saved_reply_by` holds the same kind of identifier, for the reviewer who
saved the reply a turn holds. `turn.saved_reply_by_source` says what that name
proves, in the same words. The purge below clears both with the saved reply.

**This repository ships no retention job and no purge job.** You are the data
controller, so you own the retention period and the erasure path. The
statements below are what an adopter runs to clear each field by age. None of
them removes a run, so the control bands and the replay keep their history.

```sql
-- The customer's message, the reply a person sent, and the reply a person
-- saved with the name of who saved it, past 90 days. A statement that clears
-- the text alone also runs, and leaves the name.
UPDATE turn
   SET body_text = NULL, approved_reply_text = NULL, saved_reply_text = NULL,
       saved_reply_by = NULL, saved_reply_by_source = NULL
 WHERE created_at < now() - interval '90 days';

-- The drafted reply, the cited document bodies, the adapter fault, the
-- escalation reason, the close reason, the send-back note and the title of
-- a document written from the case, past 90 days.
UPDATE step_journal j
   SET result = j.result - 'body' - 'sentences' - 'claims' - 'citedBodies'
                         - 'error' - 'reason' - 'note' - 'clearedReply'
                         - 'documentTitle'
  FROM run r
 WHERE r.run_id = j.run_id
   AND j.step_id IN ('park', 'compose', 'escalate', 'close', 'send_back')
   AND r.created_at < now() - interval '90 days';

-- The note that steers a new attempt, past 90 days. The step_journal
-- statement above clears the copy a person reads.
UPDATE run
   SET send_back_note = NULL
 WHERE created_at < now() - interval '90 days';

-- The reply a record carried, once the relay is done with it, past 90 days.
UPDATE outbox o
   SET reply = NULL
  FROM run r
 WHERE r.run_id = o.run_id
   AND o.status <> 'pending'
   AND r.created_at < now() - interval '90 days';

-- The participant of a conversation with no turn and no run in 90 days. No
-- code moves a conversation out of `open`, so the statement reads activity,
-- not state. It keeps a participant while the conversation holds text or has
-- open work, as the consumer reads it.
UPDATE conversation c
   SET customer_address = NULL
 WHERE c.opened_at < now() - interval '90 days'
   -- No turn that is recent, holds text, or waits for another attempt.
   AND NOT EXISTS (
         SELECT 1 FROM turn t
          WHERE t.conversation_id = c.conversation_id
            AND (t.created_at >= now() - interval '90 days'
                 OR t.body_text IS NOT NULL
                 OR t.approved_reply_text IS NOT NULL
                 OR t.saved_reply_text IS NOT NULL
                 OR (t.attempt > 1
                     AND NOT EXISTS (
                           SELECT 1 FROM run e
                            WHERE e.conversation_id = t.conversation_id
                              AND e.turn_number = t.turn_number
                              AND e.attempt >= t.attempt
                              AND e.state IN ('awaiting_approval', 'snoozed', 'resolved',
                                              'escalated', 'superseded', 'abandoned', 'closed')))))
   -- No queued message that holds text.
   AND NOT EXISTS (
         SELECT 1 FROM intake i
          WHERE i.conversation_id = c.conversation_id
            AND btrim(i.ticket_text) <> '')
   -- No run that is recent or parked.
   AND NOT EXISTS (
         SELECT 1 FROM run r
          WHERE r.conversation_id = c.conversation_id
            AND (r.created_at >= now() - interval '90 days'
                 OR r.state IN ('awaiting_approval', 'snoozed')))
   -- No document request that waits, or whose attempt has started and not landed.
   AND NOT EXISTS (
         SELECT 1 FROM document_rerun q
          WHERE q.conversation_id = c.conversation_id
            AND (q.status = 'waiting'
                 OR (q.status = 'started'
                     AND NOT EXISTS (
                           SELECT 1 FROM run s
                            WHERE s.conversation_id = q.conversation_id
                              AND s.turn_number = q.turn_number
                              AND s.attempt >= q.started_attempt
                              AND s.state IN ('awaiting_approval', 'snoozed', 'resolved',
                                              'escalated', 'superseded', 'abandoned', 'closed')))));
```

Run the five statements in the order shown, with one retention period for all
five. The participant statement then finds each turn already cleared.

The participant statement keeps a participant while the conversation holds text
or has open work. Open work is a parked run or a turn due another attempt. A
document request that waits, or whose attempt has not landed, is open work too.
Such a conversation keeps its participant past the retention period, until that
work ends.

The consumer files a run each time it walks a turn. It walks one for a new
message, a new attempt or a document's attempt. The retention period then
starts again from that run. A person who approves or closes a parked run files
no run, and neither does a request the scan drops. After the five statements
run, this query lists each conversation that still keeps one:

```sql
SELECT conversation_id
  FROM conversation
 WHERE opened_at < now() - interval '90 days'
   AND customer_address IS NOT NULL;
```

Each statement leaves the keys a reader joins on. A cleared `turn` keeps its
number and its ticket, so a conversation still shows the turn and names the
absence. A cleared `park` row keeps `draftExternalId`, so an approval still
derives its idempotency key. A cleared `compose` row keeps `claimCount`, so the
coverage a gate recorded still has a denominator.

Clearing an escalation reason costs an operator the word that named it. The
escalations report reads that key, so a cleared run reports no reason. Choose
the age with that in mind, or leave `reason` and accept the addresses it can
carry.

The five statements read three clocks. The turn statement reads the age of the
turn. The journal, run and outbox statements read the age of the run. The
conversation statement reads the age of the conversation, its last turn and its
last run. Take an old turn whose run is a recent retry. It loses its message
and keeps the drafted reply.

The outbox statement leaves a pending record alone, because the relay still
has to send it.

Clearing a participant has a cost. Intake fills an empty participant from the
next sender who names an address, and never overwrites a recorded one. A
message joins a conversation when the message names one of the conversation's
message ids or its ticket. The sender supplies both. The webhook checks
neither until you set `WEBHOOK_SECRET`, and the mail path checks neither at
all. So after the purge, these things hold:

- Anyone who names a message id or the ticket of the conversation joins it.
- A sender with no address joins without claiming it. Further senders can
  join until one with an address claims it.
- Before a claim, a reply parks with no recipient check, because the
  participant is empty. The draft answers the earlier customer. Mail
  addresses the author of the original thread, and FreeScout addresses the
  customer of its helpdesk conversation. A person still approves it.
- The first sender with an address claims it. The earlier customer then
  writes into a new conversation.
- After a claim, the recipient check refuses each reply to the claimant on
  that thread at park. The thread still belongs to the earlier customer.

The participant statement waits until no turn or queued message holds text. So
the model drafts for whoever claims the conversation, and reads no earlier
message. Choose the retention period with these costs in mind.

The `retrieve` row keeps the title and owner of each document the run read.
For a corpus document those are metadata rather than a customer's words, so no
statement here removes them. Clear the title of a document written from a case
when you remove that document, as the next part says.

Clearing a draft does not reach the helpdesk. The draft parks there as well
(DEC-11), and the adapter's own retention governs that copy.

#### Removing a document written from a case

Every run that reads such a document keeps copies of it in the journal. The
`retrieve` row keeps its title, and the `compose` row keeps its whole body
under `citedBodies`. A `send_back` row keeps its title too. The document's
re-run request also points at it. This block clears those copies of the
title and body, and then the document, in one transaction. Replace
`<doc-id>` with the document's id in every place.

```sql
BEGIN;

UPDATE step_journal
   SET result = jsonb_set(result, '{documents}', (
         SELECT jsonb_agg(CASE WHEN d->>'docId' = '<doc-id>' THEN d - 'title' ELSE d END)
           FROM jsonb_array_elements(result->'documents') d))
 WHERE step_id = 'retrieve'
   AND result->'documents' @> jsonb_build_array(jsonb_build_object('docId', '<doc-id>'));

UPDATE step_journal
   SET result = jsonb_set(result, '{citedBodies}', (result->'citedBodies') - '<doc-id>')
 WHERE step_id = 'compose' AND result->'citedBodies' ? '<doc-id>';

UPDATE step_journal
   SET result = result - 'documentTitle'
 WHERE step_id = 'send_back' AND result->>'document' = '<doc-id>';

-- Wait for a consumer that is starting this document's request, so the check
-- below reads the status it commits. The lock comes last, so a repeat post
-- that waits on it waits only for the deletes.
SELECT 1 FROM document_rerun WHERE doc_id = '<doc-id>' FOR UPDATE;

DO $$
BEGIN
  -- Refuse an id that names no document written from a case.
  IF NOT EXISTS (SELECT 1 FROM document WHERE doc_id = '<doc-id>' AND source = 'console') THEN
    RAISE EXCEPTION 'the id names no document written from a case';
  END IF;
  -- Refuse while the attempt that the document's re-run request names has
  -- started and not landed. A run at that attempt lands when it parks or
  -- ends. Deleting the request before then leaves a turn that no scan walks.
  -- A waiting request has started nothing, so the block deletes it.
  IF EXISTS (
    SELECT 1 FROM document_rerun q
     WHERE q.doc_id = '<doc-id>' AND q.status = 'started'
       AND NOT EXISTS (SELECT 1 FROM run r
                        WHERE r.conversation_id = q.conversation_id
                          AND r.turn_number = q.turn_number
                          AND r.attempt >= q.started_attempt
                          AND r.state IN ('awaiting_approval', 'snoozed', 'resolved',
                                          'escalated', 'superseded', 'abandoned', 'closed'))
  ) THEN
    RAISE EXCEPTION 'the attempt the document''s re-run request names has not landed; run this again once it has';
  END IF;
END $$;

-- Clear again any copy that an attempt of the request's own turn writes while
-- the statements above run. That turn has few runs, so the lock stays short.
UPDATE step_journal
   SET result = jsonb_set(result, '{documents}', (
         SELECT jsonb_agg(CASE WHEN d->>'docId' = '<doc-id>' THEN d - 'title' ELSE d END)
           FROM jsonb_array_elements(result->'documents') d))
 WHERE step_id = 'retrieve'
   AND result->'documents' @> jsonb_build_array(jsonb_build_object('docId', '<doc-id>'))
   AND run_id IN (SELECT r.run_id FROM run r JOIN document_rerun q
                    ON r.conversation_id = q.conversation_id AND r.turn_number = q.turn_number
                  WHERE q.doc_id = '<doc-id>');

UPDATE step_journal
   SET result = jsonb_set(result, '{citedBodies}', (result->'citedBodies') - '<doc-id>')
 WHERE step_id = 'compose' AND result->'citedBodies' ? '<doc-id>'
   AND run_id IN (SELECT r.run_id FROM run r JOIN document_rerun q
                    ON r.conversation_id = q.conversation_id AND r.turn_number = q.turn_number
                  WHERE q.doc_id = '<doc-id>');

UPDATE step_journal
   SET result = result - 'documentTitle'
 WHERE step_id = 'send_back' AND result->>'document' = '<doc-id>'
   AND run_id IN (SELECT r.run_id FROM run r JOIN document_rerun q
                    ON r.conversation_id = q.conversation_id AND r.turn_number = q.turn_number
                  WHERE q.doc_id = '<doc-id>');

DELETE FROM document_rerun WHERE doc_id = '<doc-id>';
DELETE FROM document WHERE doc_id = '<doc-id>';

-- The time the block commits, from the database clock. The wait below starts
-- here. `now()` would give the time the block began.
SELECT clock_timestamp() AS removed_at;

COMMIT;
```

Save the block to a file and run it with
`psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f <file>`. A refusal raises before
the block commits, and the transaction rolls back, so nothing changes.

A reviewer can repeat the post of the document while the block runs. While the
block clears the journal, the console tells such a repeat that the document is
published. The block then removes the document. Once the block holds the lock,
a repeat waits, and then refuses, and the console draws no form.

A repeat during the journal pass can also ask an ended request again. If the
consumer starts that request before the block takes its lock, the block
refuses, and nothing changes. Run it again once that attempt parks or ends.

The repeat waits five seconds at most, the bound of every publish. The console
tells a repeat that waits longer that the case is busy. A reviewer whom the
console tells this can post the same form again at any later time. That post
writes a new document. So tell the reviewers of the case before you run the
block.

So note the case before you run the block. This query gives the run that wrote
the document. No row means the id names no document written from a case, so
stop. It also means the block has run already. Then skip the query of published
documents, and still do the wait and the check for late copies below:

```sql
SELECT q.run_id
  FROM document_rerun q
 WHERE q.doc_id = '<doc-id>';
```

After the block commits, this query lists every document the case publishes. It
reads that run and every run of the same conversation. Read each one. Remove
any that holds the removed text, with the block, under its own id. Run the
query again later, because a reviewer can post again.

```sql
SELECT d.doc_id, d.title, d.created_at
  FROM document d JOIN document_rerun q ON q.doc_id = d.doc_id
 WHERE d.source = 'console'
   AND (q.run_id = '<run-id>'
        OR q.conversation_id = (SELECT conversation_id FROM run WHERE run_id = '<run-id>'))
 ORDER BY d.created_at;
```

A run that reads the document before the block commits can write a copy after
it. Its `compose` row keeps the body under `citedBodies`, and its `retrieve`
and `send_back` rows keep the title. A run that the consumer starts while the
block clears the journal can write them too.

A run that parks or ends writes no more copies. A run still walking after three
hours has stopped mid-walk, and writes none either. The consumer's own re-run
rule reads it the same way. That holds while `TICKET_DEADLINE_MS` stays below
three hours. This query lists each run that is still walking:

```sql
SELECT run_id, state, created_at
  FROM run
 WHERE state NOT IN ('awaiting_approval', 'snoozed', 'resolved',
                     'escalated', 'superseded', 'abandoned', 'closed')
   AND created_at > now() - interval '3 hours'
 ORDER BY created_at;
```

The block prints `removed_at`, the time it commits. Wait until the query lists
no run created before that time. Then run the first three journal statements
of the block again, with the same id. This query
lists each journal row that still holds a copy:

```sql
SELECT run_id, step_id
  FROM step_journal
 WHERE (step_id = 'compose' AND result->'citedBodies' ? '<doc-id>')
    OR (step_id = 'send_back' AND result->>'document' = '<doc-id>' AND result ? 'documentTitle')
    OR (step_id = 'retrieve' AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(result->'documents') d
           WHERE d->>'docId' = '<doc-id>' AND d ? 'title'));
```

This query shows each request of the document, and the state of each run at the
attempt it names. A request that is not `started` does not hold the block back.
A started one holds it back until one of its runs is parked or terminal. An
empty `state` on a started request means no run at that attempt exists yet.

```sql
SELECT q.status, q.started_attempt, r.state
  FROM document_rerun q
  LEFT JOIN run r ON r.conversation_id = q.conversation_id
                 AND r.turn_number = q.turn_number
                 AND r.attempt >= q.started_attempt
 WHERE q.doc_id = '<doc-id>';
```

A drafted or sent reply can quote the document, and the block leaves that
reply. In the journal, the reply lives in the `compose` sentences and the
`park` draft. In the ledger outside the journal, it lives in `outbox.reply` and
in the turn's `approved_reply_text` and `saved_reply_text`. The age statements
above clear each of those once it is past the retention period. The outbox
statement clears a record only once the relay is done with it.

Some copies stay outside the ledger:

- The draft or sent message in the helpdesk or the mailbox. The adapter's own
  retention governs it.
- The five `documents_embedding_*` log events, which keep up to 500
  characters of the provider's message. The log's own retention governs
  them.
- A file `pnpm run export-corpus` has already written. It copies the mailbox
  it reads, sent replies included when that mailbox holds them. Delete or
  rewrite it by hand.
- The model provider. The title and body go to it in each embedding call.
  They also go in the composer prompt and each groundedness call of every run
  that retrieves the document. OpenRouter and the model vendor it routes to
  each keep their own copy, under their own retention. Ask each to delete it
  where its terms allow.
- Base backups, archived write-ahead logs and delayed replicas. Each keeps
  the deleted rows until it expires. A streaming replica replays the deletes.
- The live database's own pages. A plain `VACUUM` lets later writes reuse the
  space of the deleted rows, and the old bytes stay until then. `VACUUM FULL`
  on `document` and `step_journal` rewrites each table without them.

A failed embedding call can quote the document in another document's
`embedding_error`. This query lists every other document that holds such a
message. Read each message. Where one quotes the document, run the
`embedding_error` statement after the table above. Give it the id of the
document that holds the message.

```sql
SELECT doc_id, embedding_error
  FROM document
 WHERE doc_id <> '<doc-id>' AND embedding_error IS NOT NULL;
```

`src/conversation/retention.db.test.ts` runs the removal block against a
seeded ledger.

### What the console writes

**The console writes the ledger in these places.**

It approves a reply, saves an edited reply, and rewrites one from scratch. It
closes a case with no reply. It puts a case aside for a period, and sends one
back for a new attempt. It publishes a document written from a case. It takes
a case, releases a case, and hands a case to a teammate. It also clears every
lapsed reservation, and undoes an approval inside its hold period.

Every other statement it issues is a SELECT. So it is otherwise as safe
against a live database as `pnpm run bands` and `pnpm run latency`. That
claim is its own, not inherited. `console/src/select-only.test.ts` refuses
any SQL keyword in the package, and a call to `pool.query`. It holds every
write to the one module that makes it.

A console read runs read-only when it goes through `boundedRead`. The reader
modules read that way, among them the run journal, the conversation, the
document and the latency report. Each such read runs in one READ ONLY
transaction, and each statement goes out alone. The helper refuses a statement
that does not start as a read before it sends one. So the database refuses a
write to a table from these readers.

Each such read also discards its session state before the pool takes the
connection back. A console read that does not go through `boundedRead` uses a
plain connection, with no statement timeout and no discard. One of them
writes: the case page's reservation read clears every lapsed reservation.

READ ONLY does not refuse every effect. A function can still act on another
session. A superuser's session can still write to the catalog or create a
replication slot. The readers' role holds none of those rights, so the
database refuses them. "The readers' role" describes it.

Each reader that goes through `boundedRead` sets its own statement timeout.
The latency report uses sixty seconds, and each other one uses two. The
statements of one read share a client deadline one second longer than that timeout. The end
of the read, its commit or rollback and the discard, shares one more deadline
of that length. Each read waits at most three seconds for a pool connection.

A read that outlasts a bound fails, and the console logs the failure with a
tag. A page that cannot draw without the read answers with an error. A page
that can draw without it marks that part as not read. The error page, and each
part marked as not read, names the tag.

### Approving and reading the draft back

Approving in the console calls the same function `pnpm run approve` calls.
So the transaction and the fencing epoch are the same whichever path an
operator used. The command line keeps working.

Edit the draft in the helpdesk, then approve. The relay sends the parked draft
exactly as the helpdesk holds it. So text typed anywhere else is recorded and
never sent.

Where the adapter cannot send the copy it parks, the reviewer edits the reply
on the case. Set `FREESCOUT_INTERNAL_NOTE=true`, as the FreeScout section
describes. The console then draws the editor, the sentences the system drafted
and the callout for a claim the judge refused. The reviewer saves the text, and
the approval sends what the ledger holds. `pnpm run approve` sends the same
text, so the two paths agree.

The ledger then holds the reply, and the helpdesk holds a copy nothing can
send. The approval compares the two. A copy a person edited after the park
refuses, and both texts appear on the case. The reviewer chooses one, and the
choice is a save like any other. Without `--read-back` the command line makes
no comparison and sends the text the ledger holds.

The refusal offers both texts, and a reviewer may choose either one. Choosing
the helpdesk copy saves it as the reply. Choosing the reply the ledger holds
sends it past the copy, and leaves the copy in the helpdesk.

That second choice carries the digest of the copy the page drew. A copy that
changed since refuses again. The command line takes the same decision, with
`--read-back --accept-copy-edit <digest>`. Its refusal prints the digest. A
copy a person cleared holds no text, so the case draws no choice.

The command line prints both texts with each hidden character as an escape.
It also prints each backslash twice, so `C:\files` in a reply appears as
`C:\\files`. The text the relay sends holds one backslash.

The approval reads the copy once, before its transaction opens.
Nothing sees an edit that lands after that read. The relay posts what the outbox
record holds, and a capable adapter declares no read-back at the send (DEC-30).
Treat an edit in that window as lost. When two people work one case, edit the
reply from the console.

On every other adapter the case says a person edits the reply in the
helpdesk. The console offers no editor there. A member of staff who typed there would write
text that never sends. Nobody can recall a sent reply (DEC-12).

The console reads the draft back when `APPROVE_ADAPTER` names `imap-smtp` or
`freescout`. That is the path `pnpm run approve --read-back` takes. The approval
reads the draft the helpdesk holds and records the approval-edit distance
against it. Export the adapter's own variables too, because the console reads no
`.env`. Name the adapter the consumer parks through. The console cannot read a
draft id another adapter minted, so every approval would refuse.

An unset `APPROVE_ADAPTER` reads nothing back, and so does the reference
adapter `helpdesk`. That adapter keeps its drafts in the memory of the process
that parked them. From the console every read would find nothing, so every
approval would refuse. The case says whether an approval reads the draft back.

The console builds the adapter at startup. An unknown name stops the console
before it serves a page. So does a missing adapter variable, and a
`FREESCOUT_BASE_URL` that carries a user name or password.

An approval whose draft is gone refuses as `draft_missing`, and nothing
commits. The case says the parked draft is gone, as the command line does. The
FreeScout adapter reads any 404 as a gone draft. So a `FREESCOUT_BASE_URL` that
points at no API refuses every approval that way.

A read that fails, or that has not answered after four seconds, is not a
missing draft. The case says the console could not read the draft back, and
nothing commits. The log line `console_read_back_failed` names the run, the
draft and the fault. When the console gives up, it tells the adapter to stop,
and the adapter closes the connection it holds. A fault that arrives later
gets its own line, `console_read_back_late_fault`, with the same draft.

One read-back fault never clears, and it has its own sentence. A thread the
helpdesk does not hold as an internal note means two processes read
`FREESCOUT_INTERNAL_NOTE` differently. Set it to the same value for the
console, the relay and the consumer. The approval that reads such a copy
refuses as `read_back_not_a_note`, and the sentence names the setting. Every
approval refuses until the three agree.

The adapter reads one conversation as one body, and refuses a conversation
larger than four million characters. Half a conversation is not a copy a
person can judge. A partial read would compare unequal to the reply, for a
reason that is not an edit. So a case that names such a copy says the read
failed, and the log line carries the size.

Four seconds sits inside the console's five-second shutdown grace. The rest of
the grace is for the approval's own statements. The pool refuses a
transaction that asks for a connection after it closes, and that transaction
commits nothing.

The FreeScout adapter refuses a redirect. Its API key is a header of its own.
Fetch keeps such a header on a redirect to another host. The refusal names the
status and `FREESCOUT_BASE_URL`, and a retry does not repeat it. Set the
variable to the address the helpdesk redirects to.

After an approval the console returns to the case, with the ledger's answer
above it. Only an approval draws in the success color. Every refusal draws in
another, and says nothing was sent.

A link can carry any outcome, so the case checks each against the run. It shows
an approval only on a run that records an approver. It shows a gone draft only
on a run that still waits. When the relay escalated an approved run, the
approval says a person has the run now.

A fault during the approval can come after the commit. Its page says the
approval may or may not have committed, and links the case. The log line
`console_approve_failed` names the run, the claimed approver and where the
request came from.

The console never parks a draft. A draft parks in the helpdesk and nowhere
else (DEC-11, DEC-40).

### Confirming a group, and taking it back (DEC-51)

The queue's clean group carries a checkbox per case and one confirm button.
The button posts the picked cases to a confirmation screen, and that screen
draws every reply in full. Confirming approves each case in turn.

The clean group holds customer replies alone. An internal write parks no reply
and gets no hold period (DEC-34). So it waits in the rest of the queue. A person
approves it on its own case page. The console refuses a batch that names one.

Each send waits `CONSOLE_SEND_HOLD_MS` before the relay may post it. The
default is twelve seconds, and the success panel counts it down on an undo
button. No reply reaches a customer inside the hold period.

The panel says what the ledger holds, and not what the approval asked for. The
panel calls a batch sent only when the ledger shows a send for each record. Otherwise the panel
says how many records the relay has sent, and that the rest wait for their
hold period. A hold period the console cannot read
draws the undo without a countdown.

The console refuses a value above five minutes, and says so at startup. The
bound keeps a mistyped millisecond count from parking replies with nobody
told. The relay skips a record in its hold period and sends it later. A record
with a one-day hold period therefore waits in silence.

The undo removes every effect of the approval, and returns the run to the
waiting queue. It refuses after the hold period ends, or once the relay acts
on the record in any way. It refuses a case that holds no approval too. Each refusal has its
own words, and names why the undo cannot run. One says the relay has already
acted on the reply, sent or not.
Another says the relay may send it at any moment.

A batch and its undo each write one line: `console_confirmed` and
`console_undone`. A case that failed on its own gets its own line,
`console_confirm_case_failed` or `console_undo_case_failed`, naming the run.
A page that cannot read a hold period says so, and logs `console_sendhold_unread`.

A reply on the helpdesk-draft path gets no hold period and no undo. A person can send
that draft from the helpdesk at any moment. So no undo can promise that no
reply goes out.

Set the period to `0` to send at once. The panel then offers no undo, and it
says so rather than drawing a button that cannot work.

## 9. The phase model

DEC-20 gives two phases, and section 5 of the register states each one.
Phase 1 is replay. No ticket reaches a live customer, and you prepare the
taxonomy, the labels and the fitted thresholds. Phase 2 is live with gates:
the system does internal writes automatically, and each customer reply parks
for approval.

In Phase 2 the approval-edit distance is the most useful early signal. It
shows how far each draft is from a reply a person can send.
`pnpm run bands` computes it, with the other band metrics, for one day. Run it
daily. "Control bands" gives the command and the lines it prints when a day
carries no band.

The criteria to leave Phase 2 are undecided. They are open item 1 for V2. Do
not invent exit criteria. Watch the bands and wait for the decision.
`docs/v2-roadmap.md` states what blocks that decision and who owns each part.

## 10. Every command this repository defines

The tables below index the scripts `package.json` defines, so a reader learns
of a command without reading the manifest.

`scripts/check-docs.py` proves two things. Every script this repository
defines appears in this runbook. This runbook names no script the manifest has
dropped. Both fail `pnpm run check:docs`.

No count is written here. A number in prose goes stale when a script is
added. This file already holds the list a reader needs.

The sections above explain the operator commands in full. This is the index,
not the explanation.

**Building and type-checking.**

| Command | What it does |
|---|---|
| `pnpm run bootstrap` | Brings a fresh clone to a state where `pnpm run verify` can run. Idempotent, and it overwrites nothing. `--check` reports and changes nothing, which is the mode the session hook uses. |
| `pnpm run build` | Compiles the core into `dist/` and the console into `console/dist/`. |
| `pnpm run check` | Builds, then type-checks the test files and the console. |
| `pnpm run check:watch` | The same build, recompiled as files change. |

**Testing.**

| Command | What it does |
|---|---|
| `pnpm test` | Runs all three projects: unit, database and mail. |
| `pnpm run test:unit` | The pure cases alone. No Docker. |
| `pnpm run test:db` | The database cases alone. |
| `pnpm run test:mail` | The mail cases alone. |
| `pnpm run test:watch` | Reruns the unit project as files change. |

**Verifying.**

| Command | What it does |
|---|---|
| `pnpm run verify` | The contract. Runs the build, the check, the lint, all tests and the console, then the four `check:` targets below. |
| `pnpm run verify:fast` | The inner loop. No Docker, and it proves nothing about a database suite. |
| `pnpm run verify:db` | The database and mail suites alone. |
| `pnpm run verify:console` | The console package's own build, check and tests. |
| `pnpm run lint` | ESLint over the repository. |
| `pnpm run check:docs` | The documentation claims a machine can decide. |
| `pnpm run check:ste` | Simplified Technical English, rules 1 and 2. |
| `pnpm run check:guards` | The session hooks and the structural eval layer. |
| `pnpm run check:fixtures` | Regenerates the corpus and refuses any difference. |

**The pipeline daemons.** "Running the processes" explains each one. The
console has its own section.

| Command | What it does |
|---|---|
| `pnpm run webhook` | Takes messages in over HTTP. |
| `pnpm run imap` | Takes messages in over IMAP. |
| `pnpm run consumer` | Walks the state machine for its partitions, and returns the cases whose snooze is due (DEC-48). |
| `pnpm run relay` | Drains the outbox to the adapters. |

Each daemon also starts from source with no build step, for a local session:
`pnpm run dev:webhook`, `pnpm run dev:imap`, `pnpm run dev:consumer`,
`pnpm run dev:relay` and `pnpm run dev:console`. They use `tsx`. AGENTS.md
explains why Node's own type stripping cannot run this tree.

**Operator commands.**

| Command | What it does |
|---|---|
| `pnpm run db:migrate` | Applies the SQL files under `db/` in order, and restates the readers' role. |
| `pnpm run escalations` | Lists what needs a person, and why. |
| `pnpm run approve` | Approves or rejects one parked reply. |
| `pnpm run reviewers` | Adds, deactivates and lists the reviewers who may use the console. |
| `pnpm run latency` | Reports queue wait and service time per partition. |
| `pnpm run bands` | Reports the `bands.yaml` metrics for one day. |
| `pnpm run dev:console` | Starts the operator console from source. |

**Offline jobs.** "Offline jobs" and "The real-corpus curation loop" explain
them. None touches live traffic.

| Command | What it does |
|---|---|
| `pnpm run calibrate` | Fits the agreement threshold on the fit half. |
| `pnpm run gold-report` | Reports the gold-set numbers from the report half. |
| `pnpm run triage` | Selects the cases a person should label next. |
| `pnpm run replay` | Scores the first turns of the report half against their observable dispositions. |
| `pnpm run export-corpus` | Writes the corpus a job reads. |
| `pnpm run induce` | Induces a taxonomy from the corpus. |
| `pnpm run load-docs` | Indexes documents for retrieval. |
| `pnpm run fit-groundedness` | Fits the two coverage thresholds. |
| `pnpm run report-groundedness` | Reports coverage against the fitted pair. |
| `pnpm run seed-history` | Writes a backdated synthetic history for a demo. It pins `seed` as the prompt version, so the queue shows which runs it wrote (DEC-18). |
