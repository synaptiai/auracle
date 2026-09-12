# The core's public surface

Every file here is a barrel, and together they are the whole of what another
package may import from the core.

`package.json` used to publish `"./dist/*": "./dist/*"`, which made every
compiled file public API. The console reached 18 core modules through it,
including two CLI entry points — it loaded a command-line program that parses
argv and sets `process.exitCode` in order to format a duration.

DEC-11 keeps the core free of the console. The package boundary states that a
console dependency can never reach the daemons. It said nothing in the other
direction, so the core had no surface it could change without breaking the
console silently. These barrels are that direction.

A symbol reaches the console only by being named here. Adding one is a
deliberate act, and `tsc -b` builds the console against the core, so removing
one fails the core's own `pnpm run check`.
