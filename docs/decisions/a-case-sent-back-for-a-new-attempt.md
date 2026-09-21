# A case sent back for a new attempt

## Problem

A reviewer can approve a reply. They can edit it, rewrite it or close the
case. None of those asks the system to answer again. Sometimes the draft
answers the wrong question, cites the wrong policy or misses a second request.
Then the reviewer either repairs the draft by hand or leaves it in the queue.

The handoff lists "Send back with a hint". Nothing implements it, and two
things block it.

The park key derives from the action, the ticket, the conversation and the
turn (DEC-24, DEC-35, DEC-38). A second run on one turn derives the same key.
An adapter that finds drafts by key then hands the new attempt the draft the
reviewer rejected. So it would answer with the text a person refused.

A console cannot walk the state machine. `coordinateTicket` is not in the
barrel a second interface may import. `console/src/select-only.test.ts`
refuses every ledger write the console does not name. So the console cannot
start the run itself.

## Proposed outcome

A reviewer sends a waiting case back with a note. The turn is attempted again,
and that note is an instruction to the new attempt.

- The attempt is part of every key of its turn. The first run of a turn is
  attempt 1, and only a person's request starts another. A crash retry stays
  in its attempt. A redelivered message stays in its attempt too. So neither
  returns to the rejected draft's key.
- The turn holds the attempt it is on (`turn.attempt`). A send-back raises it
  in the transaction that ends the attempt. The queue, the scan and every
  writer of the turn read that one value. Nothing counts runs to decide it.
- The console writes the request. The consumer that owns the conversation's
  partition starts the attempt. The rejected run ends `superseded`, with the
  moment the reviewer asked and the note they wrote. The scan reads that
  marker on every pass.
- The send-back is offered only where no helpdesk copy of the reply exists that
  a person could send. A reply the ledger holds qualifies (DEC-44). A park
  that created no draft qualifies too. A draft on the DEC-40 path does not.
- A turn waits for one attempt at a time. A second request on a turn that
  already waits is refused. Two reviewers cannot start two attempts whose
  notes only one of them would read.
- A queued message waits while its turn is on an attempt that has not landed.
  The scan starts that attempt with the note. The message then runs as an
  ordinary retry of it.
- The reply a person saved on the turn is cleared by a send-back. It is
  cleared in the transaction that ends the attempt. The approval prefers the
  saved text over the park body (DEC-48). Leaving it would make the new
  attempt inert. Its reviewer would approve the new reply, and the customer
  would receive the older one. What was cleared is recorded on the journal
  row.
- A send-back also needs a turn with no record that closes it. A `pending`,
  `sent`, `fenced` or `delivery_unknown` row closes the turn. Each is a reply
  that reached the customer, may have, or will. Only a `malformed` row leaves
  it open, because the relay will never send it.
- The note reaches the composer as an instruction. It reaches nothing else.
  The classifier and retrieval never see it. So it cannot become a label or a
  retrieved span, and it never counts as coverage (DEC-37).
- The rejected attempt keeps its record. Its reply stays where the park put
  it. Its journal rows stay. The day's counts treat the turn as one case, from
  the attempt that ended it.

## Affected users and systems

The reviewer asks for another answer in their own words. The case leaves the
queue while the new attempt runs. The send-back itself sends nothing to the
customer. The new attempt parks for approval as any reply does.

The change touches the run row: the attempt, the moment and the note. It
touches the key derivation of five writers, the consumer's scan, the control
bands and the latency report. It touches the conversation view's wording. It
adds one console write, with its route and its bar.

## Constraints

- The attempt is action semantics. It says what a person asked for. It never
  derives from the run id (DEC-24). A digest of the composed body fails as the
  discriminator. A crash retry retrieves again, and a document can pass its
  review date between the two retrievals. So the retry would compose other
  text, derive a second key and park a second draft.
- The first attempt derives the key its turn always derived. Every run written
  before this change is attempt 1. A park journaled before it still matches
  the approval that follows it.
- The count of attempts has no ceiling. A turn may be sent back as often as
  reviewers ask, and each attempt ends the one before it. What bounds the work
  is the reviewer's own time, and the record every attempt leaves.
- Two conditions, and each is its own refusal. A copy a person could send is
  answered: send it there, or write the reply here first. A turn that may have
  reached the customer is answered: a new attempt would answer it twice. One
  sentence for both would send the reviewer to a page that refuses them again.
