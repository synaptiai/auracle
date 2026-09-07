# Intent: The fast inner loop covers the test files

## Problem

`tsconfig.json` excluded `src/**/*.test.ts` and `src/test-support`. The build
must exclude them, because a test must not reach `dist/`. But `pnpm run check`
used the same file, so about half the source was never type-checked.

The compiler therefore reported success while a test called a function that
no longer existed. That happened during this work.

Twenty errors were hiding there. Three were real defects rather than noise.
The mail adapter declared `performAction` and `readBack` with no parameters,
so the class did not match the port it implements. A reranker case passed a
document body to a helper that took two arguments and dropped it. So the
overlap it meant to measure ran against an empty body. A relay fake omitted
a port method.

## Proposed outcome

`tsconfig.check.json` extends the build config and includes everything.
`pnpm run check` uses it. The build config is unchanged, so `dist/` still
holds no test.

The provided test database URI is typed, so a rename on either side of the
handoff is a compile error.

## Affected users and systems

Anyone who runs the inner loop before the three targets.

## Constraints

No test behaviour changes. All 450 tests still pass.

## Decisions affected

None. This is an implementation detail of the toolchain.

## Open questions

None.
