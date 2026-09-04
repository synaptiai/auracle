# V2 roadmap

Section 7 of [the decision register](v1-architecture.md) lists the open items
for V2. That list is short on purpose, because other documents
cite its numbers, and the numbers must not move.

This document carries the explanation. For each open item it answers five
questions:

1. What does the item ask for?
2. What blocks it?
3. Who owns each blocker?
4. What has already shipped toward it?
5. What is the next step?

Nothing here is a decision. A document becomes a decision only when a row
enters the register's table in section 2. Where design material already exists
under `.creatumo/design/`, this document reports it and names its status.

Four items stay open: 1, 4, 5 and 7. Items 1, 4 and 5 have never closed.
Item 7 has its measurement and not its correction, so it has a section of its
own below the other three.

---

## Item 1. The criteria to leave Phase 2

### What the item asks

Phase 2 runs the system live with gates. Internal writes go automatically, and
each customer reply waits for a person (DEC-12). The item asks when a reply may
send with no person approving it.

### What blocks it

Three blockers, and each has a different owner.

**B1. The register binds.** DEC-12 states that a customer reply always needs
approval. A reply is not reversible, because the customer reads it and acts on
it. No code change moves this. Only a person amends the register.

**B2. No exit decision exists.** Section 5 states that the criteria to leave
Phase 2 need a decision the register does not make. The design document
`899a1565-de05-44ce-8693-ed6dd4cb97e3.md` proposes eight criteria, C1 to C8.
They cover volume, edit distance, a human audit of unchanged sends, a
groundedness floor, person-set eligibility, disclosure, an adapter floor and a
daily cap. They stay a proposal until a row enters section 2.

**B3. No production data exists.** The four baselines in `bands.yaml` stay
null. They fill only from an adopter's own traffic, and this repository ships
synthetic fixtures only (DEC-18).

### Who owns each blocker

| Blocker | Owner |
|---|---|
| B1, the register binds | The maintainer, through a register amendment |
| B2, no exit decision | The adopter. They must also name who decides |
| B3, no production data | The adopter, through their own Phase 2 traffic |

### What has shipped toward it

**The measurement now has a reader.** Issue #17 shipped `pnpm run bands`. It
reports the four control-band metrics for one day, against the thirty most
recent measured days before it. Criterion C2 rests on the approval-edit
distance, and that number is now readable from the ledger alone.

So B3 is half closed. The tooling exists and the data does not. The design
document predates that job and still describes the blocker as whole.

### The next step

**One part of this item is addressable in code today, and it is C7.**

C7 sets an adapter floor. An automatic send needs `supportsIdempotencyKey` and
`supportsReadBack` (DEC-06). With no person in the loop, the relay must
reconcile delivery itself (DEC-30).

No channel both meets that floor and reaches a real customer. Read the two
halves apart, because each adapter fails a different one.

| Adapter | Meets the C7 floor? | Reaches a customer? |
|---|---|---|
| Mail | No. It declares `supportsReadBack: false` and its `readBack` throws | Yes |
| Helpdesk | Yes. It declares both capabilities | No. It holds fixtures and opens no connection |

So an automatic customer reply has no channel to leave through, whatever the
register later decides. An adopter supplies one, or a reference adapter gains
read-back. That gap is the candidate for the next change. This document names
it and does not close it.

One more thing is worth stating, because C7 reads like a rule the code already
applies. It is not one yet. The policy engine gates on
`supportsIdempotencyKey` and never reads `supportsReadBack`. C7 proposes that
second check; nothing enforces it today, and nothing needs to while every
reply waits for a person.

Everything else waits on a person and on traffic.

---

## Item 4. Automatic feedback clusters when the volume is sufficient

### What the item asks

Feedback clusters are manual in V1. The item asks for automatic clusters once
monthly volume supports them.

### What blocks it

Volume alone. No decision blocks this item, and no code contradicts it.

Section 6 gives the reason. At test-bed volume, a few hundred tickets each
month give noise. The interval is wider than the signal, so a cluster reports a
difference the data cannot support.

### Who owns each blocker

The adopter. Volume arrives with their own traffic and with nothing else.

### What has shipped toward it

