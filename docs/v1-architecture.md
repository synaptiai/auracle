# Agentic Support System. V1 Foundational Architecture

Reference architecture for support automation with evidence gates.
TypeScript. Postgres. No orchestration framework.

---

## 1. Scope

This document specifies each component that processes a support request. The
flow starts at the inbound message. The flow stops at one of two results. The
first result is an internal write that the system does automatically. The second
result is a reply to the customer that a person approves.

### 1.1 In V1

- Intake.
- Classification.
- Retrieval.
- Composition of the answer.
- Two evidence gates.
- Policy evaluation.
- Internal writes.
- Approval of customer replies.
- Replay evaluation.
- Induction of the taxonomy.
- Calibration of the threshold.

### 1.2 Not in V1

- Replies to customers that the system sends automatically.
- Automatic clusters of feedback.
- A different threshold for each intent.
- Online A/B tests.

### 1.3 The contracts are the deliverable

Adopters replace the prompts quickly. The port interfaces, the ledger schema and
the gate rules must be correct. These parts are the deliverable.

---

## 2. Decision register

Each component refers to the decisions that it obeys. The decisions are the only
authority in this document. If you cannot trace a statement to a decision, the
statement is an implementation detail. You can change it.

| ID | Decision | Rejected alternatives |
|----|----------|----------------------|
| DEC-01 | Open source reference. Synapti internal tools are the test bed | Own venture first; client product |
| DEC-02 | Start from raw ticket history that has no tags | Assume a corpus with tags; start with no data |
| DEC-03 | The autonomy limit is a write that you can reverse | Read only; writes that include billing |
| DEC-04 | A Postgres ledger and a transactional outbox | DBOS; Temporal; LangGraph checkpointer |
| DEC-05 | Two independent gates: sample agreement and coverage | One mixed confidence score |
| DEC-06 | Each adapter declares its capability. Autonomy decreases to agree | A shim that removes duplicates; refuse the adapter |
| DEC-07 | The composer must cite or abstain. A check tests each claim | A threshold on the retrieval score |
| DEC-08 | TypeScript core | Python core; Go core |
| DEC-09 | Replay scores: action match, human sample, judge triage | The judge gives the primary score |
| DEC-10 | Clusters give the taxonomy. A person curates it to 25 intents | An imposed taxonomy; open codes |
| DEC-11 | The helpdesk shows gated actions in its own draft state | A Slack queue; a new web queue |
| DEC-12 | Internal writes are automatic. Customer replies need approval | All reversible writes are automatic |
| DEC-13 | Below the labelled-case trigger, one global threshold. A person sets the risk tier for each intent, at every corpus size | A threshold the system learns below the trigger; a risk tier the system learns at any size |
| DEC-14 | The disclosure field is mandatory on each customer reply | A configuration flag; documentation only |
| DEC-15 | Do not remove personal data in the runtime path. Use a DPA | Remove personal data everywhere |
| DEC-16 | OpenRouter supplies the models | Vercel AI SDK; one provider only |
| DEC-17 | The data guarantee is configurable and documented | Force zero data retention on each request |
| DEC-18 | The public repository contains synthetic fixtures only | A cleared subset of real tickets |
| DEC-19 | Documentation states the compliance position. No machine check | A configuration that refuses real data |
| DEC-20 | Cold start: replay the history, then go live with gates | A separate shadow phase |
| DEC-21 | Hybrid BM25 and dense retrieval with RRF. The reranker is on | Dense retrieval only |
| DEC-22 | Index the documents and the canonical resolutions | Documents only; raw resolved tickets |
| DEC-23 | Each document declares an owner and a review date | Weight by date only; no freshness model |
| DEC-24 | A semantic idempotency key for each action | The key alone; the lease alone |
| DEC-25 | Limit the cost, the steps and the clock time | A step limit only; no limits |
| DEC-26 | Pin the prompt version and the model version | Record the versions only |
| DEC-27 | Partition the queue by `ticket_id`. One consumer for each partition | A lease with a lock service |
| DEC-28 | A fencing epoch that increases. Check it at insert and at send | Adjust the lease time limit |
| DEC-29 | Each action class declares its delivery rule | One global at-least-once rule |
| DEC-30 | If the delivery state is unknown, escalate. Do not retry | Retry blind; abandon blind |
| DEC-31 | A gold set split in two. Fit on one half. Report the other half | One undivided set with a caveat |
| DEC-32 | Action match scores the disposition, not the intent label | Silver labels from the induction job |
| DEC-33 | Add provenance metadata to each generated text | The disclosure text alone |
| DEC-34 | A write that the system cannot reverse always gates. A gated write with no customer draft parks in the ledger | Gate by risk tier; park it as a helpdesk draft |
| DEC-35 | A conversation is a ledger entity. Runs reference it. No component holds conversation state outside the ledger | An in-memory session cache; adapter-side threads only |
| DEC-36 | The partition key is the conversation id. A V1-era run and a replay run keep the ticket id | Cross-partition locks; one global conversation queue |
| DEC-37 | Conversation history enters the classifier and composer prompts. The gates read retrieved documents alone | History in the composer only; history as retrieved documents |
| DEC-38 | The idempotency key derives from action semantics plus the turn that requests the action | The conversation id alone; the run id, which DEC-24 forbids |
| DEC-39 | Replay scores first turns only. Multi-turn quality uses online metrics and a human-labelled cohort | Simulated customers; a judge scoring later turns |
| DEC-40 | Gated actions park in the helpdesk draft state. A read-only operator console may also approve one | A console that parks its own drafts; a console that is the only approval path |
| DEC-41 | Above the labelled-case trigger the system fits a threshold for each intent. Each case records what labelled it, and the artifact records the count and the accuracy of each kind | One global threshold above the trigger; per-intent thresholds with no record of what labelled the cases |
| DEC-42 | The ledger records an approver, and names it unverified. A trusted proxy supplies the identity. Without one the approval records `unattributed` | An authenticating console; no record of who approved; a header trusted on any bind |

---

## 3. What the evidence showed

Six results changed the design. The architecture is not clear without them.

### 3.1 A model cannot report its own confidence

If you ask a model for a confidence value, the value collects at 0.9 and 1.0.
You cannot set a threshold on such a value.

Agreement between samples does agree with correctness. A self-report does not. DEC-05 exists because of this result.
The classifier samples. It does not ask.

### 3.2 Agreement cannot find a confident error

