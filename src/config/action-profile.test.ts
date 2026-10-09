// Unit tests for the consumer's env-driven action profile (section 4.3).
// Pure: every case passes its own env object, so nothing touches process.env.
import { describe, expect, it } from 'vitest';

import { DEFAULT_DISCLOSURE, actionProfileFromEnv } from './action-profile.js';

type ProfileEnv = Record<string, string | undefined>;

function envWith(vars: ProfileEnv): NodeJS.ProcessEnv {
  return vars;
}

/**
 * Characters that show nothing, one from each family a check could miss: a
 * zero-width space, a byte-order mark, a combining grapheme joiner, a
 * variation selector, a Hangul filler (a letter by category), a control
 * character, a braille blank (a symbol by category), and a format character
 * that is not default-ignorable. Then the five the profile names and removes
 * before both checks: the two hieroglyph blanks, the Khitan filler, the
 * Duployan letter selector and the Tifinagh consonant joiner.
 */
const INVISIBLE = [
  0x200b, 0xfeff, 0x034f, 0xfe0f, 0x3164, 0x0001, 0x2800, 0x13430,
  0x13441, 0x13442, 0x16fe4, 0x1bc9d, 0x2d7f,
].map((point) => String.fromCodePoint(point));

describe('actionProfileFromEnv', () => {
  it('falls back to the route_ticket defaults when no variable is set', () => {
    expect(actionProfileFromEnv(envWith({}))).toEqual({
      actionClass: 'route_ticket',
      delivery: 'at_most_once',
      isCustomerVisible: false,
      disclosure: DEFAULT_DISCLOSURE,
    });
  });

  it('throws naming ACTION_CLASS when it is empty or blank', () => {
    expect(() => actionProfileFromEnv(envWith({ ACTION_CLASS: '' })))
      .toThrow('ACTION_CLASS must not be empty.');
    // An invisible character alone is as blank as a space, and the message
    // shows what it read.
    const blanks: Array<[string, string]> = [
      ['   ', '   '],
      ...INVISIBLE.map((char): [string, string] =>
        [char, `<U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`]),
    ];
    for (const [value, read] of blanks) {
      expect(() => actionProfileFromEnv(envWith({ ACTION_CLASS: value })))
        .toThrow(`ACTION_CLASS must hold a letter or digit, got '${read}'.`);
    }
    // Visible, and still no class: the message does not call it blank.
    expect(() => actionProfileFromEnv(envWith({ ACTION_CLASS: '-' })))
      .toThrow("ACTION_CLASS must hold a letter or digit, got '-'.");
  });

  it('throws naming ACTION_DELIVERY, the rules and the value on an unknown rule', () => {
    const cases: Array<[string, string]> = [
      ['sometimes', 'sometimes'], ['', ''],
      // A trailing invisible character shows, so the value is not misread.
      [`at_most_once${INVISIBLE[0]!}`, 'at_most_once<U+200B>'],
    ];
    for (const [value, read] of cases) {
      expect(() => actionProfileFromEnv(envWith({ ACTION_DELIVERY: value }))).toThrow(
        `ACTION_DELIVERY must be one of at_least_once, at_most_once, got '${read}'`,
      );
    }
  });

  it('throws naming ACTION_IS_CUSTOMER_VISIBLE and the value on a non-boolean value', () => {
    // Exact spellings only: an upper-case TRUE is not read as true.
    const cases: Array<[string, string]> = [
      ['maybe', 'maybe'], ['TRUE', 'TRUE'], ['', ''],
      [`true${INVISIBLE[0]!}`, 'true<U+200B>'],
    ];
    for (const [value, read] of cases) {
      expect(() => actionProfileFromEnv(envWith({ ACTION_IS_CUSTOMER_VISIBLE: value })))
        .toThrow(`ACTION_IS_CUSTOMER_VISIBLE must be 'true' or 'false', got '${read}'`);
    }
  });

  it('accepts the two valid delivery rules and both visibility values', () => {
    for (const delivery of ['at_most_once', 'at_least_once']) {
      for (const visible of ['true', 'false']) {
        // Each visibility with the one class it pairs with.
        const profile = actionProfileFromEnv(
          envWith({
            ACTION_CLASS: visible === 'true' ? 'customer_reply' : 'route_ticket',
            ACTION_DELIVERY: delivery,
            ACTION_IS_CUSTOMER_VISIBLE: visible,
            DISCLOSURE_TEXT: 'reviewed by a person',
          }),
        );
        expect(profile).toEqual({
          actionClass: visible === 'true' ? 'customer_reply' : 'route_ticket',
          delivery,
          isCustomerVisible: visible === 'true',
          disclosure: 'reviewed by a person',
        });
      }
    }
  });

  it('DEC-14: throws naming DISCLOSURE_TEXT when visible and missing', () => {
    expect(() =>
      actionProfileFromEnv(
        envWith({ ACTION_CLASS: 'customer_reply', ACTION_IS_CUSTOMER_VISIBLE: 'true' }),
      ),
    ).toThrow(
      'DISCLOSURE_TEXT is required when ACTION_IS_CUSTOMER_VISIBLE=true (DEC-14),'
        + ' got DISCLOSURE_TEXT unset.',
    );
  });

  it('DEC-14: throws when visible and DISCLOSURE_TEXT is blank', () => {
    // A disclosure nobody can see is no disclosure: spaces, a zero-width
    // space and a byte-order mark alone are all blank.
    for (const blank of ['   ', ...INVISIBLE, `${INVISIBLE[1]!} ${INVISIBLE[4]!}`]) {
      expect(() =>
        actionProfileFromEnv(
          envWith({
            ACTION_CLASS: 'customer_reply',
            ACTION_IS_CUSTOMER_VISIBLE: 'true',
            DISCLOSURE_TEXT: blank,
          }),
        ),
      ).toThrow(
        'DISCLOSURE_TEXT is required when ACTION_IS_CUSTOMER_VISIBLE=true (DEC-14),'
          + ' got a blank DISCLOSURE_TEXT.',
      );
    }
  });

  it('uses the default disclosure when a hidden profile sets a blank one', () => {
    for (const blank of ['', '   ', ...INVISIBLE]) {
      expect(actionProfileFromEnv(envWith({ DISCLOSURE_TEXT: blank })).disclosure)
        .toBe(DEFAULT_DISCLOSURE);
    }
  });
});

