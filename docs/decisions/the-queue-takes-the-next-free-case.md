# The queue takes the next free case

## Problem

A reviewer takes a case only with the c key on a focused row, or from the case page.
The handoff draws a "Take next case" button in the queue header and a Take on each row.
Neither exists, so a reviewer who wants the next case must first pick one.

The case page also keeps its hold under both columns, outside the main column.
A reviewer reads the case header and cannot see who holds the case or how long is left.

## Proposed outcome

"Take next case" posts a take that names no case.
The server reads the queue the reviewer was reading, with the same filters and the same sort.
It takes the first case in that order that nobody holds.
It passes over a case the reviewer already holds.
It never takes a case over from another reviewer.

A teammate can take a case between the page and the press.
That take refuses, and the server tries the next case, up to ten.
When nothing is free, the server takes nothing, and the queue says so.
Without the holds, take next takes nothing.
Without the reviewer's products, it takes in the queue's own order, and the case says so.

Each row that nobody else holds gets a Take, which holds that one case.
Enter with nothing focused takes the next case, as the button does.

The queue also sorts by risk, by age or by the reviewer's products first.
The sort orders the cases and hides none of them.

The case header shows the hold, its release or takeover, and the case's place in the queue.

The case bar holds the send and one link for each other outcome. Each outcome opens its form in the case.
Cmd+Enter presses the send, and saves an editor with unsaved changes instead.
The approval refuses a reply text that differs from the text the editor drew.

## Affected users and systems

- The queue page and its new controls.
- `POST /take`, which now accepts a take that asks for the next case.
- The case header, which now carries the hold and the position.
- The case bar and its outcome forms.
- `POST /approve`, which now refuses a change to the reply nobody saved.
- `docs/operations.md`, which describes both.

## Constraints

- A take holds a case for one reviewer, and the hold lapses (DEC-46).
- A takeover needs a second, confirmed press (DEC-46). Take next never sends one.
- The product filter and the "my products" order read the product each run records (DEC-47).
- A send applies to the reply as the reviewer was shown it (DEC-46).
- The console owns no SQL. Take next composes the existing take for each candidate.

## Decisions affected

Affects: DEC-46, DEC-47, DEC-48

DEC-46 reserves a case for one reviewer when that reviewer takes it.
This change adds two ways to ask for a take, and changes no rule of the take itself.
Each candidate goes through the same take, which refuses a case somebody else holds.
So take next can reserve only a free case, and it moves no reviewer's hold.

DEC-46 also applies an outcome only to the case as its reviewer was shown it.
Cmd+Enter keeps that rule. In an editor with unsaved changes, it saves them and sends nothing.
The approval keeps it on the server as well. The send posts the editor's text, and the approval refuses text that differs from the text the editor drew.
So a page whose script did not run cannot drop a change nobody saved.

DEC-47 records the product of each run.
Take next and the case position read the same product filter the queue applies.
The "my products" order puts the reviewer's products first. It removes no run from the queue.

DEC-48 lets a reviewer close, snooze or hand over a case, and rewrite a reply.
This change moves those outcomes and the send back from the bar into the case.
The move is layout: each outcome goes to the same reviewers and posts the same form as before.

## Open questions

None.