A simulation used 20 000 tickets for each condition. Agreement is useful when
the errors go to one adjacent intent. The precision increases by 0.125 at
p=0.70. Agreement is almost useless when a majority vote already corrects the
error. The precision increases by 0.003, and the system abstains on 56 percent
of the tickets.

If the model is wrong on a ticket in the same way each time, all samples agree.
The samples agree on the wrong answer. No number of samples finds this error.
This result is the reason for a second and independent gate.

### 3.3 A threshold for each intent is not possible below the trigger

One global threshold needs 385 labelled tickets for an interval of 5 percent.
A threshold for each of 25 intents needs approximately 2 400 tickets. Intent
frequencies obey a Zipf distribution. Therefore the intent at rank 20 needs a
corpus of approximately 7 700 tickets. DEC-13 exists because of this result.

Above that corpus size the result no longer holds, and DEC-41 governs. DEC-13
keeps the risk tier, which no corpus size changes.

### 3.4 A correct idempotency key is not a concurrency design

A key that you make from the action data has a limit. Two concurrent runs
collide at the insert, and one run loses. If the run that loses continues to the
`queued` state, it waits for a result that no component supplies.

The key also gives no protection when the two runs make different data. A refund
of 50 and a refund of 100 give different keys. The unique constraint does not
operate.

A lease with no fencing token does not close this gap. A process can stop for a
long time. The lease expires. A second process gets the lease. The first process
starts again and writes. No time limit prevents this failure.

DEC-27 and DEC-28 exist because of these results.

### 3.5 The delivery rule belongs to the action

One global at-least-once rule is not sufficient. A retry of a refund to a system
with no idempotency support can pay the customer two times. An abandoned
ticket-close leaves an old ticket only. The safer rule changes with the action.
DEC-29 and DEC-30 exist because of this result.

### 3.6 Set the containment target low

Vendors advertise 67 to 86 percent resolution. Production reports show 42 to 50
percent. One independent test of 500 tickets gave 38 percent. B2B systems give
17 to 25 points less than the vendor numbers.

Plan for 35 to 45 percent in V1.
Measure resolution. Do not measure deflection.

---

## 4. Components

### 4.1 Ingress

**`IngressAdapter`** (port). Obeys DEC-06, DEC-01.

The adapter changes each inbound event into a `Ticket` and a `Message`. Each
adapter declares its capabilities.

```ts
interface AdapterCapabilities {
  supportsIdempotencyKey: boolean;   // controls automatic writes
  supportsReadBack:       boolean;   // lets the relay reconcile
  supportsDraftState:     boolean;   // necessary for DEC-11
  supportsStructuredFields: boolean; // necessary for bug records
  supportsThreading:      boolean;
}
```

The policy engine reads these capabilities. If `supportsIdempotencyKey` is
false, all write actions go to the approval path. The risk tier does not change
this. The intent does not change this. Autonomy decreases to agree with the guarantee that the target system gives.

 The system declares this decrease. An
operator does not find it in production.

Supply three reference adapters: IMAP and SMTP, a webhook, and one
helpdesk. Three adapters are sufficient to show that the contract is general.
The helpdesk adapter is fixture-backed. It holds its state in memory and
reaches no network, so the repository ships no credentials (DEC-18).

### 4.2 Ledger

**`ledger`** (Postgres). Obeys DEC-04, DEC-24, DEC-26, DEC-27, DEC-28.

The ledger holds all state. No component keeps state outside the ledger.

```sql
CREATE TABLE run (
  run_id       uuid PRIMARY KEY,
  ticket_id    text    NOT NULL,
  partition    integer NOT NULL,   -- DEC-36: hash(conversation_id) % N
  epoch        bigint  NOT NULL,   -- DEC-28: fencing token
  state        text    NOT NULL,
  prompt_ver   text    NOT NULL,
  model_ver    text    NOT NULL,
  cost_micros  integer NOT NULL DEFAULT 0,
  steps_used   integer NOT NULL DEFAULT 0,
  deadline_at  timestamptz NOT NULL
);

CREATE TABLE ticket_epoch (          -- the highest epoch that was accepted
  ticket_id    text PRIMARY KEY,
  epoch        bigint NOT NULL
);

CREATE TABLE step_journal (
  run_id uuid, step_id text, status text, result jsonb,
  prompt_ver text, model_ver text, cost_micros integer,
  PRIMARY KEY (run_id, step_id)
);

CREATE TABLE outbox (
  run_id       uuid, step_id text,
  idem_key     text   NOT NULL,
  epoch        bigint NOT NULL,
  action_class text   NOT NULL,     -- DEC-29: selects the delivery rule
  delivery     text   NOT NULL,     -- 'at_least_once' | 'at_most_once'
  payload      jsonb  NOT NULL,
  status       text   NOT NULL DEFAULT 'pending',
  PRIMARY KEY (run_id, step_id),
  UNIQUE (idem_key)
);
```

**Partitions.** The system removes the concurrency. It does not control the
concurrency. `hash(conversation_id)` gives the partition, and the ticket id
serves when a run has no conversation. One consumer owns each partition, so
two runs on one conversation cannot occur together.

Two runs on one ticket still can, when one of them carries no conversation and
hashes elsewhere. The fencing epoch below covers that case, because it is
keyed on the ticket. The cost is a procedure to rebalance the partitions at
each deployment.

**The fencing epoch.**

During a rebalance, two consumers can own one partition for a short time. Each
write carries its epoch. The `ticket_epoch` table records the highest epoch.
The ledger refuses each write that has a lower epoch. The ledger does the
refusal and the write in one operation. This is the only design that is safe
when a process stops for an unknown time.

**Liveness.** A run that does not insert its outbox record must not go to the
`queued` state. It must go to the `superseded` state and stop. If both runs go
to `queued`, the run that lost waits without a limit.

The implementation must obey two rules:

1. Commit the state change and the outbox insert in one transaction.
2. Treat an insert of zero records as a different result. Do not ignore it.

### 4.3 Run coordinator

**`coordinator`**. Obeys DEC-04, DEC-25, DEC-27, DEC-28.

The coordinator is a state machine. It has no framework, no agent loop and no
control flow from the model.

```
received -> classified -> retrieved -> composed -> gated
  -> executing          (automatic path, internal writes only)
  -> awaiting_approval  (customer replies, DEC-12)
  -> resolved | escalated | superseded | abandoned
```

