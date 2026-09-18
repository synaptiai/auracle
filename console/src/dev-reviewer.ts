// The development reviewer (DEC-45).
//
// A console on loopback that runs from source may name its own reviewer, so
// the surfaces can be worked on without a proxy in front of them. The roster
// still decides: a development name that nobody added is refused like any
// other stranger.
//
// Three conditions, and each closes a different way the exception could reach
// a deployment:
//
//   - **Source, never the image.** A console that accepted the variable from
//     compiled output would serve a deployment as whatever name the
//     environment held, and no proxy would be in front of it. The module's own
//     URL is what decides, so an image cannot satisfy the check by saying so.
//   - **Loopback.** Off loopback, everyone who can reach the port would be
//     that reviewer.
//   - **No proxy at the same time.** A console configured with both this and
//     the header a proxy sets would answer every request the proxy did not
//     name as the developer, and record those approvals under that name.
//
// A console that cannot use the variable refuses to start rather than
// ignoring it. The operator who set it meant to use it, and a console that
// started anyway would look configured and serve nobody. The roster decides
// as well, and `main.ts` asks it at startup: an identity nobody added is
// refused there rather than at every request.
import { UNATTRIBUTED, approverFrom } from 'auracle/domain';

/**
 * A bind that reaches only this machine.
 *
 * `127.0.0.0/8` is loopback entire, not only `127.0.0.1`. `localhost` is
 * named here too, because a bind address is whatever an operator wrote.
 */
function isLoopback(host: string): boolean {
  const at = host.trim().toLowerCase();
  if (at === 'localhost' || at === '::1' || at === '[::1]') return true;
  const octets = at.split('.');
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && octets[0] === '127';
}

/**
 * The module URL of TypeScript source, as opposed to compiled output.
 *
 * `tsx` and vitest keep the `.ts` URL they were given, and `tsc` writes `.js`
 * beside the module it compiled. So the extension is the whole difference
 * between a console someone is working on and a console that shipped.
 */
const SOURCE = /\.(?:ts|mts|cts|tsx)$/i;

/**
 * The identity `CONSOLE_DEV_REVIEWER` names, once it may apply.
 *
 * Undefined when the variable is unset or empty, which is the ordinary case.
 * A set variable that this console cannot honour raises, and the message
 * names the variable and the bind, because the operator is reading it to find
 * out what to change.
 */
export function developmentReviewer(options: {
  readonly wanting: string | undefined;
  readonly host: string;
  readonly moduleUrl: string;
  readonly identityHeader: string | undefined;
}): string | undefined {
  const named = (options.wanting ?? '').trim();
  if (named === '') return undefined;
  // Both at once is the fail-open this variable must not create. The
  // development reviewer stands in for a proxy, so a console behind one that
  // also serves as the developer would answer a request the proxy did not
  // name — and record it against the developer. The operator states one
  // topology or the other.
  if (options.identityHeader !== undefined) {
    throw new Error(
      `CONSOLE_DEV_REVIEWER and CONSOLE_IDENTITY_HEADER are both set: a console`
        + ` cannot serve as a development reviewer and behind a proxy at once`,
    );
  }
  if (!SOURCE.test(options.moduleUrl)) {
    throw new Error(
      `CONSOLE_DEV_REVIEWER applies to a console run from source, and this one`
        + ` runs from compiled output (${options.moduleUrl})`,
    );
  }
  if (!isLoopback(options.host)) {
    throw new Error(
      `CONSOLE_DEV_REVIEWER applies to a console bound to loopback, and this one`
        + ` binds ${options.host}`,
    );
  }
  // The same rule the roster applies, and for the same reason: a value the
  // ledger would record as nobody cannot stand in for a reviewer. Refused
  // here rather than at the first request, because the operator is present.
  const identity = approverFrom(named);
  if (identity === UNATTRIBUTED) {
    throw new Error(
      `CONSOLE_DEV_REVIEWER holds a name the ledger would not record; got '${named}'`,
    );
  }
  return identity;
}
