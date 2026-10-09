---
title: "Amendment proposal: a reviewer console that four people work from"
author: code
tags: [v2, design, amendment, dec-11, dec-38, dec-40, dec-42, console]
created_at: 2026-09-14T00:00:00Z
updated_at: 2026-09-14T00:00:00Z
---

# Amendment proposal: a reviewer console that four people work from

Status: **ratified as DEC-44 to DEC-51 on 2026-09-14.** The rows are in
section 2 of `../v1-architecture.md`, and the register carries the wording that
governs. This document records the reasoning that produced them.

## Verdict

The register must gain eight rows before the reviewer console ships. Three
of them supersede part of four existing rows: DEC-11, DEC-38, DEC-40 and
DEC-42. Five of them cover ground no row covers.

No existing row changes. Each superseded row keeps its text, and the section
for each new row names the part it supersedes.

Each row states what the system does and what it refuses. It does not state
how. The change that ships a row chooses the mechanism, and its own tests
prove it.

## The request

A design handoff specifies the console as a working tool for a small team.
Its overview states the goal in these words:

> This handoff turns it into the primary working tool for **four part-time
> engineers covering many products**.

The handoff lives in the maintainer's checkout and is not tracked. This
document quotes it and does not link it.

The handoff names six system changes. It asks for identity and a reply body
the console owns. It asks for a lock on take, a product dimension and new
review actions. It also asks for knowledge written from inside a case.

## Why new rows, and not edits

The register has never rewritten a decision. DEC-27 still names the ticket
id, and DEC-36 carries the change to the conversation id. DEC-11 kept its
text when DEC-40 arrived.

This proposal follows that precedent. A reader can still see what the
project first chose. Every citation of an old row keeps its meaning.

## Where the register stands

Three rows conflict with the request by name.

| Row | What it says | The conflict |
|---|---|---|
| DEC-11 | The helpdesk shows gated actions in its own draft state | It rejects "a new web queue". A pull queue with reservations is one |
| DEC-40 | Gated actions park in the helpdesk draft state. A read-only operator console may also approve one | The console must record an edited reply, so it is not read-only |
| DEC-42 | The ledger records an approver, and names it unverified | It rejects "an authenticating console". A queue with reservations needs to know each person |

A fourth row binds a need the request implies. DEC-38 derives a key from
the action and the turn. A second attempt on one turn then derives the park
key of the first attempt.

Five needs have no row at all. They are a reservation on a case, a product
and review outcomes beyond approve. The last two are a held send and
knowledge written from a case.

## Facts this proposal rests on

Each fact was read in the code at commit `57a53ff` on 2026-09-14.

1. The relay sends a customer reply by the draft's handle. The FreeScout and
   mail adapters read the draft body at send time. So a helpdesk edit
   reaches the customer.
2. The FreeScout API documentation lists one thread endpoint, and it creates
   a thread. It lists no endpoint that updates or deletes one. So a parked
   FreeScout draft stays sendable after the send. The adapter says its API
   contract has not been observed against a live instance.
3. A run carries one action. The consumer reads one action profile per
   process, so a run is a customer reply or an internal write.
4. The park key derives from the action and the ticket, and from the
   conversation and turn when present. A second run on one turn derives the
   same park key.
5. The fixture helpdesk and the mail adapter find a parked draft by that
   key. A second run on one turn gets the first draft back from them.
6. An approval moves the run to `resolved` and stamps its finish time. It
   records the approver and inserts the outbox row. It records the edit
   distance when a final or read-back body exists. It records the approved
   reply text when the parked reply belongs to a conversation turn.
7. `outbox.idem_key` is unique. A second insert of one key inserts nothing,
   and the run becomes `superseded`.
8. `pnpm run bands` counts pending approvals as runs in `awaiting_approval`.
   `pnpm run latency` counts every state outside its terminal list as
   unfinished, and it counts `superseded` as finished.
9. No ledger table carries a product. Intake reads a helpdesk queue name and
   drops it before the ledger.
10. `document.embedding` is not nullable. The dense retrieval channel reads
    the embedding of every fresh document.
11. A run's fencing epoch is one above the highest its ticket ever had. A
    consumer start also raises the epoch of every ticket in its partitions.
    So a consumer start, or any later run on the same ticket, fences a reply
    already parked there. That reply cannot be approved, and an approved row
    the relay has not sent is marked `fenced` and never retried.