The coordinator does these tasks:

1. Read the next ticket from its partition.
2. Move the run forward by one state.
3. Write each step to the journal before it acts.
4. Add the fencing epoch to each write.
5. Apply the limits on cost, steps and clock time.

There is no lease. The partition gives exclusive access in normal operation. The
fencing epoch gives safety during a rebalance.

**Limits.** DEC-25 sets a limit on the cost, on the number of steps and on
the clock time. The ledger holds cost in micro-dollars, which are millionths
of a US dollar. A model call costs a fraction of a cent.
Cents rounded almost every call to zero.
The limit then compared a sum of zeros.

If the run reaches a limit, this is not an error. The run
goes to `escalated` and keeps its partial work. A high cost then becomes visible
in operations. It does not become a surprise in the invoice.

### 4.4 Outbox relay

**`relay`**. Obeys DEC-04, DEC-06, DEC-28, DEC-29, DEC-30.

The relay is a different process. It reads the records in the outbox that have
the `pending` status. It calls the adapter with the `idem_key` and the `epoch`.
Then it sets the status to `sent`.

Send first. Set the status second. Do not set the status first.

The relay reads the delivery rule from the record. It does not read a global
setting.

| Adapter idempotency | Duplicate costs more | Loss costs more |
|---|---|---|
| Supported | at-least-once. Retry | at-least-once. Retry |
| Not supported | **at-most-once**. Escalate | at-least-once. Retry |

If the adapter has no idempotency support and the relay cannot find the delivery
state, the relay must not retry. It sets the record to `delivery_unknown`. It
sends the record to the approval queue and states the uncertainty. A retry can
pay a second refund. A silent abandon can leave a customer with no answer.
Escalation is the only action that does not select a failure for the operator.

If the adapter has read-back support, the relay reads the target system. Then it
reconciles. It does not escalate.

**The approval path does not solve duplicate delivery.** It prevents an
automatic and incorrect action. The relay still sends through the same adapter
after the approval. The relay can still stop during the send. These are two
different problems.

### 4.5 Classifier

**`classifier`**. Obeys DEC-05, DEC-10, DEC-13.

The classifier samples the labels 9 times at a temperature above zero. It gives
the most frequent intent and the agreement fraction.

```ts
const CLASSIFIER_K   = 9;
const GATE_AGREEMENT = 0.6;   // the seed value. Calibrate it per DEC-13
```

The simulation gives this guidance. At k=9 and a threshold of 0.6, the precision is 0.985.
74 percent of the tickets pass. At k=5 and a threshold of 0.8, the
precision is 0.970 and 54 percent pass. More samples with a lower threshold is
better on both measurements.

**WARNING: Set the temperature above zero.**
**At a temperature of zero, all samples are the same. The agreement is always**
**1.0. The gate then passes each ticket and reports full confidence. Make this**
**an assertion in the code. Do not make it a comment.**

**Cost.** The classifier is not inexpensive against the answer step. A taxonomy of 1 200 tokens goes into the prompt nine times.
That makes the classifier 2.5 times the cost of the answer step. The classifier is 57 percent of the model cost for each ticket.

A prompt cache decreases the cost to approximately the cost of the answer step.
The cache does not decrease it below that cost. At test-bed volume the cache
does not operate. A cache with a time limit of 5 minutes needs more than
approximately 12 tickets each hour.

Accept the cost. The model cost for each ticket is approximately 0.08 USD. A
person costs 10 to 100 times more.

If the cost becomes a problem later, use a cascade of two stages. An embedding
classifier does the easy tickets. The 9 samples operate on the unclear tickets
only. This is a different component. It is not in V1.

### 4.6 Retriever

**`retriever`**. Obeys DEC-21, DEC-22, DEC-23.

The retriever uses two methods. Postgres supplies both. BM25 uses `tsvector`.
Dense retrieval uses `pgvector`. Reciprocal Rank Fusion mixes the two result
sets.

RRF uses the ranks. It does not use the scores. BM25 scores have no upper limit.
Cosine values do have a limit. Therefore a weighted average of the scores is not
stable.

BM25 is more important here than in the general case. Support tickets contain
many error codes, part numbers and account numbers. Dense retrieval is weak on
these tokens. BM25 is also more useful on a small corpus.

**The reranker.**

DEC-21 makes the reranker active. It gives the largest single increase in
quality, approximately 17 points of MRR@3. The reranker needs a minimum of 50
candidates. At 20 candidates it is worse than no reranker. On a small corpus,
50 candidates can be a large part of the corpus. This is acceptable and
inexpensive.

**Freshness.** Each indexed document declares an `owner` and a `review_by` date.
The system removes each document that is out of date from the automatic path.
The document stays available for an answer that a person approves. The abstain
signal then reports the documents that need a review. This report costs nothing
more.

**Index contents.** Index the documents and the canonical resolutions that a
person approved. Do not index the raw resolved tickets. Raw tickets put personal
data in permanent storage. Raw tickets also keep advice that was correct one
time only.

### 4.7 Composer and groundedness check

**`composer`**. Obeys DEC-07.

Each claim must have a citation to a retrieved text span. If the composer cannot
cite a claim, the composer must abstain. An abstain result is a correct output.
It is not a failure. It is also the least expensive way to find a gap in the
knowledge.

**`groundedness`**. Obeys DEC-07.

This component tests each claim against the retrieved text. If a claim adds
information that the text does not contain, the response is not grounded.

The claims come from the composer. The composer already proved that each one
cites a retrieved span, so it owns the claim boundaries. This component does
not derive them again.

An earlier build split the draft with a second model call. That made the
denominator of the fraction a model's choice. A split that returned one line
scored 1.0 and passed both thresholds. The composer's partition removes that
failure and costs one model call less.

Use two thresholds, a block and a review:

| Value | Action |
|---|---|
| Below the review threshold | Send to a person for review |
| Below the block threshold | Block. Do not send |

The seeds are 0.80 and 0.70. They are seeds and not the operative pair. `pnpm
run fit-groundedness` fits the pair on the fit half, and a process holding a
coverage artifact runs the fitted values. It says which it took at startup. So
a seeded run and a fitted run are never confused.

The two thresholds decide the automatic path only. A customer reply is
gated by DEC-12 before the policy engine reads either one.

This component is the second gate. It is independent of the first gate by
design. It is the only defence against a confident error, because agreement
cannot find a confident error. See paragraph 3.2.

