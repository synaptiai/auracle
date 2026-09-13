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
under `docs/design/`, this document reports it and names its status.

Four items stay open: 1, 4, 5 and 7. Items 1, 4 and 5 have never closed.
Item 7 has its measurement and not its correction. So it has a section of
its own below the other three.

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

They cover volume, edit distance, a human audit of unchanged sends and a
groundedness floor. They also cover person-set eligibility, disclosure, an
adapter floor and a daily cap. They stay a proposal until a row enters
section 2.

**B3. No production data exists.** The four control bands have no baseline
here. `pnpm run bands` computes a baseline from an adopter's own ledger. That
baseline is a production number, so it stays with the adopter. This repository ships
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

The policy engine applies that floor. It reads both flags, and a write on an
adapter that declares either one false goes to the approval path.

No channel meets the floor and reaches a real customer. Read the two halves
apart, because each adapter fails a different one.

| Adapter | Meets the C7 floor? | Reaches a customer? |
|---|---|---|
| Mail | No. It declares `supportsReadBack: false` and its `readBack` throws | Yes |
| Helpdesk | Yes. It declares both capabilities | No. It holds fixtures and opens no connection |
| FreeScout | No. It declares both delivery flags false | Yes, once a person installs the API module |

So an automatic customer reply has no channel to leave through, whatever the
register later decides. This document names the gap and does not close it.

### What the FreeScout adapter established

Three findings back the FreeScout row. Each rests on FreeScout's own API
documentation, which is a stronger source than the register's prediction. It
is still not a run against a live instance. Read them that way.

**No key reaches the target.** `POST /api/conversations/{id}/threads` takes no
idempotency field. The API documentation claims uniqueness for a customer
address and for a user address, and for nothing else. Two identical posts make
two threads.

**No key comes back either.** The relay reads delivery state back by the
outbox key. FreeScout records no such key on a thread, so the question has no
answer there. A guess would turn an unknown delivery into a claim, which DEC-30
forbids.

