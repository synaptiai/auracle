# The ledger names who saved a reply

## Problem

A reviewer can edit the reply the ledger holds, save it, and approve it later
(DEC-44). The approval then sends the saved text. The ledger records who
approves a reply and where that name comes from (DEC-45). Without this change
it records nobody for a save. Only a log line names the reviewer, and no test
reads it.

So the ledger cannot say whose words an approval sends. Two reviewers can
work one case in turn. One saves an edit, and the other approves it.

An undo records its reviewer and not where that name comes from. Every other
outcome records both.

The register also does not say which earlier rows a later decision replaces.
Only the record that adds DEC-44 to DEC-51 says so.

## Proposed outcome

- A saved reply records its saver and the source of that name, beside the
  text, on the turn.
- A later save replaces the text and the saver together. A rewrite records its
  writer the same way. A send-back that clears the text clears its saver, and
  its journal row names whose words it cleared.
- The database refuses a saver without a source, a source outside the
  vocabulary, and an empty name.
- Every writer of a reviewer's name derives the name and its source one way.
  So no writer records a name beside `none`.
- An undo journals the source of its reviewer, as a close or a snooze does.
- The register gains a table of the rows a later decision replaces in part.
  No row's text changes.

## Affected users and systems

- Migration 039 adds two columns to `turn`.
- `recordSavedReply`, `saveReply`, `rewriteReply` and the send-back write them.
- The console passes the reviewer it resolved, as it does for an approval.
- `undoApproval` and the send-back record journal a checked name and source.
- Section 2 of `docs/v1-architecture.md` gains the table.

## Constraints

- One statement writes the pair with the text, as it writes the provenance
  (DEC-48). Neither can move without the other.
- The pairing rule is migration 018's rule for the approver. One clause more
  refuses an empty name.
- A turn saved before migration 039 has text and no saver. That reads as
  unknown, because no record of the name exists.
- A saver may stand beside no text. Adopters run a retention purge that clears
  the text alone, and refusing it would stop it erasing customer text (DEC-17).

## Decisions affected

Affects: DEC-11, DEC-14, DEC-17, DEC-18, DEC-24, DEC-33, DEC-36, DEC-38, DEC-40, DEC-42, DEC-44, DEC-45, DEC-48, DEC-49, DEC-51

DEC-44 lets the ledger hold a reply a reviewer edits. This change records who
saved that reply. What the save writes, and what the approval sends, do not
change.

DEC-45 records where each approver's name comes from. A saver is the author
of the words an approval sends, so the same record now covers the save. The
console supplies the name it checked against the roster, and records `roster`.

DEC-42 governs a name a caller supplies. The undo and the send-back record now
pass that name through the same check as every other writer.

DEC-48 lets a reviewer rewrite a reply. A rewrite writes the saved text, so it
records its writer in the same columns.

DEC-49 lets a reviewer send an attempt back. The send-back clears the saved
text and its saver. Its journal row keeps the cleared text, and the name and
source of who saved it.

DEC-51 makes an undo return the run to approval. Its journal row now records
the source of its reviewer's name. What the undo does is unchanged.

DEC-17 makes the data guarantee configurable and documented. The runbook's
purge clears the saver with the saved reply. A purge that clears the text alone
still runs. The runbook names the new columns and journal keys.

DEC-11, DEC-38, DEC-40 and DEC-42 keep their rows' text. The register's new
table says which part of each a later row replaces: DEC-44, DEC-49 and DEC-45.
The record that adds DEC-44 to DEC-51 ratifies each replacement.

The new tests cite DEC-14, DEC-18, DEC-24, DEC-33 and DEC-36, as what they
check or rely on. The end-to-end case checks the disclosure and the
provenance a reply carries (DEC-14, DEC-33). The idempotency key and the
partition it reads derive from the conversation (DEC-24, DEC-36). Its data is
synthetic (DEC-18). None of them changes.

## Open questions

None.
