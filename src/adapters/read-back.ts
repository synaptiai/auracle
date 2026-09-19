// The adapters an approval can read a parked draft back from (section 4.10).
//
// One map, for both approval paths. The command line held it inside its entry
// point, and a barrel may not re-export a module that starts a process, so the
// console could not share it. A second copy would drift, and the copy that
// drifted would read back from a system the relay does not send through.
//
// Selecting an adapter opens no connection. Each one connects when it is
// asked to read, so a caller can build it at startup and refuse a bad
// configuration before it serves anything.
import { FreeScoutEgressAdapter, freeScoutConfigFromEnv } from './freescout.js';
import { HelpdeskAdapter } from './helpdesk.js';
import { SmtpEgressAdapter, imapSmtpConfigFromEnv } from './imap-smtp.js';
import type { AdapterCapabilities, DraftReadBack } from './types.js';

/**
 * An adapter an approval reads back through, with the declaration it made.
 *
 * The capabilities travel because an approval asks its adapter one question
 * beyond reading a draft: whether the ledger holds the reply it must send
 * (DEC-44). Reading that flag from the environment instead would be a second
 * copy of a rule that moves with the adapter's own configuration.
 */
export type ReadBackAdapter = DraftReadBack & {
  readonly capabilities: AdapterCapabilities;
};

const READ_BACK_ADAPTERS: Readonly<Record<string, (env: NodeJS.ProcessEnv) => ReadBackAdapter>> = {
  helpdesk: () => new HelpdeskAdapter(),
  'imap-smtp': (env) => new SmtpEgressAdapter(imapSmtpConfigFromEnv(env)),
  freescout: (env) => new FreeScoutEgressAdapter(freeScoutConfigFromEnv(env)),
};

/** The names `APPROVE_ADAPTER` accepts, in the order a refusal lists them. */
export const READ_BACK_ADAPTER_NAMES: readonly string[] = Object.keys(READ_BACK_ADAPTERS);

/**
 * The read-back adapter a name selects, configured from `env`.
 *
 * Throws on a name it does not know, and on a configuration the adapter
 * refuses. `Object.hasOwn`, because a bare read of a plain record resolves
 * `toString` to a function.
 *
 * Returns the adapter itself, not only its read port, so a caller that needs
 * the declaration beside the port builds one adapter and reads both.
 */
export function selectReadBackAdapter(name: string, env: NodeJS.ProcessEnv): ReadBackAdapter {
  if (!Object.hasOwn(READ_BACK_ADAPTERS, name)) {
    throw new Error(
      `unknown APPROVE_ADAPTER '${name}' (known: ${READ_BACK_ADAPTER_NAMES.join(', ')})`,
    );
  }
  return READ_BACK_ADAPTERS[name]!(env);
}
