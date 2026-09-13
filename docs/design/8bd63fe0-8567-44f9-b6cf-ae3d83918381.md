---
title: V2 Design: Multi-Turn Conversation State
author: ox-alpha
tags: [v2, design, multi-turn, evaluation]
created_at: 2026-08-25T16:15:58Z
updated_at: 2026-08-27T23:59:00Z
---

# V2 Design. Multi-Turn Conversation State

Design proposal for V2 open item 3 and section 1.2 of `docs/v1-architecture.md`.
Status: draft for review. Nothing here is a decision until the lead ratifies it
into the register. The document obeys Simplified Technical English.

---

## 1. The problem

V1 handles one pass over one ticket. The run input is one ticket body
(`CoordinateInput.ticketText`). Each run starts with no memory. A customer who
replies "this did not work" gets a fresh classification with no context.

Section 4.10 adds a second problem. Replay scores a decision against a history
the system did not change. In a multi-turn conversation, the system's own reply
changes the path. The historical record stops being a valid comparison. Replay
is correct for turn one. It is not correct for turn two.

A V2 design must solve both problems together. State without valid evaluation
produces numbers nobody can trust. Evaluation without state has nothing new to
measure.

## 2. Names
| Name | Meaning |
|---|---|
| conversation | One customer problem, tracked across one or more ticket threads |
| thread | One ticket thread in one target system. V1 called this "the ticket" |
| turn | One inbound message plus the system's response to it |
| primary thread | The thread of turn one. Intake sets it at creation. It never changes |

The appendix of the architecture doc defines one relevant name. It defines
"run": one pass of the coordinator over one ticket. It has no "ticket" entry.
This document anchors on that run definition and on the wording of section 1.2.
It adds four names: conversation, thread, turn, primary thread. It changes none.

## 3. Proposed decisions
The architecture doc states that decisions are the only authority. A V2 change
therefore needs candidate decisions. These enter the register after review.

| ID | Decision | Rejected alternatives |
|----|----------|----------------------|
| DEC-34 | A conversation is a ledger entity. Runs reference it. Components hold no conversation state outside the ledger | In-memory session cache; adapter-side threads only |
| DEC-35 | The partition key is the conversation id. V1-era and replay runs keep the ticket id | Cross-partition locks; a global conversation queue |
| DEC-36 | Conversation history enters the classifier and composer prompts. The gates stay unchanged in scope | History in the composer only; history as retrieved documents |
| DEC-37 | The idempotency key derives from action semantics plus the turn that requests the action | Key from conversation id alone; key from run id (forbidden) |
| DEC-38 | Replay scores first turns only. Multi-turn quality uses online metrics and a human-labelled live cohort | Simulated customers; judge scores on later turns |

Each decision below carries its rationale.

### DEC-34. The conversation lives in the ledger

DEC-04 puts all state in Postgres and forbids component state outside it. A
conversation that spans threads cannot live in one adapter's thread object. Two
threads may sit in different target systems. An in-memory cache dies with the
process and breaks the crash-recovery story.

The alternative "adapter threads only" fails on merge cases. A customer opens a
new ticket instead of replying. Only the ledger can link the two threads.

### DEC-35. The partition follows the conversation

DEC-27 gives exclusive access through one consumer per partition. A conversation
spanning two tickets on two partitions breaks that guarantee. Two consumers can
then run two turns of one conversation together.

Three options exist:

1. Lock the conversation across partitions. This reintroduces a lock service.
   DEC-27 rejected one.
2. Serialize inside the ledger with an advisory lock. This hides a distributed
   lock inside the database and spreads failure modes across call sites.
3. Put every turn of one conversation on the partition of the conversation id.
   One consumer owns each conversation. DEC-27 survives unchanged in form.

Option 3 is the proposal. The partition key becomes the conversation id.
DEC-27 keeps its form: one consumer owns each partition. The current function
is `partitionOf(ticketId, partitionCount)` in `src/coordinator/coordinator.ts`.
V2 changes only the key argument.

One consequence needs plain statement. Every V2 turn hashes on the
conversation id, not the ticket id. Runs of one ticket can therefore land on a
different partition than V1 used. First turns match V1 exactly: fresh run, no
history. Later turns in any thread carry history.

Concurrent runs of one ticket on different partitions stay safe for three
reasons. All turns of one conversation sit on one partition, so the turns keep
their order. Per-ticket epoch fencing (DEC-28) refuses a stale write from any
partition. Idempotency keys (DEC-24) stop a repeated effect on the target.