### 4.8 Policy engine

**`policy`**. Obeys DEC-03, DEC-06, DEC-12, DEC-13, DEC-30.

This component is a pure function. It does not call a model.

Inputs: the risk tier of the intent, the agreement value, the groundedness
value, the adapter capabilities and the action class.
Output: `auto`, `gated` or `escalate`.

```
if (!capabilities.supportsIdempotencyKey && action.isWrite) return 'gated';
if (!capabilities.supportsReadBack && action.isWrite)       return 'gated';
if (action.isCustomerVisible)                                return 'gated';
if (action.isWrite && action.isIrreversible)                 return 'gated';
if (intent.riskTier === 'high')                              return 'gated';
if (agreement    < thresholds.agreement)                     return 'escalate';
if (groundedness < thresholds.groundednessBlock)             return 'escalate';
if (groundedness < thresholds.groundednessReview)            return 'gated';
return 'auto';
```

An automatic write needs two capability guarantees, and the engine reads both.
An idempotency key makes a retry safe. Read-back makes the result knowable.

Without read-back the relay escalates a failed send instead of retrying it.
See DEC-30. So autonomy decreases for that adapter as well. See DEC-06.

A person sets the risk tier for each intent. The system does not learn the tier.
See DEC-13. A high-risk intent never goes to the automatic path. The gate values
do not change this. Confidence measures the accuracy of the classification.

It does not measure the cost of an error. These are different quantities.

### 4.9 Approval bridge

**`approval`**. Obeys DEC-11, DEC-14, DEC-24, DEC-33, DEC-40.

The bridge writes each gated customer reply into the draft state of the adapter.
A gated write with no customer draft parks in the ledger alone (DEC-34).
It makes no adapter call, so no unsent draft is left behind after approval.
Adopters do not install a new interface to receive a draft. That is the
purpose of DEC-11, and DEC-40 keeps it: a draft parks in the helpdesk and
nowhere else. DEC-40 permits an operator console to approve one as well.

Each customer reply must have three items:

1. A `disclosure` field that is not empty.
2. Provenance metadata that a machine can read.
3. An idempotency key for the park, derived under DEC-24.

The bridge refuses to send a reply that does not have all three items.

**Who approved it.** Obeys DEC-42.

The ledger records that a person approved a reply. It did not record which
person. Reaching the console is the whole access control. So an incident could
not separate the operator from anyone else who reached the port.

The approval records an approver. The value is a claim, not an authentication.
A caller supplies it. The approval bounds what it keeps. A value that is too
long, or that carries a control character, names nobody.

An approval that names nobody records `unattributed`. That is a recorded fact
and not a missing row. A null in the column means no approval reached the run.

Only a trusted proxy may name an approver. Anyone reaching a console can set a
header. So a console reads one only where the operator names its proxy. Until
a caller does that, every approval records `unattributed`.

This grants no authority. It changes no gate, and it does not decide who may
approve. DEC-12 still puts a person on every customer reply. DEC-40 still
permits the console to be that person's interface.

**Why the park needs a key.**

The adapter creates the draft before the ledger can record its handle. A crash
between the two used to leave a draft that no row named. The next run then
parked a second one. The customer then saw two replies. The key travels with
the reply, so the adapter recognises the repeat and returns the first draft.
The mail adapter carries the key in a header, because a mailbox gives an
appended message no other stable handle.

**Two different obligations.** EU AI Act Article 50(1) applies now.
Article 50(2) applies from 2 December 2026. The grace period of four months
applies to systems that were on the market before 2 August 2026. This system was
not.

**CAUTION: The marking method for text is not certain.**

**C2PA covers images, audio and video. Text has no equivalent standard.** **V1
adds provenance as structured metadata on the message record. It also adds**
**the metadata to adapter headers where the adapter permits this. This
document** **cannot decide if the method satisfies Article 50(2). Get legal
advice before** **you go live.**

### 4.10 Evaluation

**`replay`**. Obeys DEC-09, DEC-20, DEC-26, DEC-31, DEC-32.

Three methods score a run. Each method has a different task.

**Method 1. Action match.** This method operates on the full history. It scores
the routing decision against the disposition that you can observe. It does not
score against an intent label.

A disposition is a result of the work. Untagged history contains dispositions.
Examples of a disposition:

- The queue that received the ticket.
- An escalation.
- A macro that operated.
- A refund.
- The time to the first human reply.

Do not score against an intent label. DEC-02 states that the history has no
tags. Intent labels come from the induction job. The induction job is the
component under test. Dispositions need no labels.

They are independent of the taxonomy. Therefore a full-corpus signal is
possible.

Limit: action match scores the routing only. It cannot show if a reply was good.
It is sufficient to control merges. It is not sufficient to publish.

**Method 2. Human review.**

This method gives the numbers for the README. The gold set is split in two. Fit
the thresholds on one half. Report each published number from the other half.
See DEC-31.

DEC-31 governs the split, not the size. The maintainer ruled the size an
implementation detail of it, so a corpus may grow and the discipline still
holds. The set held 770 cases, then 2124, and now holds 8200. The first growth
answered a precision floor read against an interval. 0.985 asks for 253 drafts
above the review threshold, and 770 cases offered 172. So the corpus could
never fit the gate it exists to fit.

The second answers the labelled-case trigger of DEC-41, which section 3.3 puts
near 7 700.

Do not use one set of cases for both tasks. That method is selection on the test
data. A simulation of 2 000 trials shows the effect. If you select the best of 13
thresholds on 385 cases, the reported precision increases by approximately
2.5 points. That simulation ran at the earlier half size. The effect shrinks as
a half grows, and the split removes it at any size.

The cost is a wider interval than an undivided set gives. At the current half
size that cost is approximately 1.8 points at p=0.9.

The strata need care. DEC-39 scores first turns only, so the report half of
4100 cases yields 3074 scored cases. The low tier holds 1834 of them, the
medium tier 1063 and the high tier 177.

The Zipf shape put the high-risk intents in the tail, so that tier is now the
thin one. Containment there runs 2.1 points wide and the other two tiers under
half a point. Widths here are full widths, lower bound to upper bound.

Read those widths with the rates beside them. The low and medium tiers contain
every case and the high tier contains none. Each containment rate therefore
sits on a boundary, where a Wilson interval is narrow. A narrow interval here
reports no spread, not a precise measurement.

