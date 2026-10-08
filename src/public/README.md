# The core's public surface

Every TypeScript module here except its test is a barrel. Together the
barrels are the whole of what another package may import from the core.
`package.json` publishes these barrels and the root entry, and nothing
else. `surface.test.ts` holds that.

The console is a separate package, so a console dependency never reaches the
daemons. These barrels bound the other direction: what the console may import
from the core. That boundary is an implementation detail, not a decision.

A symbol reaches the console only when a barrel here names it. Adding one is a
deliberate act. `tsc -b` builds the console against the core, so removing one
fails the core's own `pnpm run check`.
