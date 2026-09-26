# The team and routing screens read the ledger

## Problem

No figure says how much support work reaches the team, or how long a case
holds one of its people. No screen says what each product may do without a
person. A reviewer cannot see that a customer reply always waits for one.

## Proposed outcome

The console has a team screen and a routing screen. Both read the ledger, and
neither writes to it. The gate step keeps the one record that the routing
screen reads. This gate record is the latest gate verdict of each product and
intent.

The team screen shows four cards:

- the share of today's cases that reach a person, with its counts;
- the team's time on support over the last seven days;
- the median case, from the first take to the last send;
- the oldest case that waits for approval.

A row for each active reviewer and a three-part bar for each product follow.
Every figure with no record is a sentence, never a zero.

The routing screen lists each product's intents. Each row gives the risk tier,
the agreement threshold, and whether the product may act without a person. The
first row, any reply to a customer, is fixed, and nobody can change it.

## Affected users and systems

- Reviewers and the maintainer, who read the two screens.
- The console, which gains two routes, two rail entries and two reads.
- The core, which gains two read-only modules behind the public barrel.
- The gate step, which also writes the gate record of its product and intent
  to `gate_latest`. It writes that row in its fenced move to `gated`. The
  history seeder writes it too. The gate skips and logs a write that cannot
  finish, and the run goes on.
- The consumer, which now checks the taxonomy at start, as the console does.
- No job changes what it counts. `pnpm run bands` and `pnpm run latency` stay
  as they are.

## Constraints

- A customer reply always needs a person (DEC-12). The routing screen shows
  that rule as fixed, and it offers no control to change any rule.
- The console owns no SQL. Each screen reads in one read-only transaction.
- Each read costs no more as the history grows past the window it shows. The
  team read windows on time, and the routing read reads one row per product
  and intent.
- A figure the ledger does not record is a named absence, never a zero.
- The queue header keeps its two counts and no share (#101).

## Decisions affected

Affects: DEC-05, DEC-06, DEC-12, DEC-13, DEC-28, DEC-34, DEC-41, DEC-45, DEC-46, DEC-47, DEC-49, DEC-51

DEC-05: the two gates stay independent. The routing screen shows the rule that
decides each run, which says which gate or stop decides it. It never blends the
agreement threshold with a coverage figure.

DEC-06: an adapter declares its capabilities. A gate record that a missing
capability decides shows that the product may not act on its own there.

DEC-12: a customer reply needs approval. The routing screen draws it as a fixed
first row that nobody can change. The row names DEC-12 as its reason.

DEC-13: a person sets each intent's risk tier. The routing screen shows the
tier from the taxonomy, and it shows that a high-risk intent always stops.

DEC-28: every run write carries a fencing epoch. The gate step writes the gate
record in the same commit as its fenced move to `gated`. So a consumer that
the fence refused writes no record.

DEC-34: an irreversible action always gates. A gate record that this rule
decides shows that the product may not act on its own.

DEC-41: the fit sets a threshold per intent above the trigger. The routing
screen shows the threshold in force for the latest run. It says whether the fit
chose that threshold for the intent, or whether the global one applies. The
console holds no calibration artifact, so the gate record is the source.

DEC-45: the console serves a roster identity that a trusted proxy
authenticates. The console has no roles of its own, which is an implementation
fact and not part of DEC-45. So every reviewer sees the team screen's row for
each other reviewer. The compliance position in the README says so, and it
names the deployer as the controller of those figures.

DEC-46: the hold history records each take, handover, release, send and lapse,
with its reviewer and time. The team screen adds the time on support from
those records. No interval runs past its lapse, so a late lapse adds nothing.
Two indexes on the hold history keep that read inside its time budget.

DEC-47: each run records its product. The team screen splits each product's
cases, and the routing screen reads each product's own gate records.

DEC-49: a reviewer may send a case back for a new attempt, and the attempt
belongs to its turn. So the team screen counts a turn once, by its final
attempt. A run that its twin superseded never stands for that attempt.

DEC-51: a person can undo a send while its hold lasts. The undo moves the run
back to waiting for approval. So the median case counts only a run that stays
sent, and measures it to its last send.

The share on the team screen departs from the queue's counts-only rule. It
does so for this screen alone, by the maintainer's ruling of 2026-09-26. The
card shows the counts beside the share, and it says the figure is not the
published containment figure.

## Open questions

- The ledger records no intake channel. So channel health shows only the last
  arrival and the waiting messages. A channel's own health needs a record the
  ledger does not keep.
- The taxonomy holds no product and no owner. So every product lists the same
  intents, and the routing screen shows no owner column.