Action match sits away from those boundaries, and its intervals are wide. The
high tier reads 0.458 over 177 cases, across 14.5 points. The medium tier runs
4.9 points wide and the low tier 2.1. That is the widest spread the artifact
carries, and no boundary explains it away.

Treat the strata as an indication only and read the counts from the artifact,
not from this paragraph.

**Method 3. Judge triage.** A model selects the cases that go to a person. It
does not give the published number. A judge has the same failures as the system
that it tests. Therefore it is weakest where the evaluation is most important.

**What replay cannot do.** Replay scores decisions against a history that the
system did not change. If an agent gives a different answer, the conversation
takes a different path. The historical record is then not a valid comparison.
Replay is correct for routing. Replay is not correct for a conversation with
more than one turn.

Use approval-edit distance as the online measurement. This value shows how much
a person changed a draft before the person sent it. It is available from the
first day of Phase 2. It needs no labels. It has no counterfactual problem.

`pnpm run bands` reads it from the ledger, with the other three metrics
`bands.yaml` defines. It reports one UTC day against the 30 most recent
measured days before it. The baseline excludes the day it judges. A window too
thin or too flat to carry a band says so instead of stating one.

**Sensitivity.** To find a change of 5 percent in containment you need
approximately 470 cases. To find a change of 2 percent you need approximately
3 000 cases. Test-bed volume cannot supply these numbers online.

The public repository contains synthetic fixtures only. See DEC-18.

### 4.11 Offline jobs

**`taxonomy-induction`**. Obeys DEC-02, DEC-10.

1. Make embeddings for the history.
2. Make clusters.
3. Let a model give a name to each cluster.
4. Let a person curate the list to a maximum of 25 intents.
5. Keep an `other` group and examine it.

The limit of 25 comes from the Zipf result in paragraph 3.3. Above 25 intents,
the rare intents never collect sufficient examples. More intents give an
appearance of accuracy and nothing more.

**`calibration`**. Obeys DEC-13, DEC-31, DEC-41.

This job fits the agreement threshold on the fit half of the gold set. It
operates each month. It does not operate for each ticket.

Below the labelled-case trigger the job fits one global threshold. At or above
it, the job fits a threshold for each intent that clears the data floor
(DEC-41). An intent below that floor keeps the global threshold.

**`bands`**. Obeys DEC-18, DEC-19.

This job reports the four control-band metrics for one day. It judges that day
against a baseline of the 30 most recent measured days before it. It reads the
ledger and writes an artifact. It issues only SELECT statements, and it opens
its connection read-only, so it is safe against a live database.

The artifact stays with the adopter. It describes their own traffic, so the
directory is ignored and nothing real enters the repository (DEC-18). The
runbook states that position (DEC-19).

It observes and it does not correct. The three-sigma action is a pull request,
and the job states that one is warranted rather than opening it.

TypeScript has no mature library for isotonic regression or HDBSCAN. This is
acceptable. These are offline jobs. You can write them in a different language.

---

## 5. Cold start

DEC-20 gives two phases. There is no separate shadow phase. The write limit
already sends each customer reply to a person. Therefore a shadow phase and a
gated live phase are almost the same system.

### Phase 1. Replay

1. Run the induction job on the history.
2. Curate the taxonomy to 25 intents.
3. Set a risk tier for each intent.
4. Label 8200 tickets, stratified by intent and Zipf-distributed by frequency.
5. Fit the threshold on 4100 of them.
6. Keep 4100 for the reports.
7. Run action match to get a baseline.

This phase has no risk to a customer. It gives each number that the live system
needs.

**NOTE: This is the largest single cost in the plan. Each later result depends**
**on it. If a person does not label the cases carefully, each published number has no value.**

### Phase 2. Live with gates

1. The system does internal writes automatically.
2. Each customer reply goes to the draft state.
3. Measure the approval-edit distance. `pnpm run bands` reports it daily.

The approval-edit distance is the most useful early signal. It shows how far the
draft was from a reply that a person can send.

The criteria to leave Phase 2 are not in V1. They need a decision that this
document does not make. Section 7.1 names the document that proposes them, and
`docs/v2-roadmap.md` states what blocks each one.

---

## 6. Known limits

A reference architecture that hides its failures is worse than no reference
architecture. These are the limits.

**Delivery guarantees belong to the action.** With an adapter that supports
idempotency keys, an effect occurs one time. With an adapter that does not,
actions where a duplicate is worse operate at-most-once and escalate. No
configuration gives exactly-once delivery to a system with no idempotency
support.

**Partitions exchange one failure for another.**

Partitions remove concurrent runs on one ticket. They add head-of-line delay in
each partition. They also add a rebalance period where two consumers can
overlap. The fencing epoch covers the rebalance period. V1 does not correct the
head-of-line delay. It will appear as latency on busy partitions.

That prediction is now checkable. `pnpm run latency` reports queue wait and
service time per partition. It reports percentiles rather than an average,
because an average is where a tail hides. The limit stands: this measures the
delay and does not correct it.

The consumer no longer sleeps through an arrival, because intake signals it.
That removes the poll interval from the wait. It leaves the head-of-line
delay: a message queued behind a batch still waits for the batch. Section 7
item 7 carries the figures and their bounds.

**Fencing needs the target to agree.**

The ledger applies the epoch check because the system owns the ledger. External
adapters do not know about epochs. A stopped run cannot damage the ledger. It
can still reach an external system. The write limit contains this risk. The
fencing does not.

**The groundedness check is a model call.**

It can be wrong. It decreases confident errors. It does not remove them. The
write limit makes V1 safe. The check does not. If DEC-12 changes, this
component is not sufficient alone.

**Replay cannot measure a counterfactual.** It is correct for routing only. See
paragraph 4.10.

**Action match scores routing only.** It controls merges. It does not measure
answer quality. Do not use it as a quality measurement.

**The model data position is configurable.**

See DEC-17 and DEC-19. The adopter is the data controller. One exception
applies. The prompt-log path is off by default and needs an explicit override.
If you make it active, you give irrevocable commercial rights to the inputs and
the outputs. The discount is 1 percent.

**One gate has a fit. The other does not.** `pnpm run calibrate` fits the
agreement threshold and `pnpm run fit-groundedness` fits the two coverage
thresholds. Each writes its own artifact, and nothing joins the two. DEC-05
keeps the gates independent, and the second artifact refuses to carry an
agreement value.