- A `pending` row closes the turn because it is an approved reply that will
  go out. The reachable one is a sibling's send, held for the DEC-51 window.
  Leaving the turn open there put two replies on one turn: the held one, and
  the new attempt's. A reviewer who wants a new attempt over a held send
  undoes the approval first. The undo deletes the pending row.
- The new attempt walks the machine from the top. It classifies, retrieves and
  composes again. The request exists because the answer was wrong.
- An attempt can die on its way through the walk. It then leaves a run in an
  active state, with nobody walking it. The request stays due. The scan reads
  the states that landed, and not the attempts that were made. So the next
  scan retries the same attempt, with the keys the dead one derived.
- Five failures of one turn end it. The escalation is a fresh run. It is
  filed at the ticket's current fence, in the shape the queue's abandonment
  uses. A dead attempt's state is in flight, so the fence governs it. A bump
  moves the fence above it. A bump comes from a new run on the ticket or a
  consumer restart. Ending the dead attempt would then be refused on every
  later scan, and the turn would be served by nobody. The dead attempts keep
  their own spend and step counts, because nothing writes to them.
- A turn that holds no question is escalated rather than walked. A turn
  recorded before db/010, or one whose text was erased, has no question for
  the attempt to answer. The note is not one (DEC-37). An attempt walked
  there would spend a classifier, a retrieval and a composition on nothing.
- The scan serves a bounded number of requests per pass, after the poll. A
  re-attempt is a whole walk with the provider in it. A queued customer
  message must not sit behind a backlog of them.
- The run that ends a send-back is `superseded`. The state machine already had
  that state. No state is added, so no reader of the state vocabulary changes.
- A send-back releases the case hold, under a kind of its own. The case leaves
  the queue for good, because a later attempt is a new run. The team's hold
  history is what tells a case that was closed from one that was sent back.
- The note is bounded at 1000 characters, as the close's reason is. The form
  carries the same number. A note with a NUL or a lone surrogate is refused by
  name. It is not left to raise inside the write.
- The conversation view draws the number of runs that worked a turn. A
  send-back is now one of the two reasons it exceeds one. The comment beside
  it says both. The drawn number is true either way, and the old sentence
  misled a reader of the code.
- A redelivered message joins the attempt its turn is on. Two runs of one
  turn can therefore carry the same attempt number. They are one case. The
  day counts the newest of them. The tie is broken by the run's own identity,
  so the answer cannot depend on a plan.
- Every decision about a turn's attempt is ordered on the turn row's lock.
  The send-back raises the attempt under it. The approval, the save and the
  rewrite read it under it. Each refuses a run on an attempt a reviewer
  rejected. Without the lock, two reviewers could each act on the same attempt
  in the same instant.
- The lock order is run, then turn, for every writer of a turn. Intake takes
  the conversation, then the turn. No writer takes a turn and then a run. So
  the send-back does not end the other runs of a rejected attempt itself. The
  scan ends them, each in a transaction of its own.
- A turn takes one reply. The approval refuses a reply on a turn that
  already holds a reply's closing record. It reads that under the turn row's
  lock. So a
  second reply cannot be approved, whatever path created the run or the
  record. A twin run of the turn is refused here too, rather than on the key
  collision. The consumer's scan then ends it, so it does not wait for ever.
  Someone may undo the approval that closed the turn. Its own run then
  returns to the queue, and the case is approvable on it. The ended twin does not return. It
  held the same attempt and the same reply. The maintainer chose this guard
  on 2026-09-21.
- A compensation is not a reply (DEC-34). Its record does not close the turn
  to a reply, and a reply's record does not refuse it.
- A record on a run with no turn number closes no turn. It answered some
  message of the conversation, and nothing says which. Such runs exist:
  db/015 added the turn number after db/008 added the conversation.
- A turn with no text can still be attempted again. A held redelivery holds
  the customer's words, and the scan walks with them and the note.
- The scan drops a request when a record closes the turn. The console
  refuses a send-back on a closed turn and an approval of a rejected attempt.
  Another path can still write a closing record. Examples are a run of the
  conversation with no turn, a seed and a replay. The scan escalates the turn
  instead of walking it, so a person sees why.
