/**
 * The `Host` values this console answers to (issue #27).
 *
 * Its own module for the reason `ledger-name.ts` is: `main.ts` runs `main()`
 * when it is imported, so nothing there can be reached from a test. This
 * function decides who may reach an approval, and a rule that decides that
 * has to be testable on its own.
 *
 * Checking `Host` is what closes DNS rebinding, and `server.ts` explains why.
 * The names below are what that check compares against.
 */

/**
 * Whether the operator named the hosts themselves.
 *
 * Read here rather than in the caller, because the exclusivity rule below
 * turns on it and the two must not drift apart.
 */
function named(): readonly string[] {
  return (process.env['CONSOLE_ALLOWED_HOSTS'] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * The names this console answers to, derived from the bind or stated outright.
 *
 * The derivation alone was not enough, and each gap refused every request
 * while the console looked healthy:
 *
 *   - a reverse proxy forwards its own name, and the runbook recommends one;
 *   - an IPv6 bind produced `:::8787` where a browser sends `[::1]:8787`;
 *   - `0.0.0.0` is a bind address and never a `Host`;
 *   - on port 80 or 443 the browser omits the port entirely.
 *
 * `CONSOLE_ALLOWED_HOSTS` replaces the derived names rather than joining
 * them. It used to add to them, and that made the variable unable to do the
 * one job the runbook gives it. An operator who puts an authenticating proxy
 * in front and binds the console off loopback expects a console that answers
 * the proxy and nobody else. While the loopback names stayed in the set, a
 * request that reached the port directly passed the check by sending
 * `Host: localhost:8787`, and the approval behind it sends a customer reply
 * that cannot be recalled (DEC-12, DEC-14).
 *
 * So naming any host makes the list exactly those hosts. An operator who
 * wants loopback as well names it too, and then the set says so.
 */
export function allowedHosts(host: string, port: number): string[] {
  const names = new Set<string>();
  const add = (name: string): void => {
    names.add(`${name}:${port}`);
    // The browser omits the default port for the scheme.
    if (port === 80 || port === 443) names.add(name);
  };
  const stated = named();
  for (const name of stated) {
    // A `Host` header is a name and a port, never a URL. An entry carrying a
    // scheme or a path matches nothing, so every request is refused while the
    // console reports itself healthy. Refuse it by name instead.
    if (/[/\s]/.test(name)) {
      throw new Error(
        `CONSOLE_ALLOWED_HOSTS takes a host and a port, not a URL; got '${name}'`,
      );
    }
    names.add(name.toLowerCase());
  }
  if (stated.length > 0) return [...names];
  for (const name of ['127.0.0.1', 'localhost', '[::1]']) add(name);
  // A wildcard bind is not a name anyone sends.
  if (host !== '0.0.0.0' && host !== '::') {
    add(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host);
  }
  return [...names];
}

/**
 * The header a trusted proxy sets to name the approver, or undefined (DEC-42).
 *
 * One variable, and it says what it means. An earlier version read the header
 * whenever `CONSOLE_ALLOWED_HOSTS` was set, on the reasoning that naming a
 * host says a proxy is in front. It does not: the comment above lists two
 * reasons an operator names hosts with no proxy anywhere — an IPv6 bind that
 * sends `[::1]:8787`, and a default port the browser omits. An operator who
 * named hosts for either of those and also named a header got a console where
 * anyone reaching the port names themselves as the approver.
 *
 * So the operator states the trust outright. `CONSOLE_IDENTITY_HEADER` means
 * "a proxy I trust sets this header, and strips any copy a client sent". A
 * console cannot check that from inside, and a variable that is only ever set
 * deliberately is the closest thing to a statement of it.
 *
 * The rest of the rule lives where it can be enforced: `approverFrom` in
 * `server.ts` refuses a value that arrived more than once, because a proxy
 * that appends rather than replaces is the failure this cannot otherwise see.
 *
 * Here rather than in the server, and beside `allowedHosts` because both are
 * read from the environment at startup. `main.ts` runs `main()` on import, so
 * a decision left there is a decision nothing can test.
 */
export function identityHeader(): string | undefined {
  const header = (process.env['CONSOLE_IDENTITY_HEADER'] ?? '').trim();
  return header === '' ? undefined : header.toLowerCase();
}
