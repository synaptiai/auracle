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

Four items stay open: 1, 4, 5 and 7. Item 7 has its measurement and not its
correction. So it has a section of its own below the other three.

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
`v2-automatic-customer-replies.md` proposes eight criteria, C1 to C8.

They cover volume, edit distance, a human audit of unchanged sends and a
groundedness floor. They also cover person-set eligibility, disclosure, an
adapter floor and a daily cap. They stay a proposal until a row enters
section 2.

**B3. No production data exists.** The control bands have no baseline here.
`pnpm run bands` computes a baseline from an adopter's own ledger. That
baseline is a production number, so it stays with the adopter. This repository
ships synthetic fixtures only (DEC-18).

### Who owns each blocker

| Blocker | Owner |
|---|---|
| B1, the register binds | The maintainer, through a register amendment |
| B2, no exit decision | The adopter. They must also name who decides |
| B3, no production data | The adopter, through their own Phase 2 traffic |

### What has shipped toward it

`pnpm run bands` reads the measurement. It reports the control-band metrics
for one day, against the window `bands.yaml` sets. Criterion C2 rests on the
approval-edit distance, and the ledger alone gives that number. The tooling
for B3 exists. The data does not.

### The next step

**One part of this item is addressable in code today, and it is C7.**

C7 sets an adapter floor. An automatic send needs `supportsIdempotencyKey` and
`supportsReadBack` (DEC-06). With no person in the loop, the relay must
reconcile delivery itself (DEC-30).

The policy engine applies that adapter floor. It reads both flags, and a write
on an adapter that declares either one false goes to the approval path.

No channel meets the adapter floor and reaches a real customer:

| Adapter | Meets the C7 adapter floor? | Reaches a customer? |
|---|---|---|
| Mail | No. It declares both delivery flags false, and its `readBack` throws | Yes |
| Helpdesk | Yes. It declares both capabilities | No. It holds fixtures and opens no connection |
| FreeScout | No. It declares both delivery flags false | Yes, once a person installs the API module |

Mail and FreeScout fail the adapter floor. Helpdesk fails the reach. So an
automatic customer reply has no channel to leave through, whatever the
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
answer there. A guess turns an unknown delivery into a claim, which DEC-30
forbids.

**The adapter builds no shim.** DEC-06's rejected column names "a shim that
removes duplicates". The adapter declares `supportsIdempotencyKey: false` and
builds none.

So C7 stays open. An adopter supplies the channel.

### The API module a person must buy

FreeScout's REST API lives in the `API & Webhooks` module. It is a separate
purchase, and the stock image ships an empty `Modules` directory. A stock
instance answers `404` to every `/api/` route.

So `docker-compose.freescout.yml` brings a FreeScout instance up, and the
adapter cannot reach its API until a person installs that module. The
automated suites drive the adapter against the documented wire contract
instead. `docs/operations.md` says how to check a real instance by hand.

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

No code. The design document `v2-automatic-feedback-clusters.md`
records the mechanism, the trigger and the reason V1 answers this manually.

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

The item asks for an agreement threshold fitted for each intent, above
roughly 8,000 labeled cases.

### What blocks it

One thing blocks it: labeled history from an adopter's own traffic.

The trigger counts labeled cases, and DEC-41 requires each one to record what
labeled it. The history carries no tags (DEC-02), so something applies each
one. Section 5 calls that labeling the largest single cost in the whole plan,
and it means labeling by a person.

A model may label the cases, and the artifact then says so. It also states how
often that model agrees with a known answer. This repository ships no model
labeler, so an adopter writes one.

### Who owns each blocker

The adopter, who labels their own history or writes a model labeler for it.

### What has shipped toward it

The mechanism ships. `v2-per-intent-agreement-thresholds.md` specifies it.
DEC-13 names the trigger as its own bound, and DEC-41 governs above it.

Below the trigger the calibration job fits the global threshold and records an
empty per-intent map. At or above it, the job fits a threshold for each intent
that holds enough cases. The policy engine reads that map. Either way the
artifact records the trigger and the count, so a reader can tell which path
runs.

The figures in that design document do not describe the shipped corpus. Read
the register and this item instead.

The shipped corpus holds 8,200 synthetic cases, which clears the trigger. Its
intent frequencies follow the Zipf shape at exponent 1 that section 3.3
assumes. So the per-intent path runs end to end on synthetic data, and the stub
labeler labels the cases (DEC-18).

The fit refuses a threshold whose 95 percent lower bound cannot hold the
target precision. The shipped target precision is 0.985, and
`CALIBRATION_TARGET_PRECISION` overrides it. A perfect sample needs 253 cases
to hold 0.985.

On the shipped fit half, the four most frequent intents hold that many, and
the other 21 do not. So the fit sets four thresholds of 25, and the other 21
keep the global threshold. The case count settles each refusal before the fit
reads precision.

### The next step

The mechanism ships, and the item does not close. The item asks for a
threshold for each intent on an adopter's own traffic.

The shipped corpus cannot show what a real classifier reaches. The offline stub
classifier answers every sample of one case alike. Agreement is then one
value, and a fitted threshold has one place to sit. So the fitted count is a
statement about the sample minimum, and never about accuracy.

It also cannot show that the mechanism selects anything. A run at a target
precision of 0.9 fits all 25 intents, each at a threshold of 1.0.

No fitted threshold gates the shipped gold report either. That report records
a gate source of `seed`, which names the section 4.5 seed. It records no
calibration version, so the number it publishes rests on no fitted threshold.

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

Intake signals the consumer inside the enqueue transaction, and the loop wakes
on that signal. So the poll interval does not set the queue wait.

### The next step

The shipped synthetic history runs at about 1.4 percent of the capacity of two
consumers. The four rules R1 to R4 in the design document do not fire at that
load. About one run in a hundred still waits behind the batch ahead of it.
Those runs are what this item names.

The question reopens on volume. Run the report through a Phase 2 deployment
near the capacity of its consumers, and read the four rules again. Then choose
a correction against that reading.

The item is open. The measurement exists, and the correction does not.

---

## The reviewer console

DEC-44 to DEC-51 govern the review tool. They cover an authenticated reviewer,
a reservation, a product and the ways a case ends. They also cover a new
attempt, knowledge written from a case and a hold period before a send.
`amendment-a-reviewer-console-four-people-work-from.md` under `docs/design/`
records the reasoning.

The console ships each of them. A roster of reviewers decides who may use the
console. The console refuses a request with no active roster identity. The
ledger records where each approver's name came from. A maintainer changes the
roster with `pnpm run reviewers`.

One part of DEC-45 remains for an operator. The development stack publishes a
console with no proxy in front of it, and such a console serves nothing. So an
operator puts a proxy in front and adds that proxy's reviewer to the roster.

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