12. `run.approved_by` is one text column. A name a header claimed and a name
    from any other source look the same in it.
13. Retrieval and composition read the message text, not its classification.
    Retrieval skips a document past its review date.
14. The relay sends a row first and marks it `sent` second. A crash between
    the two leaves the row `pending`. If the fence then rises, the next scan
    marks that row `fenced`, although its reply may have reached the customer.

## Before any row ships

Fact 11 is a defect in the code today, not in this proposal. Issue 113
records it. A reply parked for a person must never wait forever. It stays
approvable, or it reaches a state a person sees, with the reason.

Six rows move a parked run: DEC-44, DEC-46, DEC-48, DEC-49, DEC-50 and DEC-51.
DEC-50 does so through the attempt a published document requests. No change
that cites one of them ships before the fix for issue 113. DEC-28 still
refuses a write from a stale owner.

## The proposed rows

| ID | Decision | Rejected alternatives |
|----|----------|----------------------|
| DEC-44 | A reviewer console is the primary place a person reviews a gated action, and it writes on every adapter. Some helpdesks cannot send a parked copy. For their adapters, the ledger holds the approved reply, and every approval path sends it. Other adapters keep the DEC-40 draft path | Edit the helpdesk draft in place; a sendable draft beside the ledger text; two copies that both may send |
| DEC-45 | The console serves nothing to a request with no roster identity, and a trusted proxy authenticates that identity. The ledger records where each approver's name came from | Passwords or sessions the console holds; an unverified header; one shared account; pages open to anyone who reaches the port |
| DEC-46 | Taking a case reserves it for one reviewer, and the reservation lapses. A second reviewer may take it over after confirming. A console outcome on a reply the ledger holds applies only to the case as its reviewer was shown it | No reservation; a reservation that refuses a write; a lease with a lock service |
| DEC-47 | Each run records the product of the channel its message arrived on. A run retrieves the documents of its product and the documents that declare no product | No product; a product the model infers; a product label that retrieval ignores; one product for a whole conversation |
| DEC-48 | A reviewer may close a case with no reply, snooze it or hand it over. A reviewer may rewrite a reply the ledger holds. Each job counts each outcome for what it is | Approve as the only outcome; outcomes that reuse `resolved`; a snooze that looks resolved or counts as service time |
| DEC-49 | A reviewer may send a case back for a new attempt. No helpdesk copy of its reply may exist that a person could send. The attempt is part of every key of its turn | The run id in a key; a digest of the composed body; a new attempt that reuses the old key |
| DEC-50 | A reviewer may write a document from a case with a mapped product. It declares an owner, a review date and at least one product, and it carries no identifier of the case. Retrieval ignores it until it is embedded | The console calls the embedding model; a separate authoring tool; a document with no owner or review date |
| DEC-51 | A console send of a reply the ledger holds waits for a hold period. An undo inside the hold returns the run to approval and removes every effect of the approval | An undo after the send; a delay in the browser; an undo that keeps the outbox row |

Each row below carries its reasoning.

### DEC-44. The ledger holds the reply a person approved

The console becomes the tool a reviewer works in. So the reviewer edits the
reply there. The edit must reach the customer, or the console records text
nobody sent.

Fact 2 removes the obvious path. No FreeScout endpoint updates a draft. A
second draft beside the first leaves a stale copy a person can still send.

So the ledger holds the approved text, and the relay sends that text. The
adapter declares that operation as a capability (DEC-06).

The copy in the helpdesk must not be sendable. Otherwise a person could send
the stale copy after the console sent the real reply. So an adapter declares
the capability only when its helpdesk cannot send the copy it parks.

No shipped adapter meets that today. A FreeScout internal note cannot reach a
customer. So FreeScout declares the capability once a live instance proves
the API accepts one. A mail client can resend a message from any mailbox. So
the mail adapter keeps the DEC-40 draft path, and the console cannot edit its
replies.

For an adapter with the capability, every approval path sends the ledger
text. DEC-40's design kept the command line as the reference approval path,
and added the console as a second. Both remain, so the console is never the
only approval path.

