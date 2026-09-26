// Whether the consumer's egress adapter can perform the internal action its
// profile names, with the payload the consumer sends (issue #144).
//
// The relay performs every internal class through `performAction`. A class
// the adapter refuses there never completes: on an adapter that takes an
// idempotency key the relay leaves it pending on every scan, and on the
// automatic path the run already reads resolved. So the consumer refuses the
// profile at startup instead.
import { describe, expect, it } from 'vitest';

import { FreeScoutEgressAdapter } from '../adapters/freescout.js';
import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { SmtpEgressAdapter } from '../adapters/imap-smtp.js';
import {
  CONSUMER_ACTION_PAYLOAD, DEFAULT_EGRESS_ADAPTER, EGRESS_PERFORMS, knownEntry, ownEntry,
} from '../adapters/performs.js';
import { actionProfileFromEnv } from '../config/action-profile.js';
import { EGRESS_ADAPTER_NAMES, refuseUnperformedAction } from './consumer-main.js';

// The three real adapters. Their constructors store configuration and open
// nothing, so a placeholder configuration is enough to read a declaration.
const helpdesk = new HelpdeskAdapter();
const freescout = new FreeScoutEgressAdapter({
  baseUrl: 'http://127.0.0.1:1', apiKey: 'k', userId: 1, internalNote: false, timeoutMs: 1,
});
const smtp = new SmtpEgressAdapter({
  imap: { host: 'imap.example.test', port: 143, secure: false, user: 'u', pass: 'p' },
  smtp: { host: 'smtp.example.test', port: 25, secure: false },
  fromAddress: 'support@acme.example',
  draftsMailbox: 'Drafts',
});
const ADAPTERS = [helpdesk, freescout, smtp];

const HIDDEN = (actionClass: string): { actionClass: string; isCustomerVisible: boolean } =>
  ({ actionClass, isCustomerVisible: false });

/** The message a refusal throws, or '' when the consumer starts. */
function refusal(
  actionClass: string,
  env: NodeJS.ProcessEnv,
  ...rest: [payload?: Readonly<Record<string, unknown>>, registry?: Parameters<typeof refuseUnperformedAction>[4]]
): string {
  try {
    refuseUnperformedAction(HIDDEN(actionClass), env['EGRESS_ADAPTER'] ?? DEFAULT_EGRESS_ADAPTER, env, ...rest);
    return '';
  } catch (error) {
    return (error as Error).message;
  }
}

/** A profile that names its class and its adapter, as the environment would. */
const ON = (adapter: string, actionClass: string): NodeJS.ProcessEnv =>
  ({ EGRESS_ADAPTER: adapter, ACTION_CLASS: actionClass });

const REPLY_REMEDY = 'Set ACTION_CLASS=customer_reply, ACTION_IS_CUSTOMER_VISIBLE=true and a'
  + ' non-empty DISCLOSURE_TEXT (DEC-14) to draft customer replies.';

describe('the declarations the check reads', () => {
  it('are the ones each adapter holds, for every adapter the consumer can select', () => {
    expect([...EGRESS_ADAPTER_NAMES].sort()).toEqual(Object.keys(EGRESS_PERFORMS).sort());
    for (const adapter of ADAPTERS) {
      expect(adapter.performs).toBe(EGRESS_PERFORMS[adapter.name]);
    }
  });

  it('read an adapter name as its own entry, never as a property every object has', () => {
    expect(ownEntry(EGRESS_PERFORMS, 'helpdesk')).toBe(EGRESS_PERFORMS['helpdesk']);
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nope']) {
      expect(ownEntry(EGRESS_PERFORMS, name)).toBeUndefined();
    }
  });

  it('refuse an adapter name nobody registered, naming the ones that are', () => {
    const registry = { helpdesk: 1, 'imap-smtp': 2 };
    expect(knownEntry(registry, 'helpdesk', 'EGRESS_ADAPTER')).toBe(1);
    for (const name of ['helpdsk', 'constructor', 'toString', '__proto__', '']) {
      expect(() => knownEntry(registry, name, 'RELAY_ADAPTER'))
        .toThrow(`unknown RELAY_ADAPTER '${name}' (known: helpdesk, imap-smtp)`);
    }
  });

});

