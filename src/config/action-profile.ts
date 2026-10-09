// The consumer's per-run action profile, parsed from the environment
// (section 4.3). Lives outside the daemon entrypoint so startup validation is
// unit-testable without executing main().
//
// DEC-14: a customer-visible profile must carry a non-empty DISCLOSURE_TEXT,
// so a missing one fails fast here, before any state change.
//
// The class and the visibility must agree. The relay sends a parked draft only
// for the customer reply class, and performs every other class as an internal
// write (DEC-11, DEC-12). A visible profile with another class parks a draft
// that is never sent. The reply class shown to no customer is gated as an
// internal write, so one that is not high risk can skip approval (DEC-12).
// Either way it parks no draft, and the relay refuses its record.
import {
  CONSUMER_ACTION_PAYLOAD, DEFAULT_EGRESS_ADAPTER, EGRESS_PERFORMS, classesRun, ownEntry,
} from '../adapters/performs.js';
import { CUSTOMER_REPLY_ACTION_CLASS } from '../adapters/types.js';

/** DEC-14 fallback disclosure for non-customer-visible profiles. */
export const DEFAULT_DISCLOSURE =
  'This reply was drafted by an automated assistant and reviewed by a person.';

const DELIVERIES = ['at_least_once', 'at_most_once'] as const;

/**
 * The characters a value cannot rest on: spaces, control and format characters,
 * and every default-ignorable code point, a Hangul filler among them. Five
 * more carry none of those properties and are named. Unicode defines U+13441
 * and U+13442 as hieroglyph blanks. The other three are the Khitan filler, the
 * Duployan letter selector and the Tifinagh consonant joiner. They came from a
 * scan of every code point under Node 26.7 (Unicode 17), read by category,
 * with names checked against Unicode 16. Both checks remove all of these, so a
 * value still needs a letter or digit, and `customer_reply` plus one of them
 * is a near-miss.
 */
const IGNORABLE =
  /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Z}\s\u{13441}\u{13442}\u{16FE4}\u{1BC9D}\u{2D7F}]/gu;

/**
 * Whether a value shows nothing: no letter or digit is left once the
 * ignorable characters are gone. `trim` keeps a zero-width space, and a
 * braille blank is a symbol, so a class or a disclosure made of either would
 * pass for present.
 */
function isVisiblyEmpty(value: string): boolean {
  return !/[\p{L}\p{N}]/u.test(value.normalize('NFKC').replace(IGNORABLE, ''));
}

/**
 * A value as a message quotes it: every character outside printable ASCII is
 * written as its code point, `<U+200B>`, so an invisible one shows in the
 * refusal. The CLI escapes a backslash again, so the form uses none.
 */
export function shown(value: string): string {
  return value.replace(
    /[^\x20-\x7e]/gu,
    (char) => `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`,
  );
}

export interface ActionProfile {
  actionClass: string;
  delivery: (typeof DELIVERIES)[number];
  isCustomerVisible: boolean;
  disclosure: string;
}

/**
 * Reads the four ACTION_* / DISCLOSURE_TEXT variables. Every malformed value
 * throws naming its variable, and a class and visibility that disagree throw
 * naming both, so a misconfigured deployment stops at startup.
 */