A person may still edit the copy in the helpdesk. An edit made before the
approval is never silently discarded. Every approval path refuses and shows
both texts: the console, and `pnpm run approve`, which prints them. The
reviewer then chooses the text to send.

The text the relay sends still carries the disclosure (DEC-14) and the
provenance metadata (DEC-33). The approval still refuses a reply without
them. A reply a person rewrote from scratch keeps the disclosure the adopter
set. Its provenance records that a person wrote it, and it names no model and
no prompt.

This row supersedes DEC-11 on where a person reviews a gated action. By name,
it also supersedes DEC-11's rejection of "a new web queue". It supersedes
DEC-40's word "read-only" for every adapter, because DEC-45, DEC-46, DEC-48
and DEC-50 write on every adapter. For an adapter with the capability, two
more parts of DEC-40 give way. They are the draft state and the rejection of
"a console that parks its own drafts".

### DEC-45. A reviewer is authenticated, not claimed

A queue with reservations says "you" and "held by a teammate". Each of those
needs a person the system knows. DEC-42 records a claim that any caller can
make.

The console holds no password. A trusted proxy in front of it authenticates
the person, for example with single sign-on. The console looks the identity
up in a roster.

A request with no identity, or with one the roster does not hold, gets no
page and changes nothing. The page it gets says why. The console's pages show
draft text, customer addresses and action payloads. So a read needs an
identity as much as a write does.

The approval records the reviewer from the roster. The command-line approval
still records `unattributed`, because no proxy stands in front of a shell.
Fact 12 shows the ledger cannot tell those sources apart today. So each
approval records the source of its name. The sources are the roster, a header
claim under DEC-42, and no one.

This proposal asked for a development reviewer to be a source of its own. The
maintainer's answer, recorded as issue 106's third acceptance criterion, is
three sources: an approval a development reviewer makes is a name the roster
holds, so it records `roster` like any other. Issue 106 shipped it that way
on 2026-09-18.

A console started from source and bound to its own loopback address may name
a development reviewer with no proxy. A console run from the container image
never does. A deployed host has shell users, and a published loopback port is
open to each of them.

This row supersedes DEC-42 for the console. DEC-42 still governs the
command-line approval. The row grants no authority beyond the review itself.
DEC-12 still puts a person on every customer reply.

### DEC-46. A reservation, not a lock

The queue has no cap, and a selection travels in the address bar. So two
reviewers can read the same case before either acts.

Taking a case reserves it. A second reviewer sees who holds it and for how
long. The reservation lapses after a period of no activity, and an operator
sets the period.

A second reviewer may take a held case over after confirming. A handover
moves the reservation the same way, to the teammate it names. The earlier
holder learns of either move at their next action.

A send or taking another case releases the reservation. A lapse releases it
too, so a reviewer who leaves strands nothing.

The reservation refuses no ledger write. The guard is the case itself. For a
reply the ledger holds, a console outcome applies only to the case as its
reviewer was shown it. When the state or the saved reply changed since then,
the outcome changes nothing and names the change.

A batch confirm is a console outcome, and it covers replies the ledger holds.
It shows each reply in full before it sends, and it refuses a case that
changed since. So a reviewer never approves such a reply unseen.

On the DEC-40 draft path the relay sends the helpdesk body as it stands at
send time. So no guard can promise that text. A draft-path reply is approved
one at a time from its case, and the approval reads the helpdesk body first.

`pnpm run approve` is not a console outcome. It approves by run id, and it
records `unattributed` (DEC-45). It still refuses an edited copy (DEC-44).

Each take, release, handover, send and lapse is recorded with its reviewer
and time. The team view reads time on support from those records.

This is not the lease DEC-27 rejects. That lease guards a partition between
processes. This reservation guards a person's attention between people.

### DEC-47. A product scopes a case and a document

The team covers many products. A reviewer filters by product, and routing
differs by product. Fact 9 shows the ledger has no product.

Intake maps a channel to a product. A channel is a mailbox address, a
webhook queue or a helpdesk mailbox. Each run records the product of the
channel its message arrived on. A follow-up from another channel therefore
carries that channel's product, and so does a ticket moved between queues.

A channel with no mapping records that no product is mapped. A blank value
would read as zero products in a count.

A document may declare one or more products. A run retrieves the documents
of its product and the documents that declare no product. A run with no
mapped product retrieves only the documents that declare no product.