Cost: a consumer now owns conversations, not tickets. The intake enqueue path
must know the conversation before it computes the partition. Section 5 covers
this.

### DEC-36. History reaches the prompts. The gates do not move

The natural question: does conversation context weaken the evidence gates?

No gate changes its test. Agreement (DEC-05) still samples the classifier nine
times above zero temperature. Groundedness (DEC-07) still checks claims against
retrieved text. What changes is the input those components read. The classifier
sees the prior turns plus the new message. The composer sees the same history.

Two rules keep the gates honest:

1. Groundedness never cites conversation history as support. Only retrieved
   documents count as coverage. Otherwise a confident error in turn one
   certifies itself in turn three. This is the multi-turn version of the
   failure in paragraph 3.2. Option "history as retrieved documents" is
   rejected for this reason.
2. The policy engine (section 4.8) stays a pure function of its current inputs.
   It reads no conversation state. Risk tiers do not learn from history.

One risk remains. Prior turns can pull agreement up on a wrong label. Paragraph
3.2 shows this effect for any correlated input. The second gate exists for
this. Calibration must re-fit the threshold on multi-turn data before V2 goes
live. Section 8 schedules this.

### DEC-37. Turn identity joins the idempotency key

DEC-24 derives the key from action semantics and forbids run identity. Two runs
of one action must produce one key. Consider a customer who asks for a refund
in turn one. The customer repeats the request in turn four after a partial
answer. Are these one action or two?

They are two requests. Each turn is a distinct request by the customer. The key
derivation gains the turn id as a semantic input: "refund requested on turn T of
conversation C". A retry of the same turn produces the same key. A new turn
produces a new key. Run identity stays out of the derivation, so DEC-24 holds.

The rejected alternative "conversation id alone" would collapse repeated
requests into one action. That silently drops the customer's second request.

### DEC-38. Split evaluation by turn number

Replay stays valid exactly where no system reply precedes the decision. On turn
one, the historical record is untouched by the system. So:

1. First-turn routing continues to use replay and dispositions (DEC-32).
   Method 1 survives without change for turn-one cases.
2. Later turns use online measurement only. Approval-edit distance already
   exists and has no counterfactual problem. V2 adds three online metrics:
   containment per conversation, turns to resolution, and repeat contact within
   seven days.
3. Published multi-turn numbers come from a prospective human-labelled cohort
   collected live, not from any simulation.

Section 4.10 rejects judge scores for one reason. A simulator has the same
failure modes as the system it tests. Simulated customers are rejected here for
the same reason. The simulator is weakest where the evaluation matters most.

## 4. Ledger schema changes
Plain SQL under `db/`. The versioned runner `src/ledger/migrate.ts` applies it
through `npm run db:migrate` (V2 open item 6, now closed). A new file takes
the `NNN_name.sql` pattern. The runner records it in `schema_version`, applies
and records in one transaction, refuses out-of-order files, and is
forward-only.

The new tables keep two conventions from the existing files: comments on each
table, and no foreign keys. Both `db/001_ledger.sql` and `db/004_intake.sql`
enforce joins only in application code. The new tables follow that rule.

```sql
CREATE TABLE IF NOT EXISTS conversation (
  conversation_id uuid PRIMARY KEY,
  primary_ticket_id text NOT NULL,
  turn_counter integer NOT NULL DEFAULT 1,
  opened_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'resolved', 'abandoned'))
);

CREATE TABLE IF NOT EXISTS turn (
  conversation_id uuid NOT NULL,
  turn_number integer NOT NULL,
  ticket_id text NOT NULL,
  inbound_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, turn_number)
);

ALTER TABLE run ADD COLUMN IF NOT EXISTS conversation_id uuid;

-- Indexes for the access paths in sections 4, 5 and 6.
-- Ticket-level resolution: which conversation does this ticket join (section 6):
CREATE INDEX IF NOT EXISTS turn_ticket_idx ON turn (ticket_id);
-- Message-level resolution: which turn does a references id hit (section 6):
CREATE INDEX IF NOT EXISTS turn_message_idx ON turn (inbound_message_id);
-- Runs of one conversation join on conversation_id:
CREATE INDEX IF NOT EXISTS run_conversation_idx ON run (conversation_id);

COMMENT ON TABLE conversation IS 'DEC-34: one customer problem across threads. All conversation state lives here, never in components.';
COMMENT ON COLUMN conversation.turn_counter IS 'Next turn number. The intake transaction increments it under the row lock, which serializes turn numbering.';
COMMENT ON TABLE turn IS 'One inbound message of one conversation. turn_counter on conversation assigns the number.';
COMMENT ON COLUMN run.conversation_id IS 'Set for every V2 turn. Null on V1-era runs.';
```