export function actionProfileFromEnv(env: NodeJS.ProcessEnv = process.env): ActionProfile {
  const actionClass = env['ACTION_CLASS'] ?? 'route_ticket';
  if (actionClass.length === 0) {
    throw new Error('ACTION_CLASS must not be empty.');
  }
  if (isVisiblyEmpty(actionClass)) {
    throw new Error(`ACTION_CLASS must hold a letter or digit, got '${shown(actionClass)}'.`);
  }

  const rawDelivery = env['ACTION_DELIVERY'] ?? 'at_most_once';
  const isDelivery = (
    value: string,
  ): value is (typeof DELIVERIES)[number] =>
    DELIVERIES.includes(value as (typeof DELIVERIES)[number]);
  if (!isDelivery(rawDelivery)) {
    throw new Error(
      `ACTION_DELIVERY must be one of ${DELIVERIES.join(', ')}, got '${shown(rawDelivery)}'`,
    );
  }
  const delivery: (typeof DELIVERIES)[number] = rawDelivery;

  const rawVisible = env['ACTION_IS_CUSTOMER_VISIBLE'] ?? 'false';
  if (rawVisible !== 'true' && rawVisible !== 'false') {
    throw new Error(
      `ACTION_IS_CUSTOMER_VISIBLE must be 'true' or 'false', got '${shown(rawVisible)}'`,
    );
  }
  const isCustomerVisible = rawVisible === 'true';

  const rawDisclosure = env['DISCLOSURE_TEXT'];
  // A blank disclosure is no disclosure: a visible profile refuses it, and a
  // hidden one takes the default.
  const disclosure = rawDisclosure !== undefined && !isVisiblyEmpty(rawDisclosure)
    ? rawDisclosure
    : undefined;
  const disclosed = disclosure !== undefined;

  // The settings a reply profile still lacks, so a remedy names every setting
  // the next start checks and an operator who follows it starts.
  const toReply = (setClass: boolean): string => {
    const settings = [
      ...(setClass ? [`ACTION_CLASS=${CUSTOMER_REPLY_ACTION_CLASS}`] : []),
      ...(isCustomerVisible ? [] : ['ACTION_IS_CUSTOMER_VISIBLE=true']),
    ];
    const withDisclosure = disclosed ? '' : ' with a non-empty DISCLOSURE_TEXT (DEC-14)';
    return `Set ${settings.join(' and ')}${withDisclosure}`;
  };
  // A value nobody set reads as the default, and the message says so, so an
  // operator does not look for a setting no file contains.
  const byDefault = (name: string): string => (env[name] === undefined ? ' (the default)' : '');

  // Compared exactly, as the relay compares it: a class spelled any other way
  // is an internal write there. A spelling that differs from the reply class
  // only in case, spacing, punctuation, symbols, compatibility forms or an
  // invisible character is refused on its own, whatever the visibility,
  // because an operator who wrote it meant the reply.
  const folded = actionClass.normalize('NFKC').toLowerCase()
    .replace(IGNORABLE, '')
    .replace(/[\p{P}\p{S}]/gu, '');
  if (actionClass !== CUSTOMER_REPLY_ACTION_CLASS
    && folded === CUSTOMER_REPLY_ACTION_CLASS.replace(/_/g, '')) {
    throw new Error(
      `ACTION_CLASS='${shown(actionClass)}' is not ${CUSTOMER_REPLY_ACTION_CLASS}. The relay`
        + ' compares the class exactly, so it runs this class as an internal write.'
        + ` ${toReply(true)}.`,
    );
  }
  const repliesToCustomer = actionClass === CUSTOMER_REPLY_ACTION_CLASS;
  if (isCustomerVisible && !repliesToCustomer) {
    // The hidden way out is named only where the consumer's own adapter runs
    // the class with its payload, so an operator who takes it is not refused at
    // the next check. None runs a compensation with that payload.
    const egressName = env['EGRESS_ADAPTER'] ?? DEFAULT_EGRESS_ADAPTER;
    const runsHere = classesRun(ownEntry(EGRESS_PERFORMS, egressName) ?? new Map(), CONSUMER_ACTION_PAYLOAD)
      .includes(actionClass);
    const hide = runsHere
      ? ` Or, on EGRESS_ADAPTER=${egressName}${byDefault('EGRESS_ADAPTER')}, set`
        + ' ACTION_IS_CUSTOMER_VISIBLE=false: the write then runs without approval wherever the'
        + ' gates pass (DEC-12).'
      : '';
    throw new Error(
      `ACTION_IS_CUSTOMER_VISIBLE=true needs ACTION_CLASS=${CUSTOMER_REPLY_ACTION_CLASS},`
        + ` got ACTION_CLASS='${shown(actionClass)}'${byDefault('ACTION_CLASS')}. The relay sends`
        + ` a draft only for ${CUSTOMER_REPLY_ACTION_CLASS}, so an approved reply under`
        + ' another class never reaches the customer (DEC-11, DEC-12).'
        + ` ${toReply(true)} to draft customer replies.${hide}`,
    );
  }
  if (repliesToCustomer && !isCustomerVisible) {
    throw new Error(
      `ACTION_CLASS=${CUSTOMER_REPLY_ACTION_CLASS} needs ACTION_IS_CUSTOMER_VISIBLE=true,`
        + ` got ACTION_IS_CUSTOMER_VISIBLE=false${byDefault('ACTION_IS_CUSTOMER_VISIBLE')}.`
        + ' A reply shown to no customer can skip approval, and it parks no draft the'
        + ` relay can send (DEC-11, DEC-12, DEC-34). ${toReply(false)}.`,
    );
  }

  if (isCustomerVisible && !disclosed) {
    throw new Error(
      'DISCLOSURE_TEXT is required when ACTION_IS_CUSTOMER_VISIBLE=true (DEC-14),'
        + ` got ${rawDisclosure === undefined ? 'DISCLOSURE_TEXT unset' : 'a blank DISCLOSURE_TEXT'}.`,
    );
  }

  return {
    actionClass,
    delivery,
    isCustomerVisible,
    disclosure: disclosure ?? DEFAULT_DISCLOSURE,
  };
}