That filter is the safety reason for the row. A refund policy for one product
must not support a claim about another. The groundedness check cannot catch
that error, because the cited text does support the sentence (DEC-07).

A product with a small corpus reaches the reranker's lower limit sooner.
Section 4.6 already accepts that case for a small corpus.

The published numbers do not move. The shipped corpus maps no channel and
declares no product, so every run reads every document as it does today.

### DEC-48. A case ends in more ways than approve

A reviewer needs to close a case, wait for the customer, pass it on and
write the reply again. Each of these must count for what it is. A new state
that a job does not know moves a published number for no behavioural reason.

| Outcome | Run state | Outbox | `bands` | `latency` |
|---|---|---|---|---|
| Close with no reply | `closed`, a terminal state, with a record naming the reviewer and the reason | none | no edit distance, so the run counts as not reached | finished |
| Snooze | `snoozed`, which is not terminal | none | pending, beside `awaiting_approval` | a class of its own for every run that was ever snoozed, so the wait never counts as service time |
| Hand over | unchanged | none | unchanged | unchanged |
| Rewrite a reply the ledger holds | unchanged until the send | the send, as DEC-44 | the edit distance counts, and a full rewrite reads near 1 | unchanged |
| Send back (DEC-49) | the old run ends `superseded` | none for the old run | the turn counts once, from its final attempt, and an attempt a reviewer's note steered counts as assisted | a rejected attempt sits in a class of its own, apart from service time |

A closed case gets its own absence in the conversation view. The existing
labels say the system handled the turn, or that a person approved an action.
Neither is true of a case a person closed.

The reviewer sets the snooze period for each case. A snooze ends in one of
two ways. When its period ends, the run returns to `awaiting_approval`. When
the customer writes again, the snoozed run ends as `superseded`, and the new
turn's run takes the case.

`superseded` is what happened: a newer turn replaced the run. Fact 8 shows
`latency` counts it as finished. So the latency report keeps every run that
was ever snoozed in its own class.

A snoozed run never waits forever, and it never returns to approval once a
newer turn exists.

A rewritten reply has no groundedness verdict, because the composer did not
write it. So no surface and no job reports coverage for that reply. The
run's gate record keeps the verdict of the draft it replaced.

`pnpm run gold-report` reads no ledger, so none of these outcomes moves it.

One outcome in the handoff is absent. It sends a reply and leaves an action
parked for a second person. Fact 3 shows a run carries one action, so there
is nothing to split. The maintainer ruled this out on 2026-09-14.

### DEC-49. A new attempt is a new request

A reviewer may send a case back with a note. A reviewer who publishes the
document a case needed also asks for a new attempt. Either request starts a
new run on the same turn.

Facts 4, 5 and 7 block that today. The new run derives the old park key. An
adapter that finds drafts by key returns the draft the reviewer rejected.

So each turn counts its attempts, and the first run of a turn is attempt 1.
Only a person's request starts a new attempt. The park key and the outbox
key include the attempt.

A crash retry and a redelivered message stay in their attempt. So neither
one returns to the rejected draft's key.

The attempt is action semantics. It describes what a person asked for. It
never derives from the run id, so DEC-24 holds.

A digest of the composed body fails. A crash retry retrieves again. Fact 13
shows a document can pass its review date between the two retrievals. So the
retry can compose different text, and it would then park a second draft.

Starting a new attempt ends the old run as `superseded`. An approval of the
old attempt after that changes nothing.

A new attempt needs a case with no helpdesk copy of its reply that a person
could send. A reply the ledger holds qualifies, and so does a case that
abstained and parked nothing. A draft on the DEC-40 path does not. A person
may already have sent it by hand, and nothing in the system can see that.

A new attempt also needs a turn with no outbox row that may have reached the
customer. Fact 14 shows a `fenced` row may have. So only a row the relay never
tried to send leaves the turn open, and DEC-30 holds. An approved irreversible
write can never be re-run either (DEC-34).

A new attempt that a published document requested starts once that document
is embedded. Until then the case shows that it waits for the document. When
embedding fails, the document shows why, and the attempt does not start.
When the case is approved, closed, snoozed or answered first, the attempt is
dropped, and the case says so.