- The scan can end a request without a walk. The turn's held messages then
  leave the queue with the escalation, unless the turn holds no text. Then no
  held message has any text either. A held message is the only copy the
  queue has, so it stays. The removal reaches that turn alone,
  and the journal row records how many messages left. Two owners can reach
  this at once during a rebalance. The fence's lock orders them. The second
  reads the attempt as landed and files nothing.
- The queue files the abandonment of a message at the attempt its walks were
  at. It does not use the turn's attempt at the moment it gives up. A reviewer may send the
  case back while the walks fail. Filed at the new attempt, the abandonment
  would land it, and the note would reach no composer. The escalation lands the attempt, and
  that is what releases a held message. A released message would walk the
  attempt the scan stopped.
- The note must hold a visible character. The check removes format
  characters, such as a zero-width space. It does not catch every blank
  glyph, such as a Hangul filler. A reviewer who types one sends an empty
  instruction, and that is not a risk this bound defends against.
- The first condition reads the adapter's declaration. That is the console's
  own statement about its helpdesk, not something the ledger records. It is
  the same input the approval and the relay read (DEC-06). The relay
  escalates the same disagreement, and this write refuses on the side the
  declaration names. The failure mode is a console and a consumer that
  disagree about `FREESCOUT_INTERNAL_NOTE`. No column distinguishes a
  sendable draft from an unsendable note.

## Decisions affected

Affects: DEC-04, DEC-11, DEC-12, DEC-14, DEC-24, DEC-26, DEC-27, DEC-28, DEC-30, DEC-34, DEC-35, DEC-37, DEC-38, DEC-40, DEC-42, DEC-44, DEC-45, DEC-46, DEC-47, DEC-48, DEC-49, DEC-51

DEC-49 is the row this change ships. A reviewer may send a case back for a new
attempt. No helpdesk copy of its reply may exist that a person could send. The
attempt is part of every key of its turn.

DEC-38 is superseded in part. It puts the turn in the key, so that two turns of
one request are two requests. This change puts the attempt inside that turn
segment. So two attempts of one turn are two requests as well. A caller that
names no attempt, and one that names attempt 1, derive the same key DEC-38
defined.

DEC-24 is stated and not changed. The key still derives from action semantics.
The run id is still forbidden, and the assertion that refuses one still runs.
The attempt is a semantic field, and the derivation shows it.

DEC-04 is stated. The send-back journals who asked, what they asked for and
which attempt they ended. It journals those in the transaction that ends the
run.

DEC-12, DEC-14 and DEC-40 are stated rather than changed. The send-back sends
nothing to the customer. The new attempt's reply parks for a person, as every
customer reply does.

DEC-11 governs the helpdesk copy, and it decides the first condition. Where
the adapter's helpdesk can send the copy it parks, the reviewer may already
have sent it. Nothing here can see that.

DEC-44 governs the adapters whose ledger holds the reply. Those cases qualify
for a new attempt, because no copy a person could send exists. DEC-34 decides
which parks qualify without a draft handle. A ledger-only park holds an action,
and the helpdesk holds nothing to send.

DEC-30 is stated. `delivery_unknown` closes the turn, as it escalates the run
that produced it.

DEC-27 and DEC-28 are stated. The consumer that owns the conversation's
partition creates the new attempt. The attempt asks the ledger for its own
fencing epoch, under the ticket row lock. The send-back's own write is a
parked write: it takes the run's row lock, and no fence.

DEC-35 is stated. The turn joins the attempt, because an attempt number alone
is not unique across conversations on one ticket.

DEC-37 is stated, and the note is written to respect it. The note is an
instruction and never a retrieved document. So it can never count as coverage.

DEC-26 is stated. The composer's prompt is pinned. A run with no note sends
the prompt it always sent, byte for byte. A note is rendered only where one is
present.

DEC-42 and DEC-45 are stated. The journal row names the reviewer, and what the
name proves, as every console outcome does.

DEC-47 is stated. The new attempt carries the product the rejected run
recorded, so it retrieves the documents of the same product.

DEC-46 is stated. The send-back carries the digest of the reply the page drew.
It refuses when the ledger holds another one, as the close, the snooze and the
rewrite do.

DEC-48 is stated. The send-back is one more outcome, and the jobs count it for
what it is. The day counts the turn once, from its final attempt. The latency
report keeps a rejected attempt in a class of its own.
