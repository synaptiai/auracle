// One reading of a fault, for every module that has to say what went wrong.
//
// This was a named local in four modules and an inline
// `error instanceof Error ? error.message : String(error)` twenty-two times
// more. Three of the four copies were the inline expression, and all three
// are wrong about the one failure a daemon meets most: a refused TCP
// connection arrives as an `AggregateError` whose own message is empty, so
// they reported it as `''` or `AggregateError` and the operator never saw
// `ECONNREFUSED`. `src/coordinator/arrival-signal.ts` had already worked that
// out and fixed its own copy; this is that copy, moved to where the other
// three can reach it.
//
// The module imports nothing. Every CLI tail and both daemons depend on it,
// and a fault printer that can fail to load is one that reports nothing at
// the moment it is needed. It also keeps the module legal in a pure
// `*.test.ts` suite, which `src/test-support/purity.test.ts` enforces.
//
// Everything below is defensive to the point of paranoia, deliberately. This
// runs when something has already gone wrong, so it must not be the reason a
// process dies with nothing to show for it. Reading `.message` can throw when
// it is a getter, `String()` can throw on a value with no prototype, and
// `.errors` can nest or point back at itself.

/**
 * How deep the `AggregateError` walk goes.
 *
 * The seen-set below stops a cycle. This is the second bound, because an
 * aggregate can nest deeply without repeating a node.
 */
const MAX_AGGREGATE_DEPTH = 16;

/** Stands in when a value cannot be made to describe itself at all. */
const UNDESCRIBABLE = '<a fault that could not describe itself>';

/**
 * What an unknown thrown value has to say for itself, one level deep.
 *
 * For a cause chain use `describeFault` in `src/cli/entry.ts`, which walks
 * this over every link.
 */
export function errorMessage(error: unknown): string {
  return read(error, new Set(), 0);
}

function read(error: unknown, seen: Set<unknown>, depth: number): string {
  try {
    // A refused connection arrives as an AggregateError, and it hides the
    // cause twice over: its own `message` is empty and `String()` gives the
    // bare class name. Reading `.errors` is the only way to reach
    // `ECONNREFUSED`, which is the single most likely failure in a daemon.
    if (error instanceof AggregateError && depth < MAX_AGGREGATE_DEPTH) {
      if (seen.has(error)) return UNDESCRIBABLE;
      seen.add(error);
      const inner: unknown = error.errors;
      if (Array.isArray(inner) && inner.length > 0) {
        return inner.map((one: unknown) => read(one, seen, depth + 1)).join('; ');
      }
    }
    if (error instanceof Error) {
      const message: unknown = error.message;
      if (typeof message === 'string' && message.length > 0) return message;
    }
    return String(error);
  } catch {
    // A throwing getter, a Proxy that traps `get`, or a value with a null
    // prototype that `String()` cannot convert. Saying something useless
    // beats replacing the original fault with this one.
    return UNDESCRIBABLE;
  }
}