These statements land in a new numbered file, for example
`005_conversation.sql`. The runner skips applied files by their
`schema_version` record.

The intake ALTERs land in their own numbered file, for example
`006_intake_message_key.sql`. That file deploys only with the section 5
release. The runner applies whole files in one transaction and is
forward-only. Step 1 of section 8 therefore cannot exclude the ALTERs if
they share a file with the conversation tables.

```sql
-- 006_intake_message_key.sql: per-message dedupe instead of per-ticket.
ALTER TABLE intake ADD COLUMN IF NOT EXISTS message_id text;
UPDATE intake SET message_id = ticket_id WHERE message_id IS NULL;
ALTER TABLE intake ALTER COLUMN message_id SET NOT NULL;
ALTER TABLE intake DROP CONSTRAINT IF EXISTS intake_pkey;
ALTER TABLE intake ADD PRIMARY KEY (ticket_id, message_id);
COMMENT ON COLUMN intake.message_id IS 'Per-message key half with ticket_id: a repeat message deduplicates, a new message enqueues.';
```

Notes:

- `run.conversation_id` is null for V1-era runs. All existing queries stay
  valid.
- `turn` records which thread carried which turn. The join answers "which runs
  belong to this conversation" without touching the adapters. As in the
  existing tables, the schema does not enforce the join. The writers do.
- The intake backfill copies the ticket id into `message_id` for pending rows.
  Each pending row then keeps a distinct dedupe identity. The ack path
  changes with the key: see section 5. Deploy caution: the intake ALTERs
  travel with the section 5 code, not alone. Applied alone, they break the
  enqueue conflict target and make each ack delete every pending message of
  the ticket.
- No conversation-level epoch table yet. The fencing epoch stays per ticket
  (DEC-28). If review wants conversation-level fencing, that is a separate
  decision with its own rationale.

## 5. Coordinator input model changes
`CoordinateInput` gains two fields. One new interface arrives with them:
`ConversationTurn`.

```ts
export interface CoordinateInput {
  ticketId: string;
  /** Set for every V2 turn. Null only on V1-era runs. */
  conversationId: string | null;
  /** Prior turns, oldest first. Empty on a first turn. */
  history: readonly ConversationTurn[];
  // ...all other fields unchanged
}

export interface ConversationTurn {
  turnNumber: number;
  author: 'customer' | 'agent' | 'system';
  bodyText: string;
}
```

Consequences:

- `partitionOf` becomes `partitionOf(partitionKey, partitionCount)`. V2 callers
  pass the conversation id. The hash function and the count do not change. The
  ticket-id fallback covers V1-era rows and replay runs only.
- The lifecycle has four rules. Intake creates the conversation row when a
  message arrives for a ticket that has none. Intake sets
  `primary_ticket_id` to that ticket: the thread of turn one, immutable. Every
  V2 turn then carries that conversation id, from turn one on. V1-era runs
  keep `conversation_id` null.
- Intake writes the conversation, turn and intake rows in one transaction.
  This keeps DEC-04 intact: the queue seam stays in the ledger.
- The intake key changes from `ticket_id` to `(ticket_id, message_id)`. A
  repeat message deduplicates. A new message of the same ticket enqueues.
- `message_id` holds the source message identity. IMAP uses the Message-ID
  header. Webhooks use the payload `id`. A mail without a Message-ID header
  falls back to the per-mailbox identity: UIDVALIDITY plus UID. Caveat: a
  redelivery under a new UID then enqueues twice. Idempotency keys
  (DEC-24) stop the duplicate effect on the target.
- The message identity rides end to end. The poll returns it. The consumer
  resolves its turn from it. Ack deletes only the matching row.
- Turn numbers come from `conversation.turn_counter`. The intake transaction
  increments it under the row lock. Concurrent messages of one conversation
  therefore serialize.
- Creation has its own guard. Epoch rows are created lazily today: the first
  fenced write inserts them. At a ticket's first message, no epoch row exists
  yet, so a plain lock finds nothing. The intake transaction therefore creates
  it: `INSERT ... ON CONFLICT (ticket_id) DO NOTHING`, then
  `SELECT ... FOR UPDATE`.
