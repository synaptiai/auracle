# Intent: The operator console

## Problem

The repository has no interface. `pnpm run approve` is a command line. An
operator inspecting a run writes SQL, and `pnpm run bands` and `pnpm run
latency` print artifacts nobody reads at a glance.

So nobody can watch one message go end to end without reading code.

## Proposed outcome

Five surfaces read the ledger: runs, one run in detail, the approval queue,
the control bands and the partition latency. A person approves a parked
draft from the queue.

## Affected users and systems

An operator gains a second approval path. The command line keeps working and
stays the reference.

The repository becomes a workspace. `pnpm-workspace.yaml` said it was one
package on purpose, and that comment changes here.

## Constraints

- DEC-11 rejected "a Slack queue; a new web queue" by name. Section 4.2
  says adopters do not install a new interface. DEC-40 permits this console
  and keeps the parking rule. The draft lives in the helpdesk, and this is a
  second approval path, never a second parking path.
- The console never parks. `parkGatedReply` keeps calling `adapter.createDraft`.
- DEC-05 keeps the two gates independent. No screen combines agreement and
  coverage into one score, and no function offers one.
- The console owns no SQL. It reads through the query modules the jobs use, so
  a metric has one definition.
- No dependency enters the core package, and the console adds none of its own.
  It only uses `node:http`, as `src/ingress/webhook-server.ts` already does.
- DEC-18. No real data.

## Decisions affected

Affects: DEC-11, DEC-40

DEC-11 and DEC-40. Both are obeyed and neither changes. DEC-40 was ratified in
PR 30 and already permits exactly this, so no register row is written here.

## Open questions

The console authenticates nobody. It checks that a request came from one of
its own pages. It answers only the hosts it was started for, which is what
defends the approval. Who may reach it at all is the adopter's to decide, and
no decision in the register covers it.

The gate values are not shown. The escalation module reports what a person
needs to work the queue and does not carry them. So both surfaces render them
as not read. Reading them needs a journal query no module offers today.
