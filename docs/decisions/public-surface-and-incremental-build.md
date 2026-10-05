# Intent: a named public surface, and a build that stops repeating itself

## Problem

The console is a separate package so a console dependency can never reach the
daemons (DEC-11). The boundary was silent in the other direction.

`package.json` published `"./dist/*"`. Every compiled file was public API. The
console reached 18 core modules through 26 deep imports. Two of them were CLI
entry points. It loaded `bands/run.js` and `latency/run.js` to format a rate
and a duration. Both modules parse argv and set `process.exitCode`.

Nothing connected the two packages at build time. `pnpm run build`, `pnpm test`
and `pnpm run check` covered `src/` alone. An agent renaming a core module
passed all three, and learned about the console from a fourth command.

The build was not incremental. Twenty scripts run `build` before they start,
so the cost was paid in full every time. No process could start from source,
and no watch mode existed.

`lastCompleteDay` was written twice, with different validation.

## Proposed outcome

`src/public/` holds five barrels: `ledger-read`, `policy`, `domain`, `format`
and `cli`. `package.json` publishes those names and nothing else.

`console/tsconfig.json` references the core. `tsc -b tsconfig.build.json`
builds the two in order. So a rename inside `src/` that breaks the console
fails the core's own `pnpm run check`.

The build is incremental. Five processes start from source with no build.

## Affected users and systems

Every console file, the build and check targets, and four CLI modules that
gave up a pure function.

An adopter sees no behaviour change. One error message improves and one
loses a word. The seed planner now names an invalid date instead of throwing
a bare `RangeError`. The bands job no longer prefixes that message with
`bands:`. The shared helper does not know which job called it.

## Constraints

DEC-11 stands. The console stays a separate package. This adds the direction
the boundary was missing, and moves nothing back.

`check` emits, because its first pass is the build itself. The emit is
incremental, so it costs the changed files only.

Node's own type stripping cannot run this tree. It resolves a NodeNext
`./x.js` specifier literally, and no `.js` file exists under `src/`. It also
refuses a TypeScript parameter property, and five production classes use one.
So the `dev:*` scripts use `tsx`.

The barrels cut a hole in the purity guard, because that guard reads one level
deep. `public/ledger-read` re-exports `db/config`, so it is listed beside it.

## Decisions affected

Affects: DEC-11

DEC-11. The change strengthens the boundary in the direction it was silent
about. Everything else is an implementation detail.

## Open questions

None.