**A shim was available and was refused.** DEC-06's rejected column names "a
shim that removes duplicates". The adapter declares `supportsIdempotencyKey:
false` and builds none.

So C7 stays open. An adopter supplies the channel.

### The API module a person must buy

FreeScout's REST API lives in the `API & Webhooks` module. It is a separate
purchase, and FreeScout 1.8.239 ships an empty `Modules` directory. A stock
instance answers `404` to every `/api/` route.

So `docker-compose.freescout.yml` brings a FreeScout instance up, and the
adapter cannot reach its API until a person installs that module. The automated suites drive
the adapter against the documented wire contract instead.
`docs/operations.md` says how to check a real instance by hand.

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

The taxonomy induction job already embeds records, groups them, and folds
small groups into an `other` group. It also asks a model to name each
surviving group. A feedback clustering job is that shape over a different
corpus.

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

One thing now, and it was not this one.

**DEC-13 no longer binds alone.** It selected one global threshold and
rejected a threshold the system learns for each intent. DEC-13 now names the
trigger as its own bound, and DEC-41 governs above it. Each case records what
labelled it. The mechanism has shipped: the job fits per intent, the artifact
carries the map and the policy engine reads it.

**The trigger cannot fire.** Section 3.3 gives the arithmetic. One global
threshold needs 385 labelled tickets for an interval of five points. A
threshold for each of 25 intents needs roughly 2400. Intent frequencies follow
a Zipf distribution, so the intent at rank 20 needs roughly 7700. The item
rounds that to 8000.

Read 385 as a requirement and not as a corpus size. The fit half holds 4100
cases, so the global threshold has the data it needs.

**The fit refuses most intents.** Section 3.3 sizes a corpus for an interval
of five points. The job fits against a precision floor instead, and the two
ask for different amounts.

The shipped floor is 0.985. A perfect sample needs 253 cases to hold it.
Twenty-five intents at that count would need 6325 in the fit half, and that
half holds 4100. The Zipf shape spends those 4100 unevenly, so the four most
frequent intents clear the floor and 21 do not. The next step below reports
that run.

The shipped corpus holds 8200 synthetic cases, which clears the trigger. It
is synthetic (DEC-18), and a stand-in labels it. So the mechanism runs end to
end, and the numbers describe this corpus and not an adopter's traffic.

Clearing the trigger is not the same as fitting a threshold. The next step
below reports what the fit produces on this corpus.

### Who owns each blocker

| Blocker | Owner |
|---|---|
| DEC-13 binds | Cleared. DEC-41 carries the amendment, and DEC-13 now names the trigger as its own bound |
| The trigger cannot fire | Cleared on the shipped corpus, which holds 8200 cases. An adopter clears it by labelling their own history |
| The trigger fires and fits nothing | Cleared. The Zipf shape gives rank 1 1074 fit cases, so four intents clear the 253 the shipped target needs |

### What has shipped toward it

`434db94d-bbba-4977-805a-e9d83cb0b6c5.md` specifies the mechanism. Below
the trigger the calibration job fits the global threshold and records an empty
per-intent map. At or above it, the job fits a threshold for each intent above
the data floor. Either way the artifact records the trigger and the count, so a
reader can tell which path ran.

That document carries a dated note, and the note is itself out of date. Its
corrections were written against a corpus of 2124 cases, which this repository
no longer ships. Read the register and this item for the current figures.

### The next step

The mechanism has shipped and the item does not close. Both halves of that
are worth stating plainly.

The shipped corpus clears the trigger, so the per-intent path runs. It fits
four thresholds of 25. A run of the shipped fit half refuses the other 21.

Two things decide that, and a reader needs both. One is the corpus. The Zipf
shape at exponent 1 gives rank 1 1074 fit cases and rank 25 only 43.

The other is the target precision. Its shipped value is 0.985, and
`CALIBRATION_TARGET_PRECISION` overrides it. The fit refuses a threshold whose
95 per cent lower bound cannot hold the target.

A perfect sample needs 253 cases to hold 0.985. Four intents hold that many
and 21 do not, so the count settles each refusal whatever the answers were.
Those 21 keep the global threshold.

So this corpus still cannot show whether precision alone would refuse an
intent. The count decides every refusal before precision is read.

It also cannot show that the mechanism selects anything. A run at a target of
0.9 fits all 25 intents, each at a threshold of 1.0.

No fitted threshold gates the shipped gold report either. That report records
a gate source of `seed`, which names the section 4.5 seed. It records no
calibration version. So the number it publishes is the seed and not a fitted threshold.

A stand-in labels the cases, and the artifact says so. So the mechanism runs
end to end on synthetic data, and it selects nothing.

It is not the item. The item asks for a threshold for each intent on an
adopter's own traffic, and two things stand between.

The trigger counts labelled cases, and DEC-41 requires each one to record what
labelled it. The history carries no tags (DEC-02), so something applies each
one. Section 5 calls that labelling the largest single cost in the whole plan,
and it means labelling by a person.

So an adopter still waits on labelled data that costs real money to produce.
A model may label the cases, and the artifact then says so. It also states
how often that model agreed with a known answer. This repository ships no
model labeller; an adopter writes one.

The second was the shape of the corpus, and that half is closed. Section
3.3's arithmetic assumes Zipf-distributed intent frequencies and sizes the
trigger from the intent at rank 20. The shipped corpus now carries that shape
at exponent 1.

The fit reads it. Four intents of 25 clear the 253-sample floor and 21 keep
the global threshold. So the fixture exercises both routes, rather than unit
cases alone.

What the fixture still cannot show is what a real classifier reaches. The
offline stand-in answers every sample of one ticket alike. Agreement is then
one value, and a fitted threshold has one place to sit. So the fitted count is
a statement about the sample floor, and never about accuracy.

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

A synthetic history of 2397 runs over 45 days gave the first loaded reading.
It reported 1.37 per cent utilisation and a depth ratio of 1.14 across four
partitions. That is at 53 tickets a day. The mean wait was 2.78 s against a
poll floor of 2.50 s. So the wait was the consumer's own sleep rather than a
queue. None of the design document's four rules fires at that load.

The sleep is gone. Intake signals the consumer inside the enqueue transaction,
and the loop wakes on that signal. Wait `p50` and `p95` fall from seconds to
a figure the poll no longer sets.

### The next step

That change removes the poll floor and corrects at most a small part of the
head-of-line delay. The maximum wait barely moves, from 2.3 minutes to 2.2
minutes on the deepest partition. About one run in a hundred still waits
behind the batch ahead of it. That share never rises with the signal and
never falls by half. Those runs are what this item names.

The question reopens on volume. The history runs at 53 tickets a day
against two consumers, which is 1.37 per cent of their capacity. So
saturating them needs about 3 900 a day. Run the report through a Phase 2
deployment near that volume, and read the four rules again. Then choose a
correction against that reading.

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