- The insert writes epoch 0, below any epoch a run carries. The first fenced
  write then raises it, so the guard never lowers a recorded epoch. This
  retires the lazy-creation invariant at the consumer. Two first messages of
  one ticket then serialize, and one conversation row emerges.
- History size needs a limit. DEC-25 limits cost and steps. Unbounded prompts
  defeat that limit. The coordinator truncates history to the most recent N
  turns by token budget. The values of N and the budget are pinned like a
  prompt version (DEC-26). Exact values arrive during implementation and are
  not decisions.

These parts do not change: the state machine walk, the journal rule, the
limits, the gated branch, the approval bridge. Multi-turn is an input-model
change, not a control-flow change.

## 6. Adapter surface
`IngressAdapter.normalize` currently returns one event. V2 adds a linkage
field to `NormalizedEvent`: which conversation an inbound message joins. The
two reference adapters provide different data. Each derives the field
differently.

IMAP carries message-level linkage. The `in_reply_to` and `references` fields
resolve the parent message, even across threads. The adapter already parses
both. The linkage field derives from the references chain.

The webhook contract carries ticket-level grouping only. The payload holds
`id`, `from`, `author`, `createdAt` and `body`. `in_reply_to` stays null,
`references` stays empty, and the adapter declares `supportsThreading: false`.
The ticket id groups the messages of one thread. The linkage field derives
from the ticket id: a message joins the conversation of its own ticket.

Resolution runs through the ledger, in two steps. The ticket id resolves the
conversation through `turn_ticket_idx`. A references message id resolves it
through `turn_message_idx` (section 4). V2 adds that index for the
message-level path.

Adapters that cannot detect linkage return null. The intake path then starts a
new conversation for the ticket. Autonomy decreases to match capability, per
DEC-06.

Cross-thread linking (customer opens a fresh ticket mid-conversation) needs
message-level linkage. The webhook path cannot detect it. There the link comes
from a person or a future heuristic. This document does not propose one.

## 7. Replay methodology changes

`src/replay/replay.ts` scores decisions against recorded outcomes. Under
DEC-38:

1. The replay job filters to first turns. Cases with a `conversation_id`
   pointing at earlier turns leave the replay set.
2. Removed cases flow to the online metrics pipeline instead. No case is lost.
   It changes scoring method.
3. Gold set handling (DEC-31): the fit/report split applies to the first-turn
   subset. The published V1 numbers remain comparable because the population
   definition narrows explicitly. The artifact schema gains a `scope` field
   with value `first_turn`. The validator rejects any other value, like the
   existing `split_used` guard.

The gold report job currently loads the report half with a fixed count of 385.
That count does not change today. Every committed gold fixture is a first turn:
each `GoldTicket` carries one subject and one body. The generator creates no
prior turns. The new filter therefore removes zero cases, and the report half
stays at 385. Recount the strata only when multi-turn fixtures land.

## 8. Rollout order

1. New tables, columns, indexes and adapters (sections 4 and 6), excluding
   the intake key change. Shippable alone; nothing consumes conversation
   state yet.
2. Coordinator input model, partition key change, and the intake key change
   (sections 4 and 5). The intake key change deploys with the section 5 code,
   in one release (`006_intake_message_key.sql`). The release carries the composite key, the enqueue conflict
   target, the poll's message identity, and the per-row ack. Neither ships
   before the other: the key alone breaks the current enqueue and ack.
3. Prompt changes with re-calibration on multi-turn data (DEC-36 risk).
4. Replay scope change and online metrics (sections 7 and DEC-38).

Each step lands behind the existing test suite. Steps 1 and 2 are safe without
step 3. The history field stays empty until intake populates it.

## 9. Open items for review

1. Ratify DEC-34 through DEC-38 into the register, or amend.
2. Confirm the token budget mechanism for history truncation belongs in the
   prompt pin (DEC-26) rather than a new decision.
3. Decide whether conversation-level fencing is ever needed, or whether
   per-ticket epochs plus one-consumer-per-conversation suffice. This design
   takes the latter position.
4. Repeat-contact window: seven days is a placeholder. Adopters likely need it
   configurable.
5. The gold report count of 385 holds for the committed corpus. Recount the
   strata only when multi-turn fixtures enter the fixture set.