The reviewer's note reaches the new attempt as an instruction, never as a
retrieved document. So it never counts as coverage (DEC-37).

This row supersedes DEC-38 in part. DEC-38 derives a key from the action
and the turn. This row adds the attempt, so one turn may carry more than one
request.

### DEC-50. Knowledge written where the gap shows

An unsupported claim names the document the system needed. A reviewer who
reads it is best placed to write that document.

The console writes a document. The document declares an owner, a review date
(DEC-23), at least one product (DEC-47) and its author. A
document with no product would support a claim for every product.

A case whose channel maps no product cannot publish a document. Its runs read
only documents that declare no product, so its re-run could never retrieve
one. The console says that the channel must be mapped first.

DEC-22 keeps raw resolved tickets out of the index, for two reasons. They put
personal data in permanent storage, and they keep advice that held one time.
A document written from inside a live case carries both risks. So the row
controls both.

The console refuses a body that carries an identifier the ledger holds for
the case. This check guards one field. It is not the compliance position,
which DEC-19 keeps in documentation. The review date retires advice that held
one time, as DEC-23 does for every document.

No check proves that a body carries no personal data. The identifier check
catches the case's own identifiers and nothing else. So the review date and
the owner stay the main control.

The console calls no model. Both retrieval channels ignore a document until
it is embedded. A document only one channel can rank would skew the fusion
(DEC-21).

The case screen and the knowledge screen count the cases a gap blocked the
same way.

### DEC-51. An undo that is true

A batch confirm sends several replies at once. A reviewer who confirms by
mistake needs a way back. An undo after the send is false, because the
customer already has the reply.

So a console send of a reply the ledger holds waits for a hold period. The
relay sends nothing before the hold ends, and an operator sets the period.

A reply on the DEC-40 draft path gets no hold and no undo. Its helpdesk
draft can be sent by hand at any time, so no undo could promise that nothing
was sent.

An undo inside the hold reverses every effect fact 6 lists. The run returns
to `awaiting_approval`, with no finish time. The approver, the edit distance,
the approved reply text and the outbox row are gone.

A kept outbox row would hold the key. Fact 7 shows a second approval then
inserts nothing and supersedes the run. So nothing of the approval remains.

An undo that reports success guarantees that nothing was sent. An undo that
cannot guarantee it refuses. The relay still sends first and sets the status
second (section 4.4).

A delay in the browser is not a hold. A closed tab drops a send the page
reported as done.

Fact 11 shows the fence can stop a held reply. The run then returns to a
person, with the reason. The ledger drops a reply the relay never tried to
send from the agent's half of the turn (DEC-37). When
the relay may have sent it, fact 14 applies, and the run escalates as
`delivery_unknown` (DEC-30).

## What stays unchanged

| Rule | Row |
|---|---|
| Two independent gates, never one score | DEC-05 |
| An adapter declares what it can do | DEC-06 |
| A customer reply always needs a person | DEC-12 |
| A customer reply always carries a disclosure | DEC-14 |
| Documentation states the compliance position, with no machine check. The identifier check guards one field and states no compliance position | DEC-19 |
| A key comes from action semantics, never the run | DEC-24 |
| The epoch refuses a write from a stale owner | DEC-28 |
| An unknown delivery state escalates | DEC-30 |
| An irreversible write always gates | DEC-34 |
| A console is never the only approval path | DEC-40, in part |
| Coverage counts claims alone | DEC-43 |

## What goes stale

Two kinds of statement go stale, and at different times.

### On ratification

These statements restate the register. The ratifying change corrects each
one.

