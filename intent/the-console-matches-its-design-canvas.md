# Intent: the console matches its design canvas

## Problem

The operator console ships the design canvas's tokens and none of its layout.
`console/src/css.ts` held `css.txt` alone, which is the shared palette. Each
artboard carries its own `<style>` block, and none of those blocks shipped.

So the page rendered as unstyled flow. The markup named `shell`, `side`,
`card`, `gates`, `mut` and `outcome`, and no rule defined any of them. Of the
five classes the stylesheet did define, two were never used.

Three further gaps sat behind that one. The console offered no filter, so an
operator read 200 rows to find the gated ones. It rendered a full card for
every waiting run, so a queue of 476 produced a page of 8 MB. It defined a
light palette that nothing could reach, because no element carried
`data-theme`.

The run detail surface showed two em dashes where the gate values go. The
values are in the ledger and nothing read them.

## Proposed outcome

The console looks like the canvas that settles its contents.

Every surface carries the layout its artboard draws: the rail, the filters,
the tables, the metric cards, the percentile bars. A person reads the queue,
the bands and the latency without reading a line of code.

The run detail shows what the ledger recorded as the run walked. The two gates
carry their values and the thresholds that were applied. The retrieved
documents carry their titles.

Two blocks the canvas draws do not ship, because no data supports them. The
step journal carries no timestamp, so no step has a duration. The retriever
stores ranks nowhere, so no document has one.

The synthetic history exercises what the console displays. `pnpm run
seed-history` journals the whole step set, so every surface has rows to draw.

## Affected users and systems

An operator reads the console. The console is the only consumer of the new
journal reader.

The seeder writes to a ledger an adopter may share with real traffic. Its runs
already carry `seed` pins, and that stays the discriminator.

`src/bands/query.ts` reads three fields the seeder writes. Those three keep
their values. The approval edit distance changes scale, because the seeder
wrote it out of scale.

## Constraints

The two gates stay apart on every screen and in every artifact (DEC-05). No
function takes both and returns one number.

The retriever fuses ranks and never scores (DEC-21). The console shows the
recorded order and calls it that. It shows no rank.

Customer replies keep their approval (DEC-12). The draft parks in the helpdesk
and nowhere else (DEC-11, DEC-40). The console adds a second approval path and
never a second parking path.

Every fixture stays synthetic (DEC-18). No real name, address or account
identifier reaches a document body or a draft.

The console names no SQL. It reads through query modules in `src/`, and
`console/src/select-only.test.ts` holds that structurally.

A quantity that could not be measured is reported as unmeasured. It is never
reported as zero.

## Decisions affected

DEC-05 and DEC-21 govern the display and this change obeys both. DEC-11,
DEC-12, DEC-18 and DEC-40 bound the approval path and it does not move.

The new journal reader is an implementation detail. It reads what the
coordinator already writes and changes no behaviour.

The seeder change is an implementation detail. It writes more of what the
coordinator writes, and it corrects a column the seeder wrote out of scale.

## Open questions

None. Two of the canvas's blocks cannot be built from stored data, and
`docs/operations.md` names both.