// The relay sends an approved draft only for the customer reply class, and
// every other class it performs as an internal write. So a customer-visible
// profile with another class parks a draft that is never sent. The reply class
// without visibility can skip approval, and it parks no draft to send.
describe('the pairing of ACTION_CLASS and ACTION_IS_CUSTOMER_VISIBLE', () => {
  const DISCLOSED = 'reviewed by a person';

  it('refuses a visible profile whose class the relay does not send as a draft', () => {
    // The default class and the two other internal writes the helpdesk
    // performs. An unset class is the default, and the message says so.
    const cases: Array<[string | undefined, string]> = [
      [undefined, "'route_ticket' (the default)"],
      ['close_ticket', "'close_ticket'"],
      ['compensate', "'compensate'"],
      // An invisible character shows in both places the message quotes it.
      [`route_ticket${INVISIBLE[0]!}`, "'route_ticket<U+200B>'"],
    ];
    for (const [set, read] of cases) {
      const run = (): unknown => actionProfileFromEnv(envWith({
        ACTION_CLASS: set,
        ACTION_IS_CUSTOMER_VISIBLE: 'true',
        DISCLOSURE_TEXT: DISCLOSED,
      }));
      expect(run).toThrow(
        `ACTION_IS_CUSTOMER_VISIBLE=true needs ACTION_CLASS=customer_reply, got ACTION_CLASS=${read}.`,
      );
      // The second way out keeps what a routing deployment does, and it is
      // named only where EGRESS_ADAPTER, here the default helpdesk, runs the
      // class with the consumer's payload: a route and a close. No adapter
      // runs a compensation with it, or a class spelled with an invisible
      // character.
      const reply = 'Set ACTION_CLASS=customer_reply to draft customer replies.';
      const hide = ' Or, on EGRESS_ADAPTER=helpdesk (the default), set'
        + ' ACTION_IS_CUSTOMER_VISIBLE=false: the write then runs without approval wherever the'
        + ' gates pass (DEC-12).';
      const runnable = set === undefined || set === 'close_ticket';
      let message = '';
      try {
        run();
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message.endsWith(runnable ? `${reply}${hide}` : reply), message).toBe(true);
    }
  });

  it('offers no hide remedy on an adapter name that is a property every object has', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      expect(() => actionProfileFromEnv(envWith({
        ACTION_CLASS: 'route_ticket', ACTION_IS_CUSTOMER_VISIBLE: 'true',
        DISCLOSURE_TEXT: DISCLOSED, EGRESS_ADAPTER: name,
      }))).toThrow(/Set ACTION_CLASS=customer_reply to draft customer replies\.$/);
    }
  });

  it('refuses the customer reply class when it is not customer visible', () => {
    const cases: Array<[string | undefined, string]> = [
      ['false', 'false'],
      [undefined, 'false (the default)'],
    ];
    for (const [visible, read] of cases) {
      expect(() => actionProfileFromEnv(envWith({
        ACTION_CLASS: 'customer_reply',
        ACTION_IS_CUSTOMER_VISIBLE: visible,
        DISCLOSURE_TEXT: DISCLOSED,
      }))).toThrow(
        `ACTION_CLASS=customer_reply needs ACTION_IS_CUSTOMER_VISIBLE=true, got ACTION_IS_CUSTOMER_VISIBLE=${read}.`
          + ' A reply shown to no customer can skip approval, and it parks no draft the'
          + ' relay can send (DEC-11, DEC-12, DEC-34). Set ACTION_IS_CUSTOMER_VISIBLE=true.',
      );
    }
  });

  it('refuses a spelling of the reply class the relay does not read as a reply', () => {
    // The relay compares the class exactly, so these run as internal writes
    // there, whatever the visibility says. Case, spacing, punctuation,
    // symbols, compatibility forms and invisible characters: each one reads
    // as the reply to a person and as another class to the relay.
    const zeroWidth = INVISIBLE[0]!;
    for (const spelled of [
      ' customer_reply', 'Customer_Reply', 'CUSTOMER_REPLY ', 'customer-reply',
      'customer reply', 'customer_ reply', 'customerReply', `customer_reply${zeroWidth}`,
      `customer_reply${INVISIBLE[2]!}`, `customer_reply${INVISIBLE[3]!}`,
      `customer_reply${INVISIBLE[4]!}`, `customer_reply${INVISIBLE[5]!}`,
      'customer$reply', 'CUSTOMER_REPLY'.replace('C', String.fromCodePoint(0xff23)),
      `customer_reply${INVISIBLE[7]!}`, `customer_reply${INVISIBLE[8]!}`,
      `customer_reply${INVISIBLE[10]!}`, `customer_reply${INVISIBLE[11]!}`,
      `customer_reply${INVISIBLE[12]!}`,
    ]) {
      // The message writes every character outside printable ASCII as its
      // code point, so an invisible one shows. Each form is written by hand.
      const byHand: Record<string, string> = {
        [`customer_reply${zeroWidth}`]: 'customer_reply<U+200B>',
        [`customer_reply${INVISIBLE[2]!}`]: 'customer_reply<U+034F>',
        [`customer_reply${INVISIBLE[3]!}`]: 'customer_reply<U+FE0F>',
        [`customer_reply${INVISIBLE[4]!}`]: 'customer_reply<U+3164>',
        [`customer_reply${INVISIBLE[5]!}`]: 'customer_reply<U+0001>',
        ['CUSTOMER_REPLY'.replace('C', String.fromCodePoint(0xff23))]: '<U+FF23>USTOMER_REPLY',
        [`customer_reply${INVISIBLE[7]!}`]: 'customer_reply<U+13430>',
        [`customer_reply${INVISIBLE[8]!}`]: 'customer_reply<U+13441>',
        [`customer_reply${INVISIBLE[10]!}`]: 'customer_reply<U+16FE4>',
        [`customer_reply${INVISIBLE[11]!}`]: 'customer_reply<U+1BC9D>',
        [`customer_reply${INVISIBLE[12]!}`]: 'customer_reply<U+2D7F>',
      };
      const shown = byHand[spelled] ?? spelled;
      for (const visible of ['true', 'false']) {
        let message = '';
        try {
          actionProfileFromEnv(envWith({
            ACTION_CLASS: spelled,
            ACTION_IS_CUSTOMER_VISIBLE: visible,
            DISCLOSURE_TEXT: DISCLOSED,
          }));
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toBe(
          `ACTION_CLASS='${shown}' is not customer_reply. The relay compares the class`
            + ' exactly, so it runs this class as an internal write. Set'
            + ` ACTION_CLASS=customer_reply${visible === 'true' ? '' : ' and ACTION_IS_CUSTOMER_VISIBLE=true'}.`,
        );
      }
    }
  });

  // Each remedy names every setting the next start checks, not only the one
  // this check read. So an operator who follows it is not refused again.
  it('names a remedy that makes the profile start', () => {
    const refused: ProfileEnv[] = [];
    for (const disclosure of [DISCLOSED, undefined, '  ']) {
      for (const visible of ['true', 'false', undefined]) {
        for (const actionClass of ['Customer_Reply', 'route_ticket', 'customer_reply', undefined]) {
          refused.push({
            ACTION_CLASS: actionClass,
            ACTION_IS_CUSTOMER_VISIBLE: visible,
            DISCLOSURE_TEXT: disclosure,
          });
        }
      }
    }
    let followed = 0;
    let started = 0;
    let undisclosed = 0;
    for (const env of refused) {
      let message: string;
      try {
        actionProfileFromEnv(envWith(env));
        started++;
        continue;
      } catch (error) {
        message = (error as Error).message;
      }
      // The first remedy is the reply profile, so it is the one to follow.
      const remedy = /Set (.*?)(?: to draft customer replies|\.$)/.exec(message);
      if (remedy === null) {
        // The DEC-14 refusal names its own setting, and nothing else is left.
        expect(message).toMatch(/^DISCLOSURE_TEXT is required/);
        undisclosed++;
        continue;
      }
      const fixed: ProfileEnv = { ...env };
      const [settings, disclosed] = remedy[1]!.split(' with a non-empty DISCLOSURE_TEXT');
      for (const setting of settings!.split(' and ')) {
        const [name, value] = setting.split('=');
        fixed[name!] = value;
      }
      if (disclosed !== undefined) fixed['DISCLOSURE_TEXT'] = DISCLOSED;
      expect(() => actionProfileFromEnv(envWith(fixed)), message).not.toThrow();
      followed++;
    }
    // Counted by hand over the 36 profiles. The near-miss class is refused in
    // all 9 of its own. route_ticket, set or by default, shown to a customer
    // is refused in 2 x 3. The reply class hidden, false or by default, is
    // refused in 2 x 3. The reply class shown with no disclosure gets the
    // DEC-14 refusal, which names no remedy.
    expect(followed).toBe(9 + 6 + 6);
    // The rest: the reply class shown with each of the 2 missing disclosures,
    // and 13 that start. Those are route_ticket, set or by default, hidden in
    // 2 x 2 x 3, and the reply class shown with the one real disclosure.
    expect(undisclosed).toBe(2);
    expect(started).toBe(2 * 2 * 3 + 1);
  });

  it('names the pairing before the missing disclosure', () => {
    expect(() => actionProfileFromEnv(envWith({ ACTION_IS_CUSTOMER_VISIBLE: 'true' })))
      .toThrow(/^ACTION_IS_CUSTOMER_VISIBLE=true needs ACTION_CLASS=customer_reply/);
  });

  it('starts a class that keeps a letter the reply class lacks', () => {
    // The near-miss fold drops only case, spacing, punctuation, symbols,
    // compatibility forms and invisible characters. An accented letter is
    // part of another class.
    for (const actionClass of ['customer_repl' + String.fromCharCode(0xe9), 'customer_reply_' + String.fromCharCode(0xfc)]) {
      expect(actionProfileFromEnv(envWith({ ACTION_CLASS: actionClass })).actionClass)
        .toBe(actionClass);
    }
  });

  // Whether the adapter performs an internal class is not checked here: the
  // profile reads the environment alone, and the relay refuses a class its
  // adapter lacks.
  it('starts every internal class hidden, and the reply class shown', () => {
    for (const actionClass of ['route_ticket', 'close_ticket', 'compensate']) {
      for (const visible of [undefined, 'false']) {
        expect(actionProfileFromEnv(envWith({
          ACTION_CLASS: actionClass,
          ACTION_IS_CUSTOMER_VISIBLE: visible,
        }))).toEqual({
          actionClass,
          delivery: 'at_most_once',
          isCustomerVisible: false,
          disclosure: DEFAULT_DISCLOSURE,
        });
      }
    }
    expect(actionProfileFromEnv(envWith({
      ACTION_CLASS: 'customer_reply',
      ACTION_IS_CUSTOMER_VISIBLE: 'true',
      DISCLOSURE_TEXT: DISCLOSED,
    }))).toEqual({
      actionClass: 'customer_reply',
      delivery: 'at_most_once',
      isCustomerVisible: true,
      disclosure: DISCLOSED,
    });
  });
});
