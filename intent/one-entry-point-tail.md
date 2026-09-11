# Intent: one entry-point tail, one env rule, one provider

## Problem

Twenty CLIs and daemons each ended with their own copy. Each copied the error
tail, the environment parsing and the provider construction. The copies have
drifted, and each drift is a live fault.

Fifteen tails printed `err.message` alone. `src/artifacts/versioned.ts`
attaches a cause to every filesystem fault it wraps. Those fifteen tools
therefore dropped the errno. An operator could not tell a missing directory
from a revoked permission. Two tails had been fixed, a third fixed it
differently, and a fourth printed the raw object.

Three jobs copied the pool teardown. Only `bands` set the exit code.
`latency` and `seed-history` logged a failed close and exited 0. That tells a
supervisor the run succeeded.

Four entry points parsed an integer from the environment. They used three
different empty-string rules. `PARTITION_COUNT=` was fatal for the consumer.
It was a silent default for the webhook. Two daemons that must agree could
therefore disagree.

All four also accepted spellings nobody meant. `Number('0x10')` is 16 and
`Number('1e3')` is 1000. So `PARTITION_COUNT=0x10` silently meant sixteen
partitions.

Six entry points built the model provider. Four ignored `OPENROUTER_BASE_URL`.
An adopter who pointed the system at their own gateway had four jobs bypass
it. Those jobs carried the adopter's key straight to openrouter.ai.

`errorMessage` was a named local in four modules. It was an inline expression
twenty-two more times. Three of the four copies could not read an
`AggregateError`. A refused TCP connection arrives that way. So a daemon that
could not reach Postgres reported `''` rather than `ECONNREFUSED`.

## Proposed outcome

One module decides each of these, and every entry point calls it.

- `src/cli/entry.ts` holds `runEntry` and `describeFault`. Twenty tails use it.
- `src/errors.ts` holds `errorMessage`, which reads an `AggregateError`.
- `src/config/env.ts` holds `requiredEnv` and `positiveIntEnv`. An empty value
  is a fault. Digits are matched before they are parsed.
- `src/db/config.ts` holds `closeLedger`, which sets the exit code.
- `src/models/from-env.ts` holds `openRouterFromEnv`. It reads the key, the
  base URL and the DEC-17 guarantee.

## Affected users and systems

Every CLI, both ingress daemons, the consumer, the relay, the offline jobs and
the operator console.

An operator reading stderr sees more than before. Fifteen tools printed one
sentence, and they now print the cause chain. A refused connection printed
nothing, and it now names `ECONNREFUSED`.

Two behaviours change for an adopter. An empty variable now refuses the start
in two of the four daemons. It used to take a default there.
`OPENROUTER_BASE_URL` now applies to all six jobs rather than two.

## Constraints

DEC-36 puts one consumer on each partition. The daemons must therefore agree
on the partition count. That is why the empty-string rule is one rule. An
empty value refuses rather than defaults, because the costs are not
symmetric. A refused start is loud and harmless. Two daemons disagreeing
about ownership corrupts the ledger quietly.

DEC-16 keeps the models behind OpenRouter. DEC-17 makes the data guarantee
the adopter's choice. Both are read in one place now.

DEC-25 needs a truthful embedding cost. So `load-docs` still passes the price
it resolved. The environment cannot settle that one.

`describeFault` returns a string. Two tails printed the `Error` object
instead. Node renders a stack for a thrown object, and a string drops it. The
errno survives, because a filesystem cause carries it in its own message.

## Decisions affected

DEC-36 for the partition-count rule. Everything else is an implementation
detail.

## Open questions

None.
