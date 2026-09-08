# Intent: the console is usable for triage

## Problem

A usability pass over all seven console surfaces found three defects and two
gaps. Every count below is measured against a seeded ledger of 761 runs.

The approval queue's reason can never carry a value. It reads the `escalate`
journal row, and a run awaiting approval has not escalated. All 161 waiting
rows printed "no reason journalled". The gate rule was on every one of them.

Every run reported `steps 0` beside a step journal listing five entries. Two
numbers about one run, on one screen, disagreeing.

51 of 161 waiting runs could not be approved. They park in the ledger under
DEC-34, and `approveRun` relays them through the journalled payload.

No surface showed time. The runs list said "newest first" and the approval
queue said "the oldest is on it". Neither showed a date.

The queue offered no filter and carried no intent and no coverage.

Every seeded ticket was one broken template. Every conversation held one turn,
and no approved reply text was ever written.

## Proposed outcome

A person opens the queue. Each waiting run says what it is about and why it
needs them. It says how well the reply is grounded and how long it has waited.
They narrow the queue to one gate rule.

Every run is approvable that the ledger can approve.

Every surface that orders by time states the time.

A seeded ticket reads as a message a person wrote. A seeded conversation holds
a thread. A seeded approval records the reply that was sent, and a distance
that measures it.

## Affected users and systems

The person working the approval queue. The operator reading the runs list.

`src/escalations/query.ts` gains the fields. The console reads them. The
seeder writes a history that demonstrates them.

## Constraints

- The console owns no SQL (issue #27). Every new field comes from the query
  module the CLI reads through.
- `console/src/select-only.test.ts` holds the console to SELECT statements.
- Approving a ledger-parked action changes no approval rule. `approveRun`
  already refuses a park carrying neither a handle nor a payload.
- DEC-18 forbids a real address, telephone number, name or account identifier
  in any fixture.
- The planned history must not move. `plan.test.ts` pins it with a digest,
  because `docs/v1-architecture.md` cites its utilisation, its waits and its
  depth ratio as evidence.
- The committed corpus stays byte-identical to its generator.

## Decisions affected

None. Every change is an implementation detail. It obeys DEC-11, DEC-12,
DEC-18, DEC-34, DEC-35, DEC-36, DEC-37, DEC-38, DEC-40 and DEC-42.

## Open questions

None.

A second turn answered by a run would move the planned history. That run would
take the partition of the conversation it joined (DEC-36), and the queue
simulation would change with it. So a seeded follow-up carries no run. The
customer wrote again while the first reply waited. The conversation surface
already names that state, and no seeded ledger could reach it.

Control bands were reported as blank of findings. That reading came from a
14-day seed. The default is 45 days, and it reaches a verdict on all four
metrics.