The coverage pair has been fitted once on the corpus this repository ships.
A run against `z-ai/glm-5.3-flash` chose it. The block threshold is 0.67 and
the review threshold is 0.83. The run cost 0.1484 US dollars. The job reports
that as a floor, because 2 faulted drafts carry spend nothing can attribute
(DEC-25).

**That run read a slice, not the half.** `GROUNDEDNESS_LIMIT` was 1100, and
the job takes a prefix rather than a sample. The fit half holds 4100 drafts,
so the run read 26.8 percent of it.

The prefix is not representative, because the corpus orders its intents. The
scored drafts cover 10 intents of 25. They hold every high-tier draft and no
low-tier draft at all.

So this pair is a pilot. It shows that the classes separate and that the job
selects rather than refuses. It is not a fit of the half, and no adopter
should read it as one. `pnpm run fit-groundedness` with no limit reads the
whole half.

The shipped fit read 1098 drafts and dropped 2. Its block threshold holds a
negative predictive value of 0.958 over the 192 drafts below it. That interval
runs from 0.920 to 0.979. Its review threshold holds a precision of 0.998 over
the 539 drafts at or above it. That interval runs from 0.990 to 1.000. Both
floors are read against the lower bound, so neither rests on a point estimate.

An earlier pair of 0.75 and 1.00 stood here, and two passes reproduced it.
Both passes read the uniform corpus, which no longer exists. So they are
withdrawn rather than compared against this one.

The pair moved, and this change does not establish why. The class mix did not
move with it. Each half holds 2050 fully grounded drafts of 4100, before the
reshape and after it.

The two runs scored different drafts, and coverage takes few distinct values.
So each run chose from a different grid of candidates. That describes the
move and does not explain it.

Read no quality claim into the new pair. Nothing here says the judge improved,
and the risk tier of an intent is not an input to this fit.

A review threshold of 0.83 means five claims in six must carry a citation.
Below that value a person reads the draft. That is the value the evidence
produced, not a value chosen for strictness. It is the lowest threshold whose
interval still holds the 0.985 precision floor.

It costs coverage. Of the drafts this gate scored, 49.1 percent clear review.
A further 33.4 percent land in the review band, and 17.5 percent fall below
block.

Read those as this gate's own pass rates and not as system dispositions. The
policy engine gates a customer reply, a high-risk intent, an irreversible
write or a missing capability first. It decides those before it reads either
threshold (DEC-12, DEC-03). So clearing review is necessary for the automatic path and
never sufficient.

A draft below block is escalated, and a person handles the escalation.

**The report half is not measured at this pair.** DEC-31 exists for this. The
numbers above chose the threshold, so they carry a selection effect. Only the
report half can check them, and it has not been run at this pair.

A measurement stood here before. It read the earlier pair over the uniform
corpus, and both are withdrawn. So the section is removed rather than
restated. Substituting the fit-half figures would defeat DEC-31.

Two things went with it. The first is any claim that the review threshold
cannot be tightened. That argument rested on a review value of 1.00, and the
value is now 0.83. The second is the residual error figure an adopter plans
around. No current measurement supports one, so this register states none.

Recover both by running `pnpm run report-groundedness` on the report half at
this pair. The job costs one model call per claim (DEC-25).

The artifact does not travel. `groundedness/` is ignored. A committed fit would
move every adopter's second gate to a number fitted on this repository's
synthetic corpus. `groundedness/reference-v3.json` is a tracked copy so a
reader can check these numbers against the file that produced them. Its name
sits outside the `v<n>.json` shape the version scanner reads. So no loader
finds it, and no checkout adopts it.

The agreement threshold is still the paragraph 4.5 seed. The synthetic corpus
cannot fit it. The offline stub answers every sample of one ticket alike, so
agreement is 1.0 on every case. No threshold below 1.0 changes a decision.

Both halves once drew their claims from one table of 56 sentences over 14
documents. The corpus now carries 312 sentences over 39 documents, 156 to each
half. Every sentence the report half asked also appeared in the fit half.
The split removed a selection effect, which is what DEC-31 asks of it. It gave
no protection against a judge that mis-read one sentence, because that sentence
depressed both halves alike.

Each document now carries a fit block and a report block. The two halves share
no sentence. So a judge that mis-reads one wording moves one half only, and the
disagreement is visible. The report sentence paraphrases its fit counterpart
rather than testing a new fact. So the halves stay matched in difficulty, and a
precision gap between them means the judge disagreed. It does not mean one pool
was harder.

The loader refuses a corpus that breaks either rule. A sentence reaching both halves is named by digest and never printed. That is
because a sentence on a real half is the customer's own text.

The two halves also held different shares of grounded drafts, 43 percent
against 51 percent. Precision counts grounded drafts above a threshold against
all drafts above it. So the report half was the easier one, and a published
precision read high. Both halves now hold 2050 fully grounded drafts of 4100.

The loader tests that gap with an equivalence test, and not with a significance
test. The two answer different questions. A significance test asks whether a
gap is real; the question here is whether a gap is small. They come apart in
both directions.

A gap of 5.5 points over 600 drafts a side is not significant, and it would
have passed. By contrast the 7.3 point gap that motivated this check is
significant over 385, and it is refused. A larger corpus was allowed a larger gap.

So the halves must show the gap is small. Two one-sided tests at 5 percent put
the whole 90 percent interval inside a margin of 5 points.

The interval carries the Agresti-Caffo correction, which adds one success and
one failure to each half before the standard error.

At a share of exactly 0 or exactly 1 the textbook standard error is zero. The
interval then collapses to a point, and any sample size passes. One draft a
side would then demonstrate closeness. That is the trivial pass this guard
replaced a significance test to remove. Away from the boundary the two agree to
four decimal places.

Sample size now works the right way round. A half too small to demonstrate
closeness is refused rather than passed by default. Such a half is already too
small to hold the precision floor. The margin is a stated judgement: 5 points
is where this repository stops asking a reader to compensate.

One limit remains, and it is not a fault of the job. A paraphrase pair tests
one fact twice. So a judge that mis-reads the fact itself, rather than one
wording of it, still moves both halves together.

The two floors the coverage fit holds have reasons of their own. The review
floor is 0.985. One minus that floor is the rate at which an internal write
acts on an unsupported claim. No person reads it. This gate is the only defence
against a confident error, so it backstops the agreement gate.

