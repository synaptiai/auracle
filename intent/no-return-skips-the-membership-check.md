# Intent: No return skips the membership check (DEC-35)

## Problem

`742b616` added a short-circuit to `resolveConversation`. A message whose id
already held a turn returned that conversation at once, with no membership
check. The commit called the block defence in depth and recorded that reverting
it failed no test.

It was not defence. It was the only path in that function that skipped DEC-35,
and it was a hole.

The message id is supplied by the sender on both ingress paths. On the mail
path one email is enough. Set the Message-ID header to the victim's root and
send no References. Both the ticket id and the message id match the
victim's turn.

The attacker's message then resolved to the victim's conversation and the
victim's turn number. Its text ran through the pipeline inside that
conversation. The approved reply overwrote the victim's turn row, which
every later prompt reads.

A second hole came from the same commit. A conversation that names nobody
accepted every sender for ever. So once one existed on a ticket it absorbed
everyone the other conversations refused. Their messages mixed.

Third, the permanent-error class reached one refusal in the mail egress and
not the two beside it. So those still spent the whole attempt ceiling on a
case that can never clear.

## Proposed outcome

Every return from `resolveConversation` passes `senderMayJoin`. The
short-circuit is gone, and a comment says why it must not come back.

A conversation that names nobody is claimed by the first sender that names
itself. It never overwrites a recorded participant, so the claim cannot take a
conversation over.

Every permanent refusal in the mail egress throws `PermanentEgressError`, so
the run escalates on the first occurrence.

## Affected users and systems

Intake, and the mail egress.

## Constraints

DEC-35 governs conversation membership. No shortcut may bypass it, however
convenient the evidence looks.

An address is evidence, not proof. A forged From still passes; this closes the
paths that need no forgery.

## Decisions affected

Obeys DEC-35. Corrects an implementation detail of `742b616`.

## Open questions

A conversation is claimed by its first named sender. A customer who opens a
thread from one address and continues from a second gets a second
conversation. Their history does not follow them.
