# Agentic Support System. V1 Foundational Architecture

Reference architecture for support automation with evidence gates.
TypeScript. Postgres. No orchestration framework.

---

## 1. Scope

This document specifies each component that processes a support request. The
flow starts at the inbound message. The flow stops at one of three results. The
first result is an internal write that the system does automatically. The second
result is an action that a person approves, such as a reply to the customer.
The third result is a case that a person takes over: an escalation, a close or
a snooze.

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
- Conversations of more than one turn (DEC-35 to DEC-39).
- The operator console (DEC-40, DEC-44 to DEC-51).

### 1.2 Not in V1

- Replies to customers that the system sends automatically.
- Automatic clusters of feedback.
- A different threshold for each intent below the labeled-case trigger
  (DEC-13). Above it, DEC-41 fits one for each intent.
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
| DEC-13 | Below the labeled-case trigger, one global threshold. A person sets the risk tier for each intent, at every corpus size | A threshold the system learns below the trigger; a risk tier the system learns at any size |
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
| DEC-39 | Replay scores first turns only. Multi-turn quality uses online metrics and a human-labeled cohort | Simulated customers; a judge scoring later turns |
| DEC-40 | Gated actions park in the helpdesk draft state. A read-only operator console may also approve one | A console that parks its own drafts; a console that is the only approval path |
| DEC-41 | Above the labeled-case trigger the system fits a threshold for each intent. Each case records what labeled it, and the artifact records the count and the accuracy of each kind | One global threshold above the trigger; per-intent thresholds with no record of what labeled the cases |
| DEC-42 | The ledger records an approver, and names it unverified. A trusted proxy supplies the identity. Without one the approval records `unattributed` | An authenticating console; no record of who approved; a header trusted on any bind |
| DEC-43 | The composer writes the reply a support person would send, and labels each sentence a claim or a courtesy. Coverage counts claims alone | A draft that is its claims joined; a second model call that rewrites claims into prose |
| DEC-44 | A reviewer console is the primary place a person reviews a gated action, and it writes on every adapter. Some helpdesks cannot send a parked copy. For their adapters, the ledger holds the approved reply, and every approval path sends it. Other adapters keep the DEC-40 draft path | Edit the helpdesk draft in place; a sendable draft beside the ledger text; two copies that both may send |
| DEC-45 | The console serves nothing to a request with no roster identity, and a trusted proxy authenticates that identity. The ledger records where each approver's name came from | Passwords or sessions the console holds; an unverified header; one shared account; pages open to anyone who reaches the port |
| DEC-46 | Taking a case reserves it for one reviewer, and the reservation lapses. A second reviewer may take it over after confirming. A console outcome on a reply the ledger holds applies only to the case as its reviewer was shown it | No reservation; a reservation that refuses a write; a lease with a lock service |
| DEC-47 | Each run records the product of the channel its message arrived on. A run retrieves the documents of its product and the documents that declare no product | No product; a product the model infers; a product label that retrieval ignores; one product for a whole conversation |
| DEC-48 | A reviewer may close a case with no reply, snooze it or hand it over. A reviewer may rewrite a reply the ledger holds. Each job counts each outcome for what it is | Approve as the only outcome; outcomes that reuse `resolved`; a snooze that looks resolved or counts as service time |
| DEC-49 | A reviewer may send a case back for a new attempt. No helpdesk copy of its reply may exist that a person could send. The attempt is part of every key of its turn | The run id in a key; a digest of the composed body; a new attempt that reuses the old key |
| DEC-50 | A reviewer may write a document from a case with a mapped product. It declares an owner, a review date and at least one product, and it carries no identifier of the case. Retrieval ignores it until it is embedded | The console calls the embedding model; a separate authoring tool; a document with no owner or review date |
| DEC-51 | A console send of a reply the ledger holds waits for a hold period. An undo inside the hold period returns the run to approval and removes every effect of the approval | An undo after the send; a delay in the browser; an undo that keeps the outbox row |

### Rows replaced in part

A later decision can replace part of an earlier row. The earlier row keeps its
text, which keeps the record of its decision. This table says what the later
row replaces, and the earlier row governs the rest.

| What the later row replaces | Earlier row | Later row |
|---|---|---|
| Where a person reviews, and the rejection of "a new web queue" | DEC-11 | DEC-44 |
| "Read-only", for every adapter | DEC-40 | DEC-44 |
| The draft state, where a helpdesk cannot send its parked copy | DEC-40 | DEC-44 |
| The rejection of "a console that parks its own drafts", for those helpdesks | DEC-40 | DEC-44 |
| The approval from the console. The command-line approval keeps DEC-42 | DEC-42 | DEC-45 |
| The key, which also carries the attempt a person requested | DEC-38 | DEC-49 |
| The partition key. A run with no conversation keeps the ticket id | DEC-27 | DEC-36 |