describe('refuseUnperformedAction', () => {
  it('checks no visible profile: the reply goes through the draft, not performAction', () => {
    const reply = { actionClass: 'customer_reply', isCustomerVisible: true };
    for (const adapter of ADAPTERS) {
      expect(() => refuseUnperformedAction(reply, adapter.name, { EGRESS_ADAPTER: adapter.name }))
        .not.toThrow();
    }
  });

  it('starts each hidden class the helpdesk runs with the payload the consumer sends', () => {
    for (const actionClass of ['route_ticket', 'close_ticket']) {
      expect(refusal(actionClass, ON('helpdesk', actionClass))).toBe('');
    }
    // The defaults: the helpdesk and a route.
    expect(refusal('route_ticket', {})).toBe('');
  });

  it('leaves an adapter name it does not know to the adapter selection', () => {
    for (const name of ['carrier-pigeon', 'constructor', 'toString', '__proto__']) {
      expect(refusal('route_ticket', ON(name, 'route_ticket'))).toBe('');
    }
  });

  it('refuses a class the adapter does not perform, naming the classes it does', () => {
    expect(refusal('refund', ON('helpdesk', 'refund'))).toBe(
      "ACTION_CLASS='refund' is not an action EGRESS_ADAPTER=helpdesk performs. It performs"
        + " close_ticket, compensate and route_ticket. The consumer's payload lacks 'reason' for"
        + ' compensate. Set ACTION_CLASS to close_ticket or route_ticket, which it runs with the'
        + " consumer's payload.",
    );
  });

  it('lists the classes in name order, whatever order the adapter declares', () => {
    const registry = {
      reversed: new Map<string, readonly string[]>([['route_ticket', []], ['close_ticket', []]]),
    };
    expect(refusal('refund', ON('reversed', 'refund'), CONSUMER_ACTION_PAYLOAD, registry))
      .toContain('It performs close_ticket and route_ticket. Set ACTION_CLASS to close_ticket or route_ticket,');
  });

  // Naming another adapter would send an operator to the helpdesk, the
  // in-memory reference adapter, while the relay still runs the real one.
  // So the only way out named here is the customer-reply profile.
  it('refuses every internal class on an adapter that performs none, naming no other adapter', () => {
    for (const adapter of [freescout, smtp]) {
      for (const actionClass of ['route_ticket', 'close_ticket', 'compensate', 'refund']) {
        expect(refusal(actionClass, ON(adapter.name, actionClass))).toBe(
          `EGRESS_ADAPTER=${adapter.name} performs no internal action, so it cannot run`
            + ` ACTION_CLASS='${actionClass}'. ${REPLY_REMEDY}`,
        );
      }
    }
  });

  it('marks a class and an adapter nobody set as the default', () => {
    expect(refusal('route_ticket', { EGRESS_ADAPTER: 'imap-smtp' }))
      .toContain("ACTION_CLASS='route_ticket' (the default).");
    expect(refusal('refund', { ACTION_CLASS: 'refund' }))
      .toContain("ACTION_CLASS='refund' is not an action EGRESS_ADAPTER=helpdesk (the default) performs.");
  });

  it('refuses a class whose payload field the consumer does not send', () => {
    // A compensation's reason comes from the adopter, so the consumer's fixed
    // payload never carries one.
    expect(refusal('compensate', ON('helpdesk', 'compensate'))).toBe(
      "EGRESS_ADAPTER=helpdesk needs a non-blank 'reason' to perform ACTION_CLASS='compensate',"
        + " and the consumer's payload does not carry it. Set ACTION_CLASS to close_ticket or"
        + " route_ticket, which it runs with the consumer's payload.",
    );
  });

  it('reads a blank or non-string field as missing', () => {
    for (const queue of ['', '   ', 3, null]) {
      expect(refusal('route_ticket', ON('helpdesk', 'route_ticket'), { queue }))
        .toMatch(/^EGRESS_ADAPTER=helpdesk needs a non-blank 'queue' to perform ACTION_CLASS='route_ticket', and the consumer's payload does not carry it\. /);
    }
  });

  it('names every missing field', () => {
    const registry = { two: new Map<string, readonly string[]>([['merge', ['into', 'reason']]]) };
    expect(refusal('merge', ON('two', 'merge'), {}, registry)).toMatch(
      /^EGRESS_ADAPTER=two needs a non-blank 'into' and 'reason' to perform ACTION_CLASS='merge', and the consumer's payload does not carry them\. /,
    );
  });

  // The profile check's way out of a visible internal class is to hide it.
  // It is offered only where EGRESS_ADAPTER runs the class, so the hidden
  // profile then passes this check too.
  it('follows the profile check\'s hide remedy into a consumer that starts', () => {
    let followed = 0;
    for (const adapter of ADAPTERS) {
      for (const actionClass of ['route_ticket', 'close_ticket', 'compensate', 'refund']) {
        let message = '';
        try {
          actionProfileFromEnv({
            ACTION_CLASS: actionClass, ACTION_IS_CUSTOMER_VISIBLE: 'true', DISCLOSURE_TEXT: 'd',
            EGRESS_ADAPTER: adapter.name,
          });
        } catch (error) {
          message = (error as Error).message;
        }
        if (!/set ACTION_IS_CUSTOMER_VISIBLE=false/.test(message)) continue;
        expect(refusal(actionClass, ON(adapter.name, actionClass)), message).toBe('');
        followed++;
      }
    }
    // Only the helpdesk runs a route and a close.
    expect(followed).toBe(2);
  });

  // Every remedy names only what then starts. Each one in each message is
  // parsed from the text and followed literally, and the result passes this
  // check and the profile's.
  it('names only remedies that make the consumer start', () => {
    let followed = 0;
    for (const adapter of ADAPTERS) {
      for (const actionClass of ['refund', 'compensate', 'route_ticket', 'close_ticket']) {
        const message = refusal(actionClass, ON(adapter.name, actionClass));
        if (message === '') continue;
        const classes = /Set ACTION_CLASS to (.*?), which it runs/.exec(message);
        for (const next of classes === null ? [] : classes[1]!.split(/, | or /)) {
          expect(refusal(next, ON(adapter.name, next)), message).toBe('');
          followed++;
        }
        const reply = /Set (ACTION_CLASS=\w+), (ACTION_IS_CUSTOMER_VISIBLE=\w+) and a non-empty (DISCLOSURE_TEXT)/.exec(message);
        if (reply !== null) {
          const env: NodeJS.ProcessEnv = { EGRESS_ADAPTER: adapter.name, [reply[3]!]: 'reviewed by a person' };
          for (const setting of [reply[1]!, reply[2]!]) {
            const [name, value] = setting.split('=');
            env[name!] = value;
          }
          const profile = actionProfileFromEnv(env);
          expect(() => refuseUnperformedAction(profile, adapter.name, env), message).not.toThrow();
          followed++;
        }
        expect(classes !== null || reply !== null, message).toBe(true);
      }
    }
    // Counted by hand. The helpdesk refuses refund and compensate, each
    // naming close_ticket and route_ticket: 4. FreeScout and SMTP each refuse
    // all four classes with the reply profile: 8.
    expect(followed).toBe(4 + 8);
  });
});
