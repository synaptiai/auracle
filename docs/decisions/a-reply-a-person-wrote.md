# A reply a person wrote

## Problem

The gate judges the drafted reply. It records a groundedness coverage and a
claim verdict for each sentence. The case page draws both beside the reply.

A reviewer can already replace that text. One way edits the reply the ledger
holds (DEC-44). That keeps the model's words and measures how far the person
moved from them. Another way writes a reply from scratch. The handoff lists
it, and nothing implements it.

Both would leave the same defect. A reply a person wrote reaches the customer
under the model's provenance. The trailer names the model and the prompt that
produced the draft. The case page draws the draft's coverage beside the
person's words. So the system reports the model's work as the person's, on
the surface whose reader acts on it.

## Proposed outcome

A reviewer rewrites a waiting case's reply from scratch. The ledger then
knows a person wrote it.

- The case page carries the rewrite under the approval, behind a link. It is
  offered only where the adapter's ledger holds the reply (DEC-44). Anywhere
  else, a reply written here would reach nobody.
- The turn holds the person's text. The drafted body stays in the journal. It
  is the record of what the model wrote, and what the approval measures its
  edit distance against.
- The send carries the adopter's disclosure and a provenance that names a
  person. It names no model and no prompt. A drafted reply keeps its own
  provenance, unchanged.
- No surface reports the gate's coverage for the reply. That covers the case
  page, the queue and the escalations list. The gate row keeps its verdict,
  and that verdict belongs to the draft.
- The citations stay. They hang off the compose and retrieve rows. So the
  reviewer keeps the sources the draft rested on.

## Affected users and systems

The reviewer writes a reply and sees it drawn as theirs. The draft sits under
it as what it replaced. The customer receives the person's words with the
adopter's disclosure, under a trailer naming no model.

The change touches one write and the provenance a reply can carry. It touches
the journal reader and four reads that report coverage. It moves no state. A
rewrite is not an outcome until something sends it. The approval, the relay
and the adapters then send it as they send any ledger-held reply.

## Constraints

- The rewrite declares itself. One reviewer deletes every sentence and writes
  their own. Another replaces the whole body after reading it. The text cannot
  tell either from an edit. So the act says which it is, and the ledger infers
  nothing from a distance.
- The ledger keeps the drafted body. DEC-04 journals what the run did, and the
  edit distance is measured against the parked body. Clearing that record
  would destroy both. The reply becomes the person's, and no surface presents
  the draft as it. That is what "clears the draft" means here.
- The author travels with the text, on the turn. A turn is served by every run
  that answers it. A retry after a crash parks a second run on one turn, and a
  send-back will too. The approval reads the text and its author in one
  statement, and its guard compares both under the lock. Reading the author
  from the approving run alone sent a person's words under the model's name
  (DEC-33, DEC-35).
- A save after a rewrite keeps the author and refreshes the moment. The reply
  is the person's from the first rewrite on, and the trailer prints when they
  last wrote it.
- A provenance names the model and the prompt, or names neither. A person's
  reply carries `generatedBy` and `generatedAt`. A model's carries four
  fields. The relay refuses a record holding half of the second shape, and one
  that names no model and no person. A reply reported as partly a model's must
  not reach a customer.
- The text must be one the ledger stores. Postgres raises on a NUL. The
  driver silently replaces a lone surrogate. Either way the customer would
  receive other text than the reviewer sent. Both are refused by name, and the
  save carries the same rule: one helper, three writes.
- The reply is bounded nowhere in the core. The console's form caps it, and
  nothing else does. The close bounds its reason and a reply has no such
  bound; an adopter that needs one needs a decision.
- The write takes the run's row lock and requires `awaiting_approval`. The
  guard is the save's and the approval's (DEC-46). A page that drew other text
  does not replace it. The write moves no state, so it takes no fence
  (DEC-28). A park that holds no reply is refused too (DEC-34). Its approval
  performs an action, so a reply written there would reach nobody.
- The gate's record is kept, and the run item still carries its number. The
  queue groups on it, which decides the cases one press can confirm. A
  rewritten case is one a reviewer can send. Withholding the number dropped it
  out of the batch in silence. No surface prints the number beside
  the reply. The row says a person wrote it, and the pages withhold it.

## Decisions affected

Affects: DEC-04, DEC-11, DEC-12, DEC-14, DEC-18, DEC-28, DEC-33, DEC-34, DEC-35, DEC-42, DEC-44, DEC-45, DEC-46, DEC-48

DEC-48 is the row this change ships. A reviewer may rewrite a reply the ledger
holds, and each job counts the outcome for what it is.

DEC-33 governs the provenance, and this change adds its second shape. A
customer reply names the model and the prompt. Or it names a person and
carries neither. The relay and the text trailer read both. Each refuses a
record that names half a model.

DEC-04 is stated and not changed. The rewrite journals who wrote it, what the
name proves and the digest of the reply it replaced. The drafted body stays
where the park wrote it.

DEC-14 is stated too. The person's reply keeps the disclosure the adopter set.
The approval refuses to send without it, as it always has.

DEC-12 is stated rather than changed. A reply with nothing in it is not a
reply. The rewrite refuses one as the save refuses one.

DEC-18 governs the fixtures. The new suite and the cases it adds are
synthetic, as every suite here is.

DEC-34 decides which parks a rewrite may touch. A park that holds an action
rather than a reply is refused. Its approval performs that action, so a reply
written there would reach nobody.

DEC-35 decides that the author belongs to the turn. Every run that serves a
turn sends the same reply. Reading the author from a single run named the
wrong one.

DEC-44 decides where a rewrite is offered. Only where the ledger holds the
reply does a reply written in the console reach the customer. So the control
is drawn under the declaration the editor is drawn under.

DEC-46 guards the write, as it guards the save and the approval. The digest of
the reply the page drew is compared under the run's row lock.

DEC-45 and DEC-42 record who wrote it, with what the name proves.

DEC-11's boundary is unchanged. The console writes on the ledger, never on the
target system. The helpdesk's copy of the draft is governed by the adapter's
own retention.

DEC-28 is stated: a rewrite moves no state, so no fence governs it.

## Open questions

A rewrite does not clear the helpdesk's copy of the draft. The draft parks
there as well, and the adapter's retention governs it. An adopter who needs
that copy removed needs an adapter capability this change does not add.

The console offers one empty field. An adopter who wants the draft's text as a
starting point uses the editor. It seeds the field. Both controls sit on the
same page for that reason.
