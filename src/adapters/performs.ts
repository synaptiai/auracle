/**
 * What each egress adapter performs as an internal write, and what the
 * consumer sends with one (issue #144, DEC-06).
 *
 * The declarations live here, apart from the adapters, so a check can read
 * every adapter's without building one. The SMTP and FreeScout adapters read
 * their configuration from the environment when they are built. Each adapter
 * holds its own declaration from here, and a test holds the two to one value.
 *
 * It imports from the port, and the port imports nothing from here.
 */

import { COMPENSATION_ACTION_CLASS, type Performs } from './types.js';

export type { Performs };

/**
 * A close needs the ticket alone, a route needs the queue it moves to, and a
 * compensation needs its reason.
 */
export const HELPDESK_PERFORMS: Performs = new Map([
  ['close_ticket', []],
  ['route_ticket', ['queue']],
  [COMPENSATION_ACTION_CLASS, ['reason']],
]);

/** SMTP and FreeScout take no idempotency key, so they perform no internal write. */
export const PERFORMS_NOTHING: Performs = new Map();

/** The adapter a consumer runs when `EGRESS_ADAPTER` is unset. */
export const DEFAULT_EGRESS_ADAPTER = 'helpdesk';

/**
 * The entry a record holds under this name, and never a property every
 * object inherits. A name such as `constructor` is then unknown, as a name
 * nobody registered is.
 */
export function ownEntry<T>(record: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

/**
 * The entry a registry holds under a name a person set, or a refusal that
 * names the variable and every name it knows. Both entry points select their
 * adapter through it, so `constructor` is an unknown name in each.
 */
export function knownEntry<T>(record: Readonly<Record<string, T>>, name: string, variable: string): T {
  const entry = ownEntry(record, name);
  if (entry === undefined) {
    throw new Error(`unknown ${variable} '${name}' (known: ${Object.keys(record).join(', ')})`);
  }
  return entry;
}

/** Keyed by the name `EGRESS_ADAPTER` selects; a test holds the consumer's list to it. */
export const EGRESS_PERFORMS: Readonly<Record<string, Performs>> = Object.freeze({
  helpdesk: HELPDESK_PERFORMS,
  'imap-smtp': PERFORMS_NOTHING,
  freescout: PERFORMS_NOTHING,
});

/**
 * The payload every run of the consumer sends with its action. A route moves
 * the ticket to this queue, and a close ignores it.
 */
export const CONSUMER_ACTION_PAYLOAD: Readonly<Record<string, string>> = Object.freeze({
  queue: 'triaged',
});

/**
 * Whether a payload carries every field as a non-blank string: one with a
 * character other than a space. The helpdesk's own write asks only for a
 * non-empty one, so a record already queued keeps the rule it was written
 * under.
 */
export function carriesFields(
  payload: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): boolean {
  return fields.every((field) => {
    const value = payload[field];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

/** The classes an adapter runs with this payload, in name order. */
export function classesRun(performs: Performs, payload: Readonly<Record<string, unknown>>): string[] {
  return [...performs]
    .filter(([, fields]) => carriesFields(payload, fields))
    .map(([actionClass]) => actionClass)
    .sort();
}

/** `a`, `a or b`, `a, b or c`. */
export function eitherOf(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items.at(-1)!}`;
}

/** `a`, `a and b`, `a, b and c`. */
export function allOf(items: readonly string[]): string {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`;
}

/**
 * One sentence per class the adapter performs and this payload cannot run,
 * naming the fields it lacks, in class-name order. Empty when it runs them all.
 */
export function whatPayloadLacks(performs: Performs, payload: Readonly<Record<string, unknown>>): string {
  return [...performs]
    .filter(([, fields]) => !carriesFields(payload, fields))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([actionClass, fields]) => {
      const absent = fields.filter((field) => !carriesFields(payload, [field])).map((field) => `'${field}'`);
      return ` The consumer's payload lacks ${allOf(absent)} for ${actionClass}.`;
    })
    .join('');
}
