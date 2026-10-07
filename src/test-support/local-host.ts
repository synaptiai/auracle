// The one rule a test run uses before it changes a server it did not start:
// the server is on this machine, or a person said it is disposable.
import { driverParameters } from '../db/driver-parameters.js';

/** Hosts a test run may change without being asked twice. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Refuses unless `host` is this machine or `allowVar` is '1'.
 *
 * `refusal` says what the run would do there, and `hint` any other way out.
 * The message adds the host and the variable that allows it.
 */
export function assertLocalHost(host: string, allowVar: string, refusal: string, hint = ''): void {
  if (LOCAL_HOSTS.has(host)) return;
  if (process.env[allowVar] === '1') return;
  throw new Error(
    `${refusal} on '${host}', and this host is not this machine. ${hint}`
      + `Set ${allowVar}=1 when the server really is disposable.`,
  );
}

/**
 * The host the driver connects to for a Postgres connection URI. Read from
 * the driver's own parse, because the URL alone can mislead: a `host` query
 * parameter replaces the host before the path, `hostaddr` is ignored, and an
 * empty host falls back to PGHOST. A socket path is on this machine.
 */
export function postgresHost(url: string): string {
  const host = driverParameters(url).host;
  return host.startsWith('/') ? 'localhost' : host;
}
