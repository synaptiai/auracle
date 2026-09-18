# The console answers to a roster

## Problem

The console authenticates nobody. Anyone who reaches the port can approve a
reply, and the rail can only show the name a header claimed. The ledger
records that claim in `run.approved_by`. That column cannot separate a
person a proxy authenticated from any caller that set a header.

An incident therefore cannot separate the operator from anyone else who
reached the port. A four-person queue makes that worse: two people can work
the same case, and nothing names who did what.

## Proposed outcome

A roster of reviewers decides who may use the console. A trusted proxy
authenticates the identity. The console checks it against the roster, and
refuses a request with no roster identity before any page is built. The
ledger records the name and where it came from.

- The roster is a list a maintainer changes from the command line: add,
  deactivate, list.
- Every request needs an identity, reads included. A page a person cannot be
  named for is a page nobody serves.
- The approval records the reviewer and the source of the name: the roster, a
  header claim, or nobody.
- Local development may name a reviewer with no proxy. That works only when
  the process runs the TypeScript source on the loopback address. Any other
  bind refuses to start, and the image never runs that way.

## Affected users and systems

The four reviewers, and anyone operating the console. The console process,
the approval path, the ledger's `run` table, and the `.env.example` that
names the variables. No customer-facing behaviour changes.

## Constraints

- DEC-45: the console serves nothing to a request with no roster identity.
  It also says the ledger records where each approver's name came from. This
  record is that change.
- DEC-42: a name a caller supplies is a claim, and the ledger keeps only what
  the rules allow. The command-line approval keeps that path, and its names
  now read as claims.
- The console holds no password, session or magic link. A trusted proxy
  authenticates; the console only checks the result.
- The single-write rule holds. The roster is read on every request and
  written only by a command-line tool.

## Decisions affected

Affects: DEC-18, DEC-42, DEC-45

DEC-45 is the decision this change ships. It moves the console from a claim
to a roster. It asks the ledger to keep the source of each approver's name.

DEC-18 governs the seeded ledger this change touches. The roster ships empty,
because a seeded reviewer would be a name nobody in that deployment
recognises. The seeded history records `unattributed` with the source `none`.

DEC-42 governs every other caller, and it does not change. A command-line
approval still records what its caller named, and now labels it as a claim.
A name that fails the rules still records `unattributed`, which reads as
`none` beside its source.

## Open questions

The roster decides who may review, not what a reviewer may do. Every active
reviewer has the same powers until the reservation in issue #107 ships.