A backstop must be at least as strict as the gate it backs. The agreement gate
operates at 0.985. The value once matched paragraph 4.5 by coincidence. DEC-05
keeps the two gates independent, so a borrowed number justified nothing.

The block floor is 0.9. Below block this gate escalates rather than drafting,
so no person reads that draft as something to approve. A person still handles
the escalation. So the cost of a miss there is work and not correctness.

The agreement fit reads its floor the same way, and for the same reason. Both
searches computed an interval, recorded it, and chose on a point estimate. The
agreement search maximises coverage, so it prefers a wide band and the fault is
rarer there. It is not absent.

Sometimes the only band clearing the floor is a narrow one at the top. That
band won however few samples it held. Sharing the rule joins no value between
the gates, so DEC-05 stands.

Each floor is read against the lower bound of a 95 percent interval, never a
point estimate. A point estimate carries no sample size: three drafts that
agree read 1.000 and clear any floor. The first run of this job fitted the
block threshold on exactly three drafts. Its own recorded interval read 0.4385
to 1. So a floor also sets a minimum support, which is 253 drafts for 0.985 and
35 for 0.9.

The coverage job refuses when the measured classes do not separate. A gold set
carries per-claim ground truth, so the job knows which drafts were truly
grounded. It compares that against what the gate measured. Unsupported claims
carry a grade, and the artifact reports coverage for each. A separation that
comes from the easy grades alone protects nothing.

A fitted artifact reaches the policy engine, and each gate takes its own. Every
process resolves its gate numbers once at startup and logs a line per gate. So
one fitted gate beside one seeded gate reads correctly. A seeded agreement gate
logs `gate_thresholds_seeded` and a fitted one `gate_thresholds_fitted` with
the version. The coverage pair logs `coverage_thresholds_seeded` or
`coverage_thresholds_fitted` the same way.

The gold report records the agreement provenance beside its gate value. So a
published number names the gate that produced it.

The coverage artifact once had no reader. The two coverage numbers stayed at
their seeds however often the job ran. That was the same open loop this
resolver closed for the other gate, and it is closed now. The gates stay
independent: two artifacts, read separately, and neither supplies a number to
the other (DEC-05).

**A fitted threshold cannot move the published numbers.** The gold report runs against the offline stub, which answers each sample by matching a phrase.
Every sample of one ticket therefore agrees, and agreement is 1.0 on every
scored case. DEC-39 scores the 3074 first turns of the report half. No
threshold below 1.0 changes a decision.

A run at 0.60 and a run at 0.75 publish the same rates. Only the recorded provenance differs.

The wiring is real and the runtime gate does move. The synthetic corpus cannot
exercise it, because a deterministic stub has no disagreement to measure.
Treat the published rates as a measure of routing under a gate that never
binds. A real model on real history is the first case where the number moves.

The gold set now holds later turns, so the calibration job fits on prompts that
carry history, per DEC-37. Its artifact records the turn population as `scope`.
The replay and the gold report still score first turns only, per DEC-39.

Two caveats stand on the synthetic corpus. An invented agent reply names the
topic of its own thread. So a follow-up turn is easier to label than a real
one. A follow-up body is also drawn from five fixed strings, so later turns
repeat each other. Treat a multi-turn number from synthetic data as an upper
bound. Re-fit on real labelled history before you publish one.

Real labelled history now reaches all three jobs (DEC-18, DEC-31). A gold
half declares its provenance, and the set is closed: `synthetic` or `real`.
Each artifact records the provenance of the half it consumed, and each
process logs it at startup beside the version. So a reader never infers which
data a gate number covers.

The identifier rules of the shipped corpus bind a half that claims to be it.
An adopter's cases carry their own identifiers. Every other rule binds both
halves, and the exact half size binds the shipped corpus alone.

A real half brings no split guarantee with it. The loader cross-checks the
two committed halves; nothing cross-checks two files on an operator's disk.
So a job that consumes a real half refuses to run until the caller names the
other half. It takes identifiers from that half and reads none of its cases.
That keeps the structural guarantee: a leak needs a code change.

The check refuses a shared conversation as well as a shared case. Two turns of
one thread carry two identifiers.

The export models turns now. It emits one record per customer turn and orders
them by each message's own stated time. A thread whose messages state no
readable time falls back to delivery order, and the export reports every
fallback. An agent reply hangs off the turn it answered, as the ledger does.

Mail ingress marks every inbound message as the customer, because the live
path reads an inbox. So the export cannot read the author to tell the two
sides apart. The operator declares the support addresses instead. Undeclared,
an export records the customer's half of each conversation and says so.

Each artifact records the two case sets a run proved disjoint, as a digest of
their identifiers. The proof happens once inside one run and nothing else
would remember it. An operator fits against one report half. That operator
then publishes against a pruned fit half that no longer overlaps. Every check
passes, and the gate in force came from a fit that did overlap. A reader
compares the two artifacts and sees which sets each run used.

The check refuses halves of different sizes, of different provenance, or of
the same split. DEC-31 splits one gold set into two halves, and each of those
faults describes something that is not that split.

One limit stands, and the runbook states it. The check compares identifiers
exactly. An archive that changes the case of a message identifier defeats it.
A message identifier is case sensitive, so a loose match refuses halves that
are genuinely disjoint.

One gate reaches real history further than the other. The agreement fit and
the gold report read a real half end to end. The coverage fit reads a real
half, but it resolves every cited document against the shipped fixture set.
An adopter's claims cite their own documents, so the job refuses them. It
names the case and the document by digest. Loading a real knowledge base into that job is not in this work.

This repository still publishes synthetic numbers only. Nothing real is
committed, and no run here has produced an artifact from real history.

**Article 50(2) for text is not verified.** See paragraph 4.9.

**Feedback clusters are manual in V1.** At test-bed volume, automatic clusters
of a few hundred tickets each month give noise. The interval is wider than the
signal.

---

## 7. Open items for V2

1. The criteria to leave Phase 2.
2. Compensation for actions that you cannot reverse. **Closed.** See DEC-34.
3. Conversation state for more than one turn. **Closed.** See DEC-35 to DEC-39.
4. Automatic feedback clusters when the volume is sufficient.
5. A threshold for each intent above approximately 8 000 labelled tickets.
6. A schema migration procedure for adopters. **Closed.** See below.
7. A correction for head-of-line delay in a partition. **Open.** See below.

