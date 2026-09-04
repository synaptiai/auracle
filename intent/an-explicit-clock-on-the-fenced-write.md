# Intent: an explicit clock on the fenced write

## Naming

This file says **clock** for the timestamps a caller supplies, and it says so
everywhere. DEC-25 uses "clock time" for a run's wall-clock budget, which is a
different thing and reads `deadline_at`. Nothing here touches that budget.

## Problem

`run.created_at` carries a `DEFAULT now()`, and `fencedInsert` never names the
column. So every run row records the wall clock of the process that wrote it.
`fencedTransition` stamps `finished_at` from `now()` on a terminal state.

Two jobs read those columns. `pnpm run bands` judges one UTC day against the
thirty measured days before it. `pnpm run latency` windows on the same column.
No job can exercise either without a history. Nothing can write a history, so
both jobs report only on what a live system already accumulated.

A demonstration cannot wait thirty-one days.

## Proposed outcome

A caller may supply the clock. A seeder then writes a backdated history
through the real ledger path: the same epoch check, the same transaction, the
same journal writes. The rows a report describes are rows the system produced.

An insert that supplies no clock records `now()`, exactly as before. The
column list of the plain statement is unchanged, so the column default stays
in charge of every production row.

The write refuses an inconsistent clock. The refusal is the exact complement
of the latency reader's own label: that reader calls `created_at <
enqueued_at` and `finished_at < created_at` unordered, and drops such a row
from the distribution. A stored row the reader drops exists and counts for
nothing. The write refuses it instead. The write accepts equality, because
the reader compares with `<` and a zero wait is still a wait.

## Affected users and systems

`src/ledger/insert.ts` gains a trailing optional parameter on both fenced
writes. `src/ledger/clock.ts` is new and holds the two clock types, the named
error and the shape checks.

Two non-test modules call the fenced path: `src/coordinator/coordinator.ts`
and `src/approval/approve.ts`. Neither passes a clock. The four daemons
(`webhook`, `imap`, `consumer` and `relay`) reach the ledger through the
coordinator; no daemon imports the approval path, which the approval CLI
drives instead.

`src/ledger/clock-reachability.test.ts` therefore states its rule over every
shipped module under `src/`, not only over the four entry points. It also
walks the import graph from those four, because the acceptance criterion names
them. The wider statement is the one that covers the approval path and covers
an entry point nobody has written yet.

The intake-abandonment insert in `src/coordinator/consumer.ts` does not gain
the seam. That statement lives inside a daemon, and a daemon must not supply a
clock. A seeder that wants abandoned-run history writes it through the ledger
path.

No adopter number moves. The committed fixtures are byte-identical.

## Constraints

The seam is a parameter, not a field on `FencedRunInput`. A field would leave
the plain statement naming `created_at` on every call, and a field-name search
would be the only guard against a daemon filling it. A parameter makes the
plain statement the statement that shipped before, and makes unreachability an
arity property a reader can check.

The insert side checks the clock before `BEGIN`, so a refused clock leaves no
`ticket_epoch` upsert, no `run` row and no `outbox` row.

The transition side compares in the database, inside the `SELECT ... FOR
UPDATE` that reads the row. Postgres holds `created_at` to the microsecond,
and node-postgres truncates it to the millisecond when it parses the column
into a `Date`. A comparison in JavaScript was therefore permissive by up to
999 microseconds: it accepted a finish the database then read as earlier than
the creation, and the reader labelled that row unordered.

The transition checks the clock before it decides the outcome, and whatever
state the caller asked for. Checked later, a caller's bad clock decided the
outcome of a race: the losing run threw instead of reaching `superseded` and
stopping, which section 4.2 forbids, and it threw only when a race happened.

The check refuses a `Date` that carries no time, and it refuses it by name. `new Date('nonsense')` is a
`Date`, and every comparison against `NaN` is false, so it cleared the order
checks and threw a bare `RangeError` out of `toISOString` inside the
transaction.

The insert refuses a finish supplied for a state that has not finished, rather
than storing the creation and dropping the finish. The dropped column read as
`unstamped`, and the caller heard nothing.

The refusal is a throw and not a fourth outcome. `FencedInsertResult` names
the three outcomes of a concurrent write. A caller that supplies an impossible
timeline has a bug, and a fourth member would make every existing reader of
that union change to describe it.

A clockless insert that still supplies an arrival time records `now()` as the
pickup. The pair is then ordered, so the latency reader accepts it and reports
a queue wait as long as the backdate. That is the old behaviour and it does not
change here. A seeder must supply both or neither.

The coordinator compares a backdated run's `deadline_at` against real wall
time (`src/coordinator/coordinator.ts`). So a seeder must write its terminal states
through the ledger path directly. A backdated run driven through the
coordinator hits the clock-time limit on the first check, and a seeded history
comes out as a wall of `escalated` runs.

`superseded` is terminal, so both paths that land it stamp a finish. The
creation instant is the stamp, because such a run never ran.

The epoch rule (DEC-28), the single-transaction rule and the zero-row outbox
rule (section 4.2) keep their meaning. A clock changes no branch of either.

## Residual risk

A seeded row carries no marker. No column, no journal entry and no version
field separates a backdated run from a produced one, and adding one would need
a migration, which this change excludes. So `pnpm run bands` and `pnpm run
latency` cannot tell a manufactured baseline from a measured one. A seeder can
now author the thirty measured days that a day under test is judged against.

The control is a test over source, at build time. It is not a control over a
database that already holds seeded rows. So a database that has taken a seeded
history must never be the source of a published band or latency number. The
register states the same principle for the gold set at section 3.3: a half
declares its provenance, and each process logs it, so a reader never infers
which data a number covers. A run row makes no such declaration, and this
change does not give it one.

## Decisions affected

None. This is an implementation detail.

The register specifies that the fenced path is the only write path for a run's
first transition (section 4.2), and it specifies that the timing columns exist
so a latency reader can be built (`db/005_run_timing.sql`, V2 open item 7). It
does not specify where the timestamp comes from. DEC-25 limits a run's clock
time, and that limit reads `deadline_at`, which callers already supply.

## Open questions

Whether a seeded row should declare itself, as a gold half does. That needs a
column, so it needs a decision and a migration. The seeder in issue #23 is the
first caller that makes the question concrete.