| File | Location | Statement |
|---|---|---|
| `../v1-architecture.md` | section 2 | The register gains DEC-44 to DEC-51 |
| `../v1-architecture.md`, `../../src/composer/composer.ts` | section 4.7, the module header | "the text a customer reads is the text the gate scored" |
| `../v1-architecture.md` | section 4.9, first paragraph | "Adopters do not install a new interface to receive a draft. That is the purpose of DEC-11", and "a draft parks in the helpdesk and nowhere else" |
| `../v1-architecture.md` | section 4.9, "Who approved it" | "The value is a claim, not an authentication", and "it does not decide who may approve" |
| `../v1-architecture.md` | section 7.1 | The row for this document reads ratified |
| `../architecture-map.md` | the legend row for a reviewer | "they read the draft inside the tool they already use" |
| `../architecture-map.md` | the paragraph on work that waits | "The reviewer opens it in the tool they already use (DEC-11)" |
| `../../README.md` | step 10 of the flow | "Reviewers act inside the helpdesk they already use, so approval adds no new tool" |
| `../../README.md`, `../../CONTRIBUTING.md`, `../../AGENTS.md`, `../quick-map.md`, `../../.claude/skills/decision-tracing/SKILL.md` | the stated range and count | DEC-01 to DEC-43, and 43 decisions |
| `../../AGENTS.md`, `../../REVIEW.md`, `../../evals/manifest.json`, `../operations.md` | "Things agents get wrong", the idempotency check, the key guard, the approval workflow | "Two runs of the same action must produce the same key" |
| `../quick-map.md` | the stated range, and the list of decisions no row names | The decisions the register holds, and those no directory implements |
| `../v2-roadmap.md` | the section on this proposal | This document reads ratified |

An earlier session note, which this tree does not hold, restates DEC-11 as it
stood for epic 21. It records that epic, so it stays as written.

### When the change that alters the behaviour ships

These statements describe what the code does today. They stay true until the
matching change ships, and that change corrects them. Correcting them earlier
makes the runbook describe a system that does not exist.

Two of the DEC-45 rows below shipped on 2026-09-18, with the console's
reviewer roster: the console no longer serves a page to anyone who reaches
it, and the ledger records where each approver's name came from. The third
row, the deployed development stack publishing a console with no proxy in
front of it, stands.

| Statement | Where | Row that changes it |
|---|---|---|
| The console authenticates nobody, and anyone who reaches it reads every page | `../operations.md` sections 1.1 and 7.0, `../../AGENTS.md`, `../../docker-compose.dev.yml`, `console/src/server.ts`, `console/src/ledger-name.ts` | DEC-45 |
| The approver comes from a header an operator names, and nothing records its source | `../operations.md`, `../v1-architecture.md` section 4.9, `../../.env.example`, `console/src/hosts.ts`, `src/approval/approve.ts`, the column comment in `db/016_run_approved_by.sql` | DEC-45 |
| The deployed development stack publishes a console with no proxy in front | `../../docker-compose.dev.yml`, `../../.github/workflows/release.yml` | DEC-45 |
| Edit the draft in the helpdesk; the console captures no reply text | `../operations.md` section 7.0, `console/src/approve.ts`, `console/src/surfaces.ts` | DEC-44 |
| Reviewers act in the helpdesk or the Drafts mailbox they already use | `../operations.md` section 4, `src/adapters/helpdesk.ts` | DEC-44 |
| Each customer reply goes to the draft state | `../v1-architecture.md` section 5 | DEC-44 |
| The relay sends the helpdesk copy | `../operations.md`, `src/relay/relay.ts`, `src/adapters/freescout.ts`, `src/adapters/imap-smtp.ts`, `src/adapters/types.ts`, `src/journal/query.ts` | DEC-44 |
| A parked reply reaches a person through the adapter | `../architecture-map.md`, `../../scripts/check-docs.py` (the flow-edge check), `console-canvas/canvas.json` | DEC-44 |
| Adopters keep their own helpdesk UI, and a draft never parks anywhere else | `src/approval/bridge.ts` | DEC-44 |
| A draft parks in the helpdesk and nowhere else, and adopters install no new interface | `src/approval/approve.ts`, `console/src/approve.ts` | DEC-44 |
| A body supplied to an approval is recorded and never sent | `src/approval/approve.ts` | DEC-44 |
| A missing parked draft is the reason an approval refuses | `src/approval/approve.ts`, `src/approval/cli.ts`, `src/escalations/query.ts`, `src/adapters/types.ts`, `console/src/surfaces.ts` | DEC-44 |
| A draft state is necessary for DEC-11 | `src/domain/capabilities.ts` | DEC-44 |
| The console draws every uncited sentence as uncited | `../v1-architecture.md` section 4.7 | DEC-44, DEC-48 |
| The console makes one write | `../operations.md` section 7.0, `console/src/server.ts`, `console/src/main.ts`, `console/src/surfaces.ts`, `console/src/approve.ts`, `console/src/script.ts`, `console/vitest.config.ts`, `console/src/select-only.test.ts`, `src/public/ledger-read.ts` | DEC-44, DEC-45, DEC-46, DEC-48, DEC-50, DEC-51 |
| What the ledger stores about a customer omits saved edits, close reasons, reviewer notes and review records | `../../README.md`, `../operations.md` | DEC-44, DEC-46, DEC-48, DEC-49 |
| No product exists, and intake drops the queue name | `src/intake/adapter.ts`, `src/adapters/types.ts`, `src/retriever/retriever.ts`, `src/kb/loader.ts` | DEC-47 |
| The quick map's directory rows name only today's decisions | `../quick-map.md`, each directory row whose code a row of this table names | DEC-44 to DEC-51 |
| A run ends only as resolved, escalated, superseded or abandoned | `../v1-architecture.md` section 4.3, `../../AGENTS.md`, `src/coordinator/coordinator.ts`, `src/coordinator/types.ts`, `src/ledger/insert.ts`, `src/escalations/query.ts`, `src/latency/query.ts`, `src/bands/query.ts`, `src/conversation/query.ts`, `console/src/surfaces.ts` | DEC-48 |
| A turn shows no reply for one of six reasons | `../operations.md`, `src/conversation/query.ts` | DEC-48 |
| A new message never ends an earlier run of its conversation | `src/coordinator/intake.ts` | DEC-48 |
| A superseded run means another action already holds its key | `console/src/surfaces.ts` | DEC-48, DEC-49 |
| A retry of one turn derives one key, and no reject path exists. A digest of the body would separate attempts | `src/ledger/keys.ts`, `src/coordinator/steps/park.ts`, `src/coordinator/intake.ts`, `src/approval/approve.ts` | DEC-49 |
| Every document carries an embedding | `db/002_documents.sql`, `src/retriever/retriever.ts` | DEC-50 |
| The ledger stores no customer text in the document table | `../operations.md`, "What the ledger stores about a customer" | DEC-50 |
| A terminal state never changes again | `src/ledger/insert.ts`, `src/latency/query.ts`, `src/approval/approve.ts` | DEC-51 |
| The relay reads every pending row, and a fenced row ends in silence | `../v1-architecture.md` section 4.4, `src/relay/relay.ts`, `db/006_ledger_constraints.sql` | DEC-51 |