Three items now close. The numbers stay, because other documents cite them.

Item 3 was conversation state. DEC-35 to DEC-39 ratify it, and `db/008` and
`db/009` carry the ledger entities.

Item 2 was compensation. DEC-34 ratifies it, and `src/policy/policy.ts` gates
every irreversible write.

Item 6 was a schema migration procedure for adopters.
`src/ledger/migrate.ts` applies each file under `db/` and records the version
in `schema_version`.

Item 7 asks for a correction for head-of-line delay in a partition. It stays
open, and the measurement now says why. `db/005_run_timing.sql` adds the timing
columns. The service time of a run is the difference between its finish and its
creation. The wait is the difference between its pickup and its arrival. `pnpm
run latency` reads both per partition (DEC-27).

The first loaded reading came from a synthetic history of 2397 runs over 45
days. It reported 1.37 per cent utilisation across two consumers. Depth ran
567 to 646 runs per partition, a ratio of 1.14, which is what a hash gives.
The mean wait was 2.78 s against a poll floor of 2.50 s. Arrivals ran at
53 tickets a day, and the mean service time was 20.4 s.

So the wait was the consumer's own sleep and not a queue. The design
document gives four rules, and none of them fires at this load. R1 needs
waits that are high and uniform. R2 needs skew. R3 needs a heavy tail
causing most of the wait. R4 needs one harmed class.

The sleep is now gone. Intake signals the consumer inside the enqueue
transaction, and the loop wakes on that signal. `CONSUMER_INTERVAL_MS` remains
as a ceiling for a lost signal. Wait p50 and p95 fall to a figure the poll no longer sets. Before the signal
they were 2.4 to 2.6 s and 4.7 to 4.8 s.

What remains is the signal and the pickup. The seeder models that as zero, so
the register quotes no number for it: nothing here measures a live
notification.

The correction this item asks for is still unchosen. Removing the sleep
removes the floor, and it corrects at most a small part of the head-of-line
delay. Two figures bound that part.

The maximum wait barely moves, from 2.3 minutes to 2.2 minutes on the
deepest partition. About one run in a hundred still waits longer than one
poll period. That share never rises with the signal, and it never falls by
half, across the six seeds `src/seed/plan.test.ts` sweeps.

Those runs wait behind the batch ahead of them. That wait is the delay this
item names, and a signal cannot shorten a run already under way.

Service time is where the hours are, and it is not the consumer. The median
runs 30 to 48 s and the 95th percentile 2.5 to 3 hours. Model calls take about
14 s. DEC-12 puts a person on every customer reply, and the run row resolves
when that person answers. So most of that figure is human time.

The question reopens on volume. This history runs at 53 tickets a day and
two consumers, which is 1.37 per cent of their capacity. Saturating those two
consumers therefore needs about 3 900 tickets a day, and the figure scales
with the consumer count. An adopter near that volume reads the four rules
again and picks from the five options the design document maps.

Read the measurement as progress and not as closure. `docs/operations.md`
states the same position. The test for every item here is whether the item's
own words describe what shipped.

### 7.1 Where the V2 design documents live

The table below accounts for every open item above. Most have a design
document under `.creatumo/design/`, and the table names the one item that
needed none. The register stays the only authority. A document becomes a
decision only when a row enters the table in section 2.

| Item | Document | Status |
|---|---|---|
| 1. Phase 2 exit criteria | `899a1565-de05-44ce-8693-ed6dd4cb97e3.md` | proposed, blocked |
| 2. Compensation | `649c439e-afec-4bba-90d7-c14f78fd372d.md` | accepted, ratified as DEC-34 |
| 3. Conversation state | `8bd63fe0-8567-44f9-b6cf-ae3d83918381.md` | ratified as DEC-35 to DEC-39, renumbered from its DEC-34 to DEC-38 |
| 4. Automatic feedback clusters | `f4c1a90e-7d3b-4c2a-9e15-3b8d6f0a5c47.md` | blocked on volume |
| 5. A threshold for each intent | `434db94d-bbba-4977-805a-e9d83cb0b6c5.md` | blocked on the trigger |
| 6. Schema migration procedure | none needed | closed by `src/ledger/migrate.ts` |
| 7. Head-of-line delay | `99dc14d7-da9d-4a92-a9dc-d7c0685c6992.md` | proposed. The measurement shipped, the poll floor is gone, and the correction is unchosen |
| (none) | `8dcb8fcb-39dc-4911-a695-2282b6081f07.md` operator console | ratified as DEC-40 |
| (none) | `38f6dcea-8473-4cf4-9aef-c13936a0442f.md` a threshold for each intent | ratified as DEC-41 |
| (none) | issue #49 the approver a reply carries | ratified as DEC-42 |
| (none) | `ab98fd60-4327-4891-bb4e-00e51e66bdbd.md` partition concurrency | a trace. No row needed |
| (none) | `bbc657f2-8083-47be-84e9-672825e2158d.md` online A/B tests | proposed, blocked |
| (none) | `af2c0364-dc11-4547-a0b0-90f51592ae2b.md` ledger implementation | V1 background |

A DEC number inside one of those documents is provisional. The register
assigns the real number at ratification. So two documents may propose the
same number, and neither holds it until a row exists in section 2.

---

## Appendix. Technical names

Each name below has one meaning in this document. Use no other word for the
same thing.

| Name | Meaning in this document |
|---|---|
| action class | A group of actions that share one delivery rule |
| adapter | A component that connects the system to one external system |
| agreement | The fraction of classifier samples that give the same label |
| compensation | A second action that repairs a write the system cannot reverse |
| coverage | The result of the groundedness check |
| disposition | An observable result of how a person handled a ticket |
| fencing epoch | A number that increases and that makes an old write invalid |
| gate | A test that a run must pass before it continues |
| gold set | The labelled cases that fit the threshold and give the reports |
| groundedness | The fraction of claims that the retrieved text supports |
| idempotency key | A value that lets a target system find a repeated request |
| intent | One category in the taxonomy |
| ledger | The Postgres tables that hold all state |
| outbox | The table that holds actions before the relay sends them |
| partition | A group of tickets that one consumer owns |
| relay | The process that sends the outbox records |
| risk tier | The cost of an error for one intent. A person sets it |
| routing | The choice of which queue or component receives a ticket |
| run | One pass of the coordinator over one ticket |
| taxonomy | The curated list of a maximum of 25 intents |