Nothing, and the design material was missing too. The design document
`f4c1a90e-7d3b-4c2a-9e15-3b8d6f0a5c47.md` now records the mechanism, the
trigger and the reason V1 answers this manually.

The taxonomy induction job already embeds records, groups them, folds small
groups into an `other` group and asks a model to name each surviving group. A
feedback clustering job is that shape over a different corpus.

### The next step

Nothing in this repository. An adopter reaches the volume or does not.

When they do, the design document specifies a trigger checked in code rather
than left as guidance. Below the trigger the job produces no clusters and says
why. At or above it, the job produces clusters and records the count that let
them run.

---

## Item 5. A threshold for each intent

### What the item asks

The system compares classifier agreement against one global threshold. The item
asks for a threshold fitted for each intent, above roughly 8000 labelled
tickets.

### What blocks it

Two things, and both must clear.

**DEC-13 binds.** It selects one global threshold and rejects a threshold the
system learns for each intent. The policy engine enforces that. A register
decision must come first.

**The trigger cannot fire.** Section 3.3 gives the arithmetic. One global
threshold needs 385 labelled tickets for an interval of five points. A
threshold for each of 25 intents needs roughly 2400. Intent frequencies follow
a Zipf distribution, so the intent at rank 20 needs roughly 7700. The item
rounds that to 8000.

Read 385 as a requirement and not as a corpus size. The fit half holds 1062
cases, so the global threshold has the data it needs. The per-intent threshold
does not.

The shipped corpus holds 2124 synthetic cases. That is an order of magnitude
short, and it is synthetic besides (DEC-18).

### Who owns each blocker

| Blocker | Owner |
|---|---|
| DEC-13 binds | The maintainer, through a register amendment |
| The trigger cannot fire | The adopter, through labelling their own history |

### What has shipped toward it

`434db94d-bbba-4977-805a-e9d83cb0b6c5.md` specifies the mechanism. Below
the trigger the calibration job fits the global threshold and records an empty
per-intent map. At or above it, the job fits a threshold for each intent above
the data floor. Either way the artifact records the trigger and the count, so a
reader can tell which path ran.

That document carries a dated note. Three of the facts it rests on moved
after it was written, and the note says which.

### The next step

Nothing in this repository, and the reason is worth stating plainly.

The trigger counts cases a person labelled. The history carries no tags
(DEC-02), so a person applies each one. Section 5 calls that labelling the
largest single cost in the whole plan.

This item is not waiting on engineering. It is waiting on labelled data that
costs real money to produce.

---

## Item 7. A correction for head-of-line delay in a partition

### What the item asks

One consumer owns each partition (DEC-27, DEC-36). A slow ticket therefore
holds up every ticket behind it in the same partition. The item asks for a
correction.

### What blocks it

Nobody has chosen one, and choosing one needs production data. A correction
trades something away. Overtaking the slow ticket reorders work on one
conversation, and adding partitions moves the cost rather than removing it.

### Who owns each blocker

The adopter. The choice depends on their traffic, and the data comes from it.

### What has shipped toward it

`pnpm run latency` reports queue wait and service time for each partition. So a
partition falling behind is visible beside the ones that are not. That is the
measurement a correction rests on.

### The next step

Run the report through a Phase 2 deployment, and read whether one partition
falls behind the others. Choose a correction against that reading.

The register marked this item closed until 2026-09-04. The measurement shipped
and the correction did not, so it now reads open. The test is whether the
item's own words describe what shipped. Item 6 asks for a schema migration
procedure, and the migration runner is that procedure. Item 7 asks for a
correction, and no correction exists.

---

## The items that have closed

| Item | What settles it |
|---|---|
| 2. Compensation for irreversible actions | DEC-34. The policy engine gates every irreversible write |
| 3. Conversation state for more than one turn | DEC-35 to DEC-39, with `db/008` and `db/009` |
| 6. A schema migration procedure for adopters | `src/ledger/migrate.ts` and the `schema_version` table |

## Where to go next

- [The decision register](v1-architecture.md) holds section 7 and the design index.
- [The runbook](operations.md) tells an operator what to run in each phase.
- [The architecture map](architecture-map.md) draws the system.