## Traceability

| Concern | Rows |
|---|---|
| Where a person reviews a gated action | DEC-44, superseding part of DEC-11 and DEC-40, with DEC-06, DEC-14 and DEC-33 |
| Who the approver is, and who may read the console | DEC-45, superseding DEC-42 for the console |
| Two reviewers on one case | DEC-46, with DEC-28 and DEC-40 |
| Which documents a run may cite | DEC-47, with DEC-07, DEC-21 and DEC-23 |
| How a case ends | DEC-48, with DEC-12, DEC-35 and DEC-38 |
| A second attempt on one turn | DEC-49, superseding part of DEC-38, with DEC-24, DEC-30, DEC-34 and DEC-37 |
| A document a reviewer writes | DEC-50, with DEC-19, DEC-21, DEC-22 and DEC-23 |
| Taking a send back | DEC-51, with DEC-24, DEC-28, DEC-30 and DEC-37 |
| Synthetic data only in this repository | DEC-18 |

## Rejected alternatives

- **Keep the helpdesk as the review tool.** DEC-11 stays untouched. A
  part-time reviewer then works in two tools per case. The helpdesk cannot
  show the two gates or the evidence.
- **Ship the console and record the tension.** The repository then carries a
  documented contradiction. CONTRIBUTING says to stop and raise a conflict
  before code.
- **One row for the whole console.** Eight concerns under one number make
  every citation vague. A later change to one concern would reopen all eight.
- **A run that carries a reply and an action.** The handoff assumes one. It
  needs changes to the coordinator, the composer, the policy engine and the
  approval. The maintainer ruled it out of this work.

## Open items

The maintainer decides the wording of each row. No code that needs one of
these rows lands before that row exists. No change that cites a row which
moves a parked run lands before issue 113 is fixed.

The maintainer ruled on 2026-09-14 on seventeen questions, over two reviews.
Eight came from the third review, and nine from the fourth. The rows above
carry each ruling.
