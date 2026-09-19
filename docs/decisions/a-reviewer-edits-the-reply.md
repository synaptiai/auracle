# A reviewer edits the reply

## Problem

The console shows the drafted reply and tells the reviewer to edit it in the
helpdesk. The relay then sends the helpdesk copy as it stands. So the text
that reaches the customer is not the text the console showed.

The ledger records an approval-edit distance and an approved reply. A console
approval fills neither with a body, because a body supplied there never
reaches the wire. And some helpdesks cannot send the copy they park at all.
FreeScout has no endpoint that updates a thread. An approved send therefore
posts a second thread and leaves the parked draft standing.

## Proposed outcome

A reviewer edits the reply on the case screen, and the customer receives that
text. The edit distance measures the real change from the draft. DEC-44 is
the row this change ships.

- The ledger holds the reply: `turn.saved_reply_text` while a reviewer edits
  it, and `outbox.reply` on the record that sends it.
- Every approval path sends the text the ledger holds: the console, and
  `pnpm run approve`.
- The adapter declares the operation. `supportsLedgerReply` is true only
  where the helpdesk cannot send the copy it parks.
- A copy edited in the helpdesk is never discarded unseen. The approval
  refuses, shows both texts, and the reviewer chooses. Both choices exist. The
  comparison cuts the reply at a `-- ` line. A change after that line is
  invisible to it.
- The FreeScout adapter declares the capability only when the operator sets
  `FREESCOUT_INTERNAL_NOTE`. The operator sets it after their own instance
  proves it accepts an internal note. Mail keeps the draft path.

## Affected users and systems

The reviewer reads, edits and sends the reply in one tool. The operator keeps
one approval path for the command line and gains a second. Adopters whose
helpdesk can send its own parked copy see no change. Their console still says
the reply is edited in the helpdesk.

The change touches the approval, the relay, the console, the command line,
the egress port and three tables.

## Constraints

- The relay sends first and sets the status second, and it checks the epoch
  at send (DEC-28, DEC-29, DEC-30).
- The idempotency key comes from the action semantics. It never folds in the
  body, so an edited reply derives the key an unedited one derives (DEC-24,
  DEC-49).
- A customer reply carries the adopter's disclosure and its provenance
  (DEC-12, DEC-14, DEC-33). A reply without a disclosure is refused.
- The console holds one write per case. The reply digest it draws decides
  what a later write may replace (DEC-46).
- Nothing infers what a reviewer meant. The console calls no model (DEC-06,
  DEC-43).

## Decisions affected

Affects: DEC-06, DEC-07, DEC-11, DEC-12, DEC-14, DEC-18, DEC-24, DEC-26, DEC-28, DEC-29, DEC-30, DEC-33, DEC-34, DEC-37, DEC-38, DEC-40, DEC-43, DEC-44, DEC-46, DEC-47, DEC-49, DEC-51

DEC-44 is the row this change ships. Its condition decides the shape of
everything below. An adapter declares the capability only when its helpdesk
cannot send the copy it parks. FreeScout meets that condition, because no
endpoint publishes a parked thread. Mail does not, because any mail client
sends any message from any mailbox. The reference helpdesk adapter does not,
because its `sendDraft` publishes the parked copy.

DEC-40 keeps the draft path. An adapter without the capability behaves as it
did. The reply parks as a draft, and the helpdesk copy is what sends. The
console says the reply is not edited here. The relay's draft branch is
unchanged.

DEC-14 and DEC-33 hold on both paths. The park journals the disclosure and
the provenance beside the body, and the capable send attaches both. A park
that holds neither is refused rather than sent without them.

DEC-46's guard now covers more than the approval. A save from a page that
showed other text is refused exactly as an approval from one is. Both reads
run under the run's row lock. The digest is of the text the ledger would
send. That is the saved reply when a person saved one, and the parked body
otherwise.

DEC-49 fixes where the text may not go. The outbox payload is hashed into the
key, so the reply travels in a column of its own. An edited reply then
derives the key its unedited form derives. A second attempt at one turn lands
superseded, rather than sending twice.

DEC-24 holds that rule for the park as well as the send. The park's key is
unchanged, so a retry still finds the copy it created.

DEC-30 governs a failure this path can now produce. A capable adapter
declares no read-back, so an unknown delivery escalates. The relay's
resolution matrix is untouched.

DEC-06's manifest gains a flag, and its rule holds. An adapter declares what
it can do, and the system adapts to the declaration. The policy engine reads
none of it.

DEC-26's pins are what the seeder writes on every step it records. The
provenance a seeded reply carries reads the same two values.

DEC-44's comparison reads the copy once, before the approval opens its
transaction. An edit after that read is seen by nothing, because the relay
compares no copy at the send (DEC-30). So the promise above covers an edit the
approval can see. The runbook states the window, where an operator reads it.

The refusal is a choice, and each branch has a control. Choosing the helpdesk
copy saves it as the reply. Choosing the ledger's reply sends it past the
copy, and leaves the copy alone. That is the only way to send a reviewer's own
text, because this system cannot write into that helpdesk.

The choice carries the digest of the copy the reviewer read, so a copy that
changed since refuses again. A copy a person cleared holds no text, and no
control offers it: `saveReply` refuses an empty reply.

DEC-34 is the shape this path does not touch. A ledger-only park holds no
reply. The approval sends one only where the park carries a customer reply. Every
other gated write goes through `performAction` as it did.

DEC-07's line still decides the callout. It is drawn for a claim the judge
refused and for no other. A claim nobody judged is a different fact.

DEC-11 still parks a gated reply inside the helpdesk. Where an operator has
proved the note, the parked copy is a note, and no customer can be sent it.

DEC-12 still holds. A customer reply waits for a person. A reply with
nothing in it is refused rather than saved.

DEC-18 holds on every fixture this change adds. The tests, the harness and the
wire double are synthetic throughout.

DEC-28's fence is checked before the capable send exactly as before it. The
new branch adds no second order and no second check.

DEC-29 rules the delivery from the record, and the capable branch reads the
same field the draft branch reads. No configuration decides it.

DEC-37's column keeps its meaning: the approval still records the text it
sent. This change adds `saved_reply_text` beside it, and rewrites neither.

DEC-38's turn number still reaches the approval. The key still carries the
turn and the conversation it belongs to.

DEC-43's partition is what the preview draws: every sentence in order, each
with the verdict it was given. The callout edits the reply, never the
partition.

DEC-47's product is untouched. This change edits one test that names it, and
changes no product behaviour.

DEC-51's hold period is not in this change. A console send here is immediate,
and the undo it describes has no path yet. That row ships on its own, and no
issue in this epic carries it. Until it does, a send from this console is the
alternative DEC-51 rejects: an undo after the send. This record cites DEC-51
to say what it leaves out.

## Open questions

The FreeScout capability is off until a person proves it. The proof is an
internal note that a live instance accepts, and it needs the paid API module.
This repository ships neither the module nor a test that claims to reach one.
The runbook states the proof an operator makes before they set the variable.

A refusal shows both texts, and a reviewer chooses. Choosing the helpdesk
copy saves that text as the reply, and the approval that follows sends it.
So the refusal is a choice and not a dead end. The approval compares the two
texts again. A copy that is about to send is not an edit at risk of being
lost. Nothing sends straight from the refusal, so a refusal sends nothing
by itself.