---

## 3. What the evidence showed

Six results shape the design. The architecture is not clear without them.

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

One global threshold needs 385 labeled cases for an interval of 5 percent.
A threshold for each of 25 intents needs approximately 2 400 cases. Intent
frequencies obey a Zipf distribution. Therefore the intent at rank 20 needs a
corpus of approximately 7 700 cases. DEC-13 exists because of this result.

Above that corpus size the result does not hold, and DEC-41 governs. DEC-13
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
  supportsLedgerReply:    boolean;   // DEC-44: the ledger holds the reply
}
```

The policy engine reads these capabilities. If `supportsIdempotencyKey` is
false, all write actions go to the approval path. The risk tier does not change
this. The intent does not change this. Autonomy decreases to agree with the guarantee that the target system gives.

The system declares this decrease. An
operator does not find it in production.

The repository supplies reference adapters for IMAP and SMTP, a webhook, a
fixture-backed helpdesk and FreeScout. Together they show that the contract is
general. The fixture-backed helpdesk holds its state in memory and reaches no
network (DEC-18). The FreeScout adapter reaches a running helpdesk, and its
operator supplies the API key.

### 4.2 Ledger

**`ledger`** (Postgres). Obeys DEC-04, DEC-24, DEC-26, DEC-27, DEC-28.

The ledger holds all state. No component keeps state outside the ledger.
The sketch below shows the core columns that the decisions name. The
migrations under `db/` hold the full schema.

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
  -> executing          (automatic path, reversible internal writes only)
  -> awaiting_approval  (customer replies, DEC-12)
  -> resolved | escalated | superseded | abandoned | closed
  -> snoozed           (waiting for a period or the customer, DEC-48)
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
of a US dollar. A model call costs a fraction of a cent. A unit of one cent
rounds almost every call to zero. A limit over cents compares a sum of zeros.

If the run reaches a limit, this is not an error. The run
goes to `escalated` and keeps its partial work. A high cost then becomes visible
in operations. It does not become a surprise in the invoice.

### 4.4 Outbox relay

**`relay`**. Obeys DEC-04, DEC-06, DEC-28, DEC-29, DEC-30, DEC-44, DEC-51.

The relay is a different process. It reads the records in the outbox that have
the `pending` status. It calls the adapter with the `idem_key` and the `epoch`.
Then it sets the status to `sent`.

An adapter that declares `supportsLedgerReply` receives the reply the ledger
holds, with its disclosure and provenance (DEC-44). Every other adapter sends
the draft it parked.

A record may name a moment before which it is not sent (DEC-51). The relay
skips such a record while that moment is ahead. It holds the run's row lock
across a send too. So an undo cannot take back a reply in flight.

Send first. Set the status second. Do not set the status first.

The relay reads the delivery rule from the record. It does not read a global
setting.

| Adapter idempotency | Duplicate costs more | Loss costs more |
|---|---|---|
| Supported | at-least-once. Retry | at-least-once. Retry |
| Not supported | **at-most-once**. Escalate | at-least-once. Retry |

If the adapter has no idempotency support and the relay cannot find the delivery
state, the relay must not retry. It sets the record to `delivery_unknown`. It
escalates the run and states the uncertainty. A retry can
pay a second refund. A silent abandon can leave a customer with no answer.
Escalation is the only action that does not select a failure for the operator.

An adapter can prove that an attempt sent nothing. Then the relay leaves the
record pending for the next scan, under either delivery rule. The table gives
the rule for a failure the adapter cannot explain. An attempt that sends nothing
delivers nothing, so a retry delivers once.

Some faults no retry can clear, and no attempt can ever reach the customer
through them. Then the relay sets the record to `not_sent`. It
escalates the run with the cause.

A refusal from the target proves nothing about an earlier attempt. A person can
send a draft from a mail client, and a relay can stop after its send. So a
refused login, or a draft that is gone, goes to the table as an unexplained
failure.

If the adapter has read-back support, the relay reads the target system. When it
finds the delivery, it reconciles and does not escalate. When it finds nothing,
the table decides: an at-most-once record still escalates, because the target
can lag behind a send.

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
Retrieval reads no document past its review date, on any path. The console's
knowledge screen counts those documents and lists them for a person to review.
This report costs nothing more.

**Index contents.** Index the documents and the canonical resolutions that a
person approved. Do not index the raw resolved tickets. Raw tickets put personal
data in permanent storage. Raw tickets also keep advice that was correct one
time only.

### 4.7 Composer and groundedness check

**`composer`**. Obeys DEC-07, DEC-43.

Each claim must have a citation to a retrieved text span. If the composer cannot
cite a claim, the composer must abstain. An abstain result is a correct output.
It is not a failure. It is also the least expensive way to find a gap in the
knowledge.

DEC-43 states what the composer writes. It writes the reply a support person
would send. It does not write a list of claims.

The composer partitions its own output into sentences. It labels each sentence.
A claim cites a retrieved span. A courtesy sentence opens or closes the reply.
A courtesy sentence states nothing about the customer, the account, the policy
or the outcome.

The draft is those sentences in order. So the text the composer drafts is the
text the gate scored. A second model call rewriting the claims into prose breaks
that identity. It also restores the failure this section removed.

On the draft path the parked draft is the copy that sends. A person may edit
it in the helpdesk before the relay sends it (DEC-40). DEC-44 and DEC-48 let a
person edit or rewrite a reply the ledger holds.

A rewritten reply reports no coverage. The gate judged the draft, so every
surface withholds the number. Each one says whose reply it was. The gate row
keeps the verdict.

The shape is one optional courtesy sentence, then the claims, then one optional
courtesy sentence. The parser refuses anything else. A draft that cites nothing
is an abstain.

The bound is deliberate. A courtesy sentence is the one place an uncited fact
can sit. The bound confines that place to the opening and the closing.

The parser counts sentences, not lines. A courtesy line carrying two sentences
delivers two uncited sentences under a bound that reads as one. Such a line is
an abstain.

No check proves that a courtesy sentence carries no fact. This system ships no
such check. Consider a rule on digits and currency. It passes "we have already
refunded your payment". It blocks a courtesy sentence that names a business day.
A reader trusts a rule that does neither job.

Three controls carry the risk instead. The parser refuses an uncited fact in
the body of the reply. The console draws every uncited sentence as uncited. A
customer reply always needs an approval (DEC-12).

Coverage counts claims alone. A courtesy sentence never enters the fraction.

So coverage describes the cited sentences of a reply. It does not describe the
whole reply. A reply that opens and closes courteously scores on its
claims. The console states how many sentences carry no source.

**`groundedness`**. Obeys DEC-07.

This component tests each claim against the retrieved text. If a claim adds
information that the text does not contain, the response is not grounded.

The claims come from the composer. The composer already proved that each one
cites a retrieved span, so it owns the claim boundaries. This component does
not derive them again.

A second model call that split the draft would make the denominator of the
fraction a model's choice. A split that returned one line would score 1.0 and
pass both thresholds. The composer's partition prevents that failure and saves
one model call.

Use two thresholds, a block and a review:

| Value | Action |
|---|---|
| Below the review threshold | Send to a person for review |
| Below the block threshold | Block. Do not send |

The seeds are 0.80 and 0.70. They are seeds and not the operative pair. `pnpm
run fit-groundedness` fits the pair on the fit half, and a process holding a
coverage artifact runs the fitted values. It logs at startup which values it runs. So
a reader never confuses a seeded run with a fitted run.

The two thresholds decide the automatic path only. DEC-12 gates a customer
reply before the policy engine reads either one.

This component is the second gate. It is independent of the first gate by
design. It is the only defense against a confident error, because agreement
cannot find a confident error. See section 3.2.

### 4.8 Policy engine

**`policy`**. Obeys DEC-03, DEC-05, DEC-06, DEC-12, DEC-13, DEC-30, DEC-34, DEC-41.

This component is a pure function. It does not call a model.

Inputs: the risk tier of the intent, the agreement value, the coverage value,
the adapter capabilities and the action class.
Output: `auto`, `gated` or `escalate`.

```
if (!capabilities.supportsIdempotencyKey && action.isWrite) return 'gated';
if (!capabilities.supportsReadBack && action.isWrite)       return 'gated';
if (action.isCustomerVisible)                                return 'gated';
if (action.isWrite && action.isIrreversible)                 return 'gated';
if (intent.riskTier === 'high')                              return 'gated';
if (agreement    < agreementThresholdFor(intent))            return 'escalate';
if (groundedness < thresholds.groundednessBlock)             return 'escalate';
if (groundedness < thresholds.groundednessReview)            return 'gated';
return 'auto';
```

The agreement threshold is the intent's fitted value where one exists, and the
global value otherwise (DEC-41).
`groundedness` in the sketch is the coverage value, under the name the code
gives it.

An automatic write needs two capability guarantees, and the engine reads both.
An idempotency key makes a retry safe. Read-back makes the result knowable.

Without read-back the relay escalates a failed send instead of retrying it.
See DEC-30. So autonomy decreases for that adapter as well. See DEC-06.

A person sets the risk tier for each intent. The system does not learn the tier.
See DEC-13. A high-tier intent never goes to the automatic path. The gate values
do not change this. Confidence measures the accuracy of the classification.

It does not measure the cost of an error. These are different quantities.

### 4.9 Approval bridge

**`approval`**. Obeys DEC-11, DEC-14, DEC-24, DEC-33, DEC-40, DEC-44.

The bridge parks each gated customer reply in the adapter. The copy is a draft,
or under DEC-44 an internal note while the ledger holds the text that sends.
A gated write with no customer draft parks in the ledger alone (DEC-34).
It makes no adapter call, so no unsent draft is left behind after approval.

An operator console may approve a parked draft (DEC-40). DEC-44 makes that
console the primary place a person reviews. It lets the ledger hold the reply
for an adapter whose helpdesk cannot send its parked copy. The FreeScout adapter
declares that capability when its operator sets `FREESCOUT_INTERNAL_NOTE`. Its
park then posts an internal note, and the approval sends the ledger's text.
Every other customer reply parks as a helpdesk draft.

Each customer reply must have three items:

1. A `disclosure` field that is not empty.
2. Provenance metadata that a machine can read.
3. An idempotency key for the park, derived under DEC-24.

The bridge refuses to send a reply that does not have all three items.

**Who approved it.** Obeys DEC-42, and DEC-45 on the console.

The ledger records that a person approved a reply, and the source of the
approver's name. The source says whether the roster, a header claim or nobody
named the approver. So an incident can separate the operator from anyone else
who reached the port.

The approval records an approver. Off the console the value is a claim, not an
authentication. A caller supplies it, and the approval bounds what it keeps.

A name may hold letters, marks, numbers, punctuation, symbols and single ASCII
spaces. It holds no character that draws nothing, such as a joiner, a variation
selector or a blank filler. A mark needs a character before it, and no
character carries more than four stacking marks. A value that is too long, or
that breaks one of these rules, names nobody.

An approval that names nobody records `unattributed`, and the source records
`none`. That is a recorded fact and not a missing row. A null in the column
means no approval reached the run.

Only a trusted proxy may name an approver. Anyone reaching a console can set a
header. So a console reads one only when the operator names the header its
proxy sets. The console then checks that name against a roster of reviewers
before it builds a page. A request with no active roster identity is refused.
An approval there records the source `roster`.

DEC-42 grants no authority, and it changes no gate. DEC-45 puts the console behind
a roster a trusted proxy authenticates, and that roster decides who may review
there. DEC-12 still puts a person on every customer reply. DEC-40 still permits
the console to be that person's interface.

**Why the park needs a key.**

The adapter creates the draft before the ledger can record its handle. Without
a key, a crash between the two leaves a draft that no row names. The next run
then parks a second one, and the customer sees two replies. The key travels
with the reply, so the adapter recognizes the repeat and returns the first draft.
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

DEC-31 governs the split, not the size. The size is an implementation detail,
so a corpus may grow and the discipline still holds. Two needs set a minimum
size. The coverage fit needs enough drafts above the review threshold to hold
its precision floor at the lower bound. The per-intent fit of DEC-41 needs a
corpus at the labeled-case trigger or above it.

Do not use one set of cases for both tasks. That method is selection on the test
data. A simulation of 2 000 trials shows the effect. If you select the best of 13
thresholds on 385 cases, the reported precision increases by approximately
2.5 points. The effect shrinks as a half grows, and the split removes it at
any size.

The cost is a wider interval than an undivided set gives. Each half holds half
the cases, so its interval is about 1.4 times as wide.

The strata need care. DEC-39 scores first turns only, so the report half
yields fewer scored cases than it holds. The Zipf shape puts the high-tier
intents in the tail, so the high tier is the thin one.

Read each containment width with the rate beside it. In the shipped gold report
the low and medium tiers contain every case, and the high tier contains none.
Each containment rate therefore sits on a boundary, where a Wilson interval is
narrow. A narrow interval there reports no spread, not a precise measurement.

Action match sits away from those boundaries, and its intervals are wide. The
high tier carries the widest, and no boundary explains it away.

Treat the strata as an indication only. Read each count and each interval from
the gold report artifact.

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
`bands.yaml` defines. Section 4.11 states how it judges a day.

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

The limit of 25 comes from the Zipf result in section 3.3. Above 25 intents,
the rare intents never collect sufficient examples. More intents give an
appearance of accuracy and nothing more.

**`calibration`**. Obeys DEC-13, DEC-31, DEC-41.

This job fits the agreement threshold on the fit half of the gold set. Run it
each month, not for each ticket.

Below the labeled-case trigger the job fits one global threshold. At or above
it, the job fits a threshold for each intent that clears the data floor
(DEC-41). An intent below that floor keeps the global threshold.
`TRIGGER_MIN_LABELLED` sets the trigger at 8 000 labeled cases: the section 3.3
figure of about 7 700, rounded up.

**`bands`**. Obeys DEC-18, DEC-19.

This job reports the control-band metrics for one day. It judges that day
against a baseline of the most recent measured days before it. The baseline
excludes the day it judges. A window too thin or too flat to carry a band says
so instead of stating one. It reads the ledger and writes an artifact. It
issues only SELECT statements, and it opens
its connection read-only, so it is safe against a live database.

The artifact stays with the adopter. It describes their own traffic, so the
directory is ignored and nothing real enters the repository (DEC-18). The
runbook states that position (DEC-19).

It observes and it does not correct. The three-sigma action is a pull request,
and the job states that one is warranted rather than opening it.

The induction and calibration jobs ship in TypeScript. Induction clusters with
k-means, and calibration searches the observed agreement values. Both are
offline jobs, so an adopter may replace either one with another method or
another language.

---

## 5. Cold start

DEC-20 gives two phases. There is no separate shadow phase. The write limit
already sends each customer reply to a person. Therefore a shadow phase and a
gated live phase are almost the same system.

### Phase 1. Replay

1. Run the induction job on the history.
2. Curate the taxonomy to 25 intents.
3. Set a risk tier for each intent.
4. Label a gold set of cases, stratified by intent and Zipf-distributed by
   frequency. Section 3.3 states the size each threshold needs.
5. Split the set into two equal halves (DEC-31). Fit the threshold on one half.
6. Keep the other half for the reports.
7. Run action match to get a baseline.

This phase has no risk to a customer. It gives each number that the live system
needs.

**NOTE: This is the largest single cost in the plan. Each later result depends**
**on it. If a person does not label the cases carefully, each published number has no value.**

### Phase 2. Live with gates

1. The system does internal writes automatically.
2. Each customer reply goes to the draft state.
3. Measure the approval-edit distance. Run `pnpm run bands` each day to report it.

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

Partitions remove concurrent runs on one conversation. They add head-of-line delay in
each partition. They also add a rebalance period where two consumers can
overlap. The fencing epoch covers the rebalance period. V1 does not correct the
head-of-line delay. It appears as latency on busy partitions.

`pnpm run latency` checks that prediction. It reports queue wait and service
time per partition. It reports percentiles rather than an average, because an
average is where a tail hides. The limit stands: this measures the delay and
does not correct it.

Intake signals the consumer on each arrival, so the poll interval sets no floor
on the wait. The head-of-line delay remains: a message queued behind a batch
still waits for the batch. Section 7 item 7 carries the figures and their bounds.

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
section 4.10.

**Action match scores routing only.** It controls merges. It does not measure
answer quality. Do not use it as a quality measurement.

**The model data position is configurable.**

See DEC-17 and DEC-19. The adopter is the data controller. One exception
applies. Prompt logging is a setting in the provider account, and this
repository never turns it on. If you turn it on there, the provider gains
irrevocable commercial rights to the inputs and the outputs. In return, the
provider lowers its price by 1 percent.

**Only the groundedness gate has a fit on the shipped corpus.**
`pnpm run calibrate` fits the agreement threshold and `pnpm run fit-groundedness` fits the two coverage
thresholds. Each writes its own artifact, and nothing joins the two. DEC-05
keeps the gates independent, and the second artifact refuses to carry an
agreement value.

The tracked reference artifact holds a fit of the coverage pair on the corpus
this repository ships, against `z-ai/glm-5.3-flash`. The block threshold is
0.67 and the review threshold is 0.83. The artifact records a cost of 0.1484
US dollars. The job reports that as a floor, because 2 faulted drafts carry spend nothing can attribute
(DEC-25).

**That fit covers a slice, not the half.** It holds 1100 drafts under
`GROUNDEDNESS_LIMIT`, and the job takes a prefix rather than a sample. So the
fit covers about a quarter of the fit half.

The prefix is not representative, because the corpus orders its intents. The
scored drafts cover fewer than half of the intents. They hold every high-tier
draft and no low-tier draft at all.

So this pair is a pilot. It shows that the classes separate and that the job
selects rather than refuses. It is not a fit of the half, and no adopter
should read it as one. `pnpm run fit-groundedness` with no limit reads the
whole half.

The shipped fit scores 1098 drafts and drops 2. Its block threshold holds a
negative predictive value of 0.958 over the 192 drafts below it. That interval
runs from 0.920 to 0.979. Its review threshold holds a precision of 0.998 over
the 539 drafts at or above it. That interval runs from 0.990 to 1.000. Both
floors read the lower bound, so neither rests on a point estimate.

Read no quality claim into this pair. The risk tier of an intent is not an
input to this fit.

A review threshold of 0.83 means five claims in six must carry a citation.
Below that value a person reads the draft. That is the value the evidence
produced, not a value chosen for strictness. It is the lowest threshold whose
interval still holds the 0.985 precision floor.

It costs automation. About half of the drafts this gate scores clear review. The
artifact records the shares in the review band and below block.

Read those as this gate's own pass rates and not as system dispositions. The
policy engine gates a customer reply, a high-tier intent, an irreversible
write or a missing capability first. It decides those before it reads either
threshold (DEC-12, DEC-03). So clearing review is necessary for the automatic path and
never sufficient.

A draft below block is escalated, and a person handles the escalation.

**No shipped artifact measures the report half at this pair.** DEC-31 exists for this.
The numbers above choose the threshold, so they carry a selection effect. Only
the report half can check them. DEC-31 forbids fit-half figures in that place.

So this register states no residual error figure for an adopter to plan around.
It also makes no claim about whether the review threshold of 0.83 can tighten.
A run of `pnpm run report-groundedness` on the report half at this pair answers
both. The job costs one model call per claim (DEC-25).

The artifact does not travel. Git ignores `groundedness/`. A committed fit
would move every adopter's second gate to a number fitted on this repository's
synthetic corpus. One tracked copy, `groundedness/reference-v<n>.json`, lets a
reader check these numbers against the file that produced them. Its name sits
outside the `v<n>.json` shape the version scanner reads. So no loader finds it,
and no checkout adopts it.

The agreement threshold is the section 4.5 seed. The synthetic corpus
cannot fit it. The offline stub answers every sample of one ticket alike, so
agreement is 1.0 on every case. No threshold below 1.0 changes a decision.

The generator holds two claim sets for each document, one for each half. The
two halves share no sentence. A shared sentence protects nothing against a
judge that misreads it, because it moves both halves alike. With no shared
sentence, a judge that misreads one wording moves one half only, and the
disagreement is visible.

The report sentence paraphrases its fit counterpart rather than testing a new
fact. So the halves stay matched in difficulty, and a precision gap between
them means the judge disagrees. It does not mean one pool is harder.

The loader refuses a corpus that breaks either rule. It names a sentence that
reaches both halves by its digest and never prints it. A sentence on a real
half is the customer's own text.

The two halves must also hold close shares of grounded drafts. Precision
counts grounded drafts above a threshold against all drafts above it. So a
half with a larger grounded share is the easier one, and a precision published
from it reads high.

The loader tests that gap with an equivalence test, and not with a significance
test. The two answer different questions. A significance test asks whether a
gap is real; the question here is whether a gap is small. They come apart in
both directions.

A significance test passes a 5.5 point gap over 600 drafts a side, since that
gap is not significant. Over fewer drafts it passes a larger gap, which is the
wrong way round.

So the halves must show the gap is small. Two one-sided tests at 5 percent put
the whole 90 percent interval inside a margin of 5 points.

The interval carries the Agresti-Caffo correction, which adds one success and
one failure to each half before the standard error.

At a share of exactly 0 or exactly 1 the textbook standard error is zero. The
interval then collapses to a point, and any sample size passes. One draft a
side would then demonstrate closeness. The correction prevents that trivial
pass. Away from the boundary the two agree to four decimal places.

Sample size works the right way round. The loader refuses a half too small to
demonstrate closeness, rather than passing it by default. Such a half is
already too small to hold the precision floor. The margin is a stated judgment:
5 points is where this repository stops asking a reader to compensate.

One limit remains, and it is not a fault of the job. A paraphrase pair tests
one fact twice. So a judge that mis-reads the fact itself, rather than one
wording of it, still moves both halves together.

The two floors the coverage fit holds have reasons of their own. The review
floor is 0.985. One minus that floor is the rate at which an internal write
acts on an unsupported claim. No person reads it. This gate is the only defense
against a confident error, so it backstops the agreement gate.

A backstop must be at least as strict as the gate it backs. The agreement fit
targets 0.985, so the review floor is 0.985 too. Section 4.5 states the same
figure for its simulation, and that match carries no weight. DEC-05 keeps the
two gates independent, so neither borrows a number from the other.

The block floor is 0.9. Below block this gate escalates rather than drafting,
so no person reads that draft as something to approve. A person still handles
the escalation. So the cost of a miss there is work and not correctness.

The agreement fit also reads its floor against the lower bound, for the same
reason. A search that chooses on a point estimate admits a band however few
samples it holds. The agreement search maximizes the share of cases inside its band. So it
prefers a wide band, and the fault is rarer there. It is not absent: sometimes the only band
that clears the floor is a narrow one at the top. Sharing the rule joins no
value between the gates, so DEC-05 stands.

Each fit reads its floor against the lower bound of a 95 percent interval,
never a point estimate. A point estimate carries no sample size: three drafts
that agree read 1.000 and clear any floor. Their interval runs from 0.4385 to
one. So a floor also sets a minimum support, which is 253 drafts for 0.985 and
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

The resolver reads the coverage artifact as it reads the agreement artifact.
The gates stay independent: two artifacts, read separately, and neither
supplies a number to the other (DEC-05).

**A fitted threshold cannot move the published numbers.** The gold report runs against the offline stub, which answers each sample by matching a phrase.
Every sample of one ticket therefore agrees, and agreement is 1.0 on every
scored case. DEC-39 scores the first turns of the report half alone. No
threshold below 1.0 changes a decision.

A run at 0.60 and a run at 0.75 publish the same rates. Only the recorded provenance differs.

The wiring is real and the runtime gate does move. The synthetic corpus cannot
exercise it, because a deterministic stub has no disagreement to measure.
Treat the published rates as a measure of routing under a gate that never
binds. A real model on real history is the first case where the number moves.

The gold set holds later turns, so the calibration job fits on prompts that
carry history, per DEC-37. Its artifact records the turn population as `scope`.
The replay and the gold report score first turns only, per DEC-39.

Two caveats stand on the synthetic corpus. An invented agent reply names the
topic of its own conversation. So a follow-up turn is easier to label than a real
one. The generator also draws a follow-up body from five fixed strings, so later turns
repeat each other. Treat a multi-turn number from synthetic data as an upper
bound. Re-fit on real labeled history before you publish one.

Real labeled history reaches the agreement fit, the coverage fit and the gold
report (DEC-18, DEC-31). A gold half declares its provenance, and the set is
closed: `synthetic` or `real`.
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

The export models turns. It emits one record per customer turn and orders
them by each message's own stated time. A conversation whose messages state no
readable time falls back to delivery order, and the export reports every
fallback. An agent reply hangs off the turn it answered, as the ledger does.

Mail ingress marks every inbound message as the customer, because the live
path reads an inbox. So the export cannot read the author to tell the two
sides apart. The operator declares the support addresses instead. Undeclared,
an export records the customer's half of each conversation and says so.

Each artifact records the two case sets a run proved disjoint, as a digest of
their identifiers. The proof happens once inside one run and nothing else
would remember it. Suppose an operator fits against one report half. The
operator then prunes the fit half until the two do not overlap, and publishes.
Every check passes, yet the gate in force comes from a fit that overlaps. A
reader
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
names the case and the document by digest. That job loads no real knowledge
base.

This repository publishes synthetic numbers only. It commits nothing real, and
no artifact here comes from real history.

**No check verifies Article 50(2) for text.** See section 4.9.

**Feedback clusters are manual in V1.** At test-bed volume, automatic clusters
of a few hundred tickets each month give noise. The interval is wider than the
signal.

---

## 7. Open items for V2

1. The criteria to leave Phase 2.
2. Compensation for actions that you cannot reverse. **Closed.** See DEC-34.
3. Conversation state for more than one turn. **Closed.** See DEC-35 to DEC-39.
4. Automatic feedback clusters when the volume is sufficient.
5. A threshold for each intent above the labeled-case trigger.
6. A schema migration procedure for adopters. **Closed.** See below.
7. A correction for head-of-line delay in a partition. **Open.** See below.

Items 2, 3 and 6 are closed. They keep their numbers, because other documents
cite them.

Item 2 is compensation. DEC-34 ratifies it, and `src/policy/policy.ts` gates
every irreversible write.

Item 3 is conversation state. DEC-35 to DEC-39 ratify it, and
`db/008_conversation.sql` creates the conversation and turn tables.

Item 6 is a schema migration procedure for adopters. `src/ledger/migrate.ts`
applies each file under `db/` and records the version in `schema_version`.

Item 7 asks for a correction for head-of-line delay in a partition. It stays
open. `db/005_run_timing.sql` adds the timing columns. The service time of a
run is the difference between its finish and its creation. The wait is the
difference between its pickup and its arrival. `pnpm run latency` reads both
per partition (DEC-27).

The seeder's synthetic history is the only reading. It runs far below the
capacity of its two consumers, and the depth per partition varies as a hash
gives.

The design document gives four rules, and none of them fires at this load. R1
needs waits that are high and uniform. R2 needs skew. R3 needs a heavy tail
causing most of the wait. R4 needs one harmed class.

Intake signals the consumer inside the enqueue transaction, and the loop wakes
on that signal. `CONSUMER_INTERVAL_MS` remains as a ceiling for a lost signal.
So the poll interval sets no floor on the wait. The seeder models the signal and
the pickup as zero, so the register quotes no number for them. Nothing here
measures a live notification.

The signal does not correct the head-of-line delay. About one run in a hundred
waits longer than one poll period, behind the batch ahead of it. That share
never rises with the signal, and it never falls by half, across the six seeds
`src/seed/plan.test.ts` sweeps. The maximum wait keeps at least nine tenths of
its polled value across those seeds. A signal cannot shorten a run already
under way.

Service time is where the hours are, and it is not the consumer. DEC-12 puts a
person on every customer reply, and the run row resolves when that person
answers. So most of a run's service time is human time.

The question reopens on volume, as arrivals approach the capacity of the
consumers. An adopter near that volume reads the four rules again and picks
from the five options the design document maps.

Read the measurement as progress and not as closure. `docs/operations.md`
states the same position. The test for every item here is whether the item's
own words describe what shipped.

### 7.1 Where the V2 design documents live

The table below accounts for every open item above. Most have a design
document under `docs/design/`, and the table names the one item that
needs none. The register stays the only authority. A document becomes a
decision only when a row enters the table in section 2.

| Item | Document | Status |
|---|---|---|
| 1. Phase 2 exit criteria | [`v2-automatic-customer-replies.md`](design/v2-automatic-customer-replies.md) | proposed, blocked |
| 2. Compensation | [`v2-compensation.md`](design/v2-compensation.md) | accepted, ratified as DEC-34 |
| 3. Conversation state | [`v2-multi-turn-conversation-state.md`](design/v2-multi-turn-conversation-state.md) | ratified as DEC-35 to DEC-39 |
| 4. Automatic feedback clusters | [`v2-automatic-feedback-clusters.md`](design/v2-automatic-feedback-clusters.md) | blocked on volume |
| 5. A threshold for each intent | [`v2-per-intent-agreement-thresholds.md`](design/v2-per-intent-agreement-thresholds.md) | open. The mechanism ships, and the item waits on an adopter's labeled history |
| 6. Schema migration procedure | none needed | closed by `src/ledger/migrate.ts` |
| 7. Head-of-line delay | [`v2-head-of-line-delay-correction.md`](design/v2-head-of-line-delay-correction.md) | proposed. The measurement ships, and the correction is unchosen |
| (none) | [`amendment-an-operator-console-beside-the-helpdesk-draft.md`](design/amendment-an-operator-console-beside-the-helpdesk-draft.md) operator console | ratified as DEC-40 |
| (none) | [`amendment-a-threshold-for-each-intent.md`](design/amendment-a-threshold-for-each-intent.md) a threshold for each intent | ratified as DEC-41 |
| (none) | no document: the approver a reply carries | ratified as DEC-42 |
| (none) | [`trace-bounded-intra-partition-concurrency.md`](design/trace-bounded-intra-partition-concurrency.md) partition concurrency | a trace. No row needed |
| (none) | [`v2-online-ab-experiments.md`](design/v2-online-ab-experiments.md) online A/B tests | proposed, blocked |
| (none) | [`ledger-implementation.md`](design/ledger-implementation.md) ledger implementation | V1 background |
| (none) | [`amendment-a-reviewer-console-four-people-work-from.md`](design/amendment-a-reviewer-console-four-people-work-from.md) a reviewer console four people work from | ratified as DEC-44 to DEC-51 |

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
| attempt | One run of a turn, with its crash retries. The first run is attempt 1, and only a person's request starts another |
| case | An item a person examines. It is a turn to label, or the runs of one ticket a reviewer takes |
| compensation | A second action that repairs a write the system cannot reverse |
| coverage | The fraction of claims that the retrieved text supports. It is the result of the groundedness check |
| disposition | An observable result of how a person handled a ticket |
| fencing epoch | A number that increases and that makes an old write invalid |
| gate | A test that a run must pass before it continues |
| gold set | The labeled cases that fit the threshold and give the reports |
| groundedness | The check that tests each claim against the retrieved text. Its result is coverage |
| hold period | The time a console send waits in the outbox before the relay may send it |
| idempotency key | A value that lets a target system find a repeated request |
| intent | One category in the taxonomy |
| ledger | The Postgres tables that hold all state |
| outbox | The table that holds actions before the relay sends them |
| partition | A group of conversations that one consumer owns. A run with no conversation joins one through its ticket id |
| product | What a channel serves. A run records its channel's product |
| relay | The process that sends the outbox records |
| reservation | A lapsing claim one reviewer holds on a case |
| risk tier | The cost of an error for one intent. A person sets it |
| roster | The list of reviewers a trusted proxy can name |
| routing | The choice of which queue or component receives a ticket |
| run | One pass of the coordinator over one turn, or over a ticket that has no conversation |
| taxonomy | The curated list of a maximum of 25 intents |
