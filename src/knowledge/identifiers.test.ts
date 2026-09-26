// The identifier check a published document passes (DEC-50).
//
// Every expected value below is read off the maintainer's ruling: the
// customer address matched case-insensitively; ticket and message ids and
// the draft handle; whole tokens; a number-only id only when it is marked,
// as "#41" or "ticket 41". The addresses are reserved test names (DEC-18).
import { describe, expect, it } from 'vitest';

import { findIdentifier } from './identifiers.js';
import type { CaseIdentifiers } from './identifiers.js';

const IDS: CaseIdentifiers = {
  addresses: ['a@b.test'],
  tickets: ['41', '<root-7@mail.example>'],
  messages: ['<msg-3@mail.example>'],
  drafts: ['1203:88'],
};

const ZWSP = String.fromCharCode(0x200b);
const FULLWIDTH_AT = String.fromCharCode(0xff20);

describe('the identifier check (DEC-50)', () => {
  it('passes a body that names none of the case', () => {
    expect(findIdentifier('A plan may be paused once a year, for up to 41 days.', IDS)).toBeNull();
  });

  it('finds the address in any case', () => {
    expect(findIdentifier('Write to A@B.TEST for help.', IDS)).toBe('address');
    expect(findIdentifier('Write to a@b.test.', IDS)).toBe('address');
  });

  it('finds the address when a format character or a full-width sign disguises it', () => {
    expect(findIdentifier(`Write to a@${ZWSP}b.test.`, IDS)).toBe('address');
    expect(findIdentifier(`Write to a${FULLWIDTH_AT}b.test.`, IDS)).toBe('address');
  });

  it('reads an address that runs on through its own punctuation as another address', () => {
    for (const text of ['x.a@b.test', 'x-a@b.test', 'x_a@b.test', 'x+a@b.test', 'a@b.test.example', 'a@b.test-x.test']) {
      expect(findIdentifier(`Write to ${text} today.`, IDS), text).toBeNull();
    }
    for (const text of ['(a@b.test)', '<a@b.test>', 'a@b.test,', 'a@b.test.', '"a@b.test"']) {
      expect(findIdentifier(`Write to ${text} today.`, IDS), text).toBe('address');
    }
  });

  it('finds the address wrapped in punctuation that does not run on into another address', () => {
    const emDash = String.fromCharCode(0x2014);
    for (const text of [
      'Email _a@b.test_ for help.', `our owner${emDash}a@b.test${emDash}today`, `a@b.test${emDash}they answer`,
      'Email ...a@b.test now.', 'Email -a@b.test now.',
    ]) {
      expect(findIdentifier(text, IDS), text).toBe('address');
    }
  });

  it('finds a marked number with no space, or a space after the sign', () => {
    for (const text of ['See # 41.', 'Ticket No.41', 'ticket no.41', 'ticket number41', 'Ticket N°41']) {
      expect(findIdentifier(text, IDS), text).toBe('ticket');
    }
    const mailbox: CaseIdentifiers = { addresses: [], tickets: [], messages: [], drafts: ['12'] };
    expect(findIdentifier('draft no.12', mailbox)).toBe('draft');
    expect(findIdentifier('The ticketidentifier 41.', IDS)).toBeNull();
  });

  it('finds an identifier written with any dash inside it', () => {
    const en = String.fromCharCode(0x2013);
    const em = String.fromCharCode(0x2014);
    const armenian = String.fromCharCode(0x058a);
    const minus = String.fromCharCode(0x2212);
    const superMinus = String.fromCharCode(0x207b);
    const hyphen = String.fromCharCode(0x2010);
    const ids: CaseIdentifiers = {
      addresses: ['jane-doe@b.test'], tickets: ['T-77', '41'], messages: ['<abc-123@mail.test>'], drafts: [],
    };
    // A hyphen or a minus sign continues an address, as the ASCII hyphen does.
    for (const text of [`x${hyphen}jane-doe@b.test`, `jane-doe@b.test${minus}x.test`]) {
      expect(findIdentifier(`Write to ${text} today.`, ids), text).toBeNull();
    }
    // An identifier the ledger holds with a dash matches the same text with a hyphen.
    for (const lookalike of [0x02d7, 0x2043, 0x2796]) {
      const drawn = String.fromCharCode(lookalike);
      expect(findIdentifier(`See T${drawn}77.`, ids), lookalike.toString(16)).toBe('ticket');
      expect(findIdentifier(`Write to jane${drawn}doe@b.test.`, ids), lookalike.toString(16)).toBe('address');
    }
    const stored: CaseIdentifiers = { addresses: [], tickets: [`T${en}88`], messages: [], drafts: [] };
    expect(findIdentifier('See T-88.', stored)).toBe('ticket');
    for (const [text, kind] of [
      [`Write to jane${en}doe@b.test.`, 'address'], [`Write to jane${armenian}doe@b.test.`, 'address'],
      [`Quoted from abc${en}123@mail.test.`, 'message'], [`See T${en}77.`, 'ticket'],
      [`See ticket${en}41.`, 'ticket'], [`See ticket${em}41.`, 'ticket'], [`See ticket ${en} 41.`, 'ticket'],
      [`See T${minus}77.`, 'ticket'], [`Write to jane${minus}doe@b.test.`, 'address'], [`See ticket${minus}41.`, 'ticket'],
      [`Quoted from abc${minus}123@mail.test.`, 'message'], [`See T${superMinus}77.`, 'ticket'],
    ] as const) {
      expect(findIdentifier(text, ids), text).toBe(kind);
    }
  });

  // The class is Unicode's own Dash property, swept whole, so no dash is
  // missed because nobody listed it.
  it('finds a ticket id written with every character Unicode marks as a dash', () => {
    const ids: CaseIdentifiers = { addresses: [], tickets: ['T-77'], messages: [], drafts: [] };
    const missed: string[] = [];
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const dash = String.fromCodePoint(code);
      if (!/\p{Dash}/u.test(dash)) continue;
      if (findIdentifier(`See T${dash}77 today.`, ids) !== 'ticket') missed.push(code.toString(16));
    }
    expect(missed).toEqual([]);
  });

  // A rule rather than a list: any short run of signs between a marker and
  // its number, and between the numbers of a list, line breaks among them.
  it('finds a marked number whatever short punctuation joins it', () => {
    for (const text of [
      'ticket (41)', 'ticket [41]', "ticket '41'", 'ticket "41"', 'ticket.41', 'ticket_41', 'tickets 40/41',
      'tickets 40-41', 'tickets 40; 41', 'ticket #(41)', 'Ticket No. (41)',
    ]) {
      expect(findIdentifier(text, IDS), text).toBe('ticket');
    }
    const mailbox: CaseIdentifiers = { addresses: [], tickets: [], messages: [], drafts: ['12'] };
    expect(findIdentifier('draft_12', mailbox)).toBe('draft');
    // A wrapped line still marks the number, and a word between is no mark.
    expect(findIdentifier('ticket' + String.fromCharCode(10) + '41 days', IDS)).toBe('ticket');
    for (const text of ['tickets 40, 38, and 41', 'tickets 40,and 41', 'tickets 40 or 41', 'ticket n.41']) {
      expect(findIdentifier(text, IDS), text).toBe('ticket');
    }
    expect(findIdentifier('drafts 11, and 12', { addresses: [], tickets: [], messages: [], drafts: ['12'] }))
      .toBe('draft');
    expect(findIdentifier('The ticket queue holds 41 items.', IDS)).toBeNull();
  });

  it('decodes a reference to a character that draws nothing, and one written in wide characters', () => {
    for (const text of [
      'a&#8203;@b.test', 'a&shy;@b.test', 'a&ZeroWidthSpace;@b.test', 'a&zwj;@b.test',
      'a' + String.fromCharCode(0xff06) + '#64;b.test', 'a&#' + String.fromCharCode(0xff16, 0xff14) + ';b.test',
      // Each needs a second round: the first decode yields a reference.
      'a&#65286;#64;b.test', 'a%26#64;b.test',
      // Every HTML name for a character that draws nothing.
      'a&NoBreak;@b.test', 'a&NegativeThinSpace;@b.test', 'a&NegativeVeryThinSpace;@b.test',
      'a&ic;@b.test', 'a&af;@b.test', 'a&it;@b.test', 'a&ApplyFunction;@b.test',
      'a&NegativeMediumSpace;@b.test', 'a&NegativeThickSpace;@b.test', 'a&InvisibleTimes;@b.test',
      'a&InvisibleComma;@b.test',
    ]) {
      expect(findIdentifier(`Write to ${text} now.`, IDS), text).toBe('address');
    }
  });

  it('reads "case" before a number as a mark, as the console names a case', () => {
    for (const text of ['Case 41', 'as in case 41 the refund', 'cases 40 and 41']) {
      expect(findIdentifier(text, IDS), text).toBe('ticket');
    }
    expect(findIdentifier('In this case 4 steps.', IDS)).toBeNull();
  });

  it('decodes an HTML character reference before it matches', () => {
    for (const text of ['a&#64;b.test', 'a&#x40;b.test', 'a&#00000064;b.test', 'a&#x0000040;b.test', 'a&commat;b.test', 'a@b&period;test', '&#35;41', 'ticket&#58; 41']) {
      expect(findIdentifier(`Write to ${text} now.`, IDS), text).not.toBeNull();
    }
    expect(findIdentifier('Tom &amp; Jerry, &unknown; &#12345; stay text.', IDS)).toBeNull();
  });

  it('reads every "#" before a number as a mark, whatever stands before it', () => {
    // Refusing a heading or "C# 41" costs one rewording. Telling them from a
    // mark opened ways past the check, so none is told apart.
    const em = String.fromCharCode(0x2014);
    const bullet = String.fromCharCode(0x2043);
    for (const text of [
      '#41 at the start of a line', 'Intro' + String.fromCharCode(10) + '#41 is closed.', '# 41 ways to pause',
      '> # 41 ways', '- # 41 ways', '1. # 41 ways', 'Requires C# 41', 'Ref#41', '-# 41 was hers', '**# 41**',
      `${em} # 41 was the ticket`, `${bullet} # 41`, '    # 41', '#: 41', 'a #: 41', 'Intro%0a# 41', '#  41', '# : 41', '#:  41', '#. 41',
    ]) {
      expect(findIdentifier(text, IDS), JSON.stringify(text)).toBe('ticket');
    }
    // A line break joins as any other sign does, so this refuses too.
    expect(findIdentifier('Step #' + String.fromCharCode(10, 10) + '41 days', IDS)).toBe('ticket');
    // A browser sends a textarea's line break as two characters, and a run of
    // white space counts as one sign, indent and all.
    const crlf = String.fromCharCode(13, 10);
    for (const text of [`ticket:${crlf}${crlf} 41`, 'ticket:  ' + String.fromCharCode(10) + '  41', `tickets 40,${crlf}   41`]) {
      expect(findIdentifier(text, IDS), JSON.stringify(text)).toBe('ticket');
    }
  });

  it('marks every run of digits after a marker, and a thousands number whole as well', () => {
    // Each run of digits, whatever joins it: a reading that joined them would
    // let the case's own ticket through.
    for (const text of [
      'See tickets 41,205.', 'tickets 41,100 and 205', 'ticket 41,100', '#41,041', 'tickets 040,041',
      'See ticket 41.2 for the reply.', 'ticket 41.0', 'ticket #41.00', 'tickets 40.41', '#2024.041',
      'Order #2024-041 shipped.', 'tickets 1, 041', 'We closed cases: 1,041 this month.', 'case 3.41 GB',
    ]) {
      expect(findIdentifier(text, IDS), text).toBe('ticket');
    }
    // And a thousands number whole, so a four-digit id written with a comma.
    const large: CaseIdentifiers = { addresses: [], tickets: ['1041'], messages: [], drafts: [] };
    for (const text of ['See ticket 1,041 for it.', 'cases: 01,041']) {
      expect(findIdentifier(text, large), text).toBe('ticket');
    }
    // A number with no marker is still prose.
    expect(findIdentifier('We closed 1,041 of them, 41.2 a day.', IDS)).toBeNull();
  });

  it('reads an ideographic full stop in an address as a stop', () => {
    for (const code of [0x3002, 0xff61, 0xfe12]) {
      const text = `Write to a@b${String.fromCharCode(code)}test now.`;
      expect(findIdentifier(text, IDS), code.toString(16)).toBe('address');
    }
    expect(findIdentifier('Write to a@b&#xFF61;test now.', IDS)).toBe('address');
  });

  it('matches a whole token only', () => {
    // "xa@b.test" is another address, and "a@b.testing.example" another domain.
    expect(findIdentifier('Write to xa@b.test.', IDS)).toBeNull();
    expect(findIdentifier('Write to a@b.testing.example.', IDS)).toBeNull();
  });

  it('finds a number-only ticket id only where it is marked', () => {
    expect(findIdentifier('See #41 for the history.', IDS)).toBe('ticket');
    expect(findIdentifier('As ticket 41 shows.', IDS)).toBe('ticket');
    expect(findIdentifier('As Ticket #41 shows.', IDS)).toBe('ticket');
    expect(findIdentifier('As ticket no. 41 shows.', IDS)).toBe('ticket');
    expect(findIdentifier('As conversation 41 shows.', IDS)).toBe('ticket');
    expect(findIdentifier('Up to 41 items ship at once.', IDS)).toBeNull();
    // Another number that starts with the id is not the id.
    expect(findIdentifier('See #410 for the history.', IDS)).toBeNull();
    expect(findIdentifier('See #041 for the history.', IDS)).toBe('ticket');
  });

  it('finds a message id with or without its angle brackets', () => {
    expect(findIdentifier('Quoted from <msg-3@mail.example>.', IDS)).toBe('message');
    expect(findIdentifier('Quoted from msg-3@mail.example.', IDS)).toBe('message');
    expect(findIdentifier('Thread root-7@mail.example.', IDS)).toBe('ticket');
  });

  it('finds a number-only draft handle only where it is marked', () => {
    const mailbox: CaseIdentifiers = { addresses: [], tickets: [], messages: [], drafts: ['12'] };
    expect(findIdentifier('Draft 12 holds it.', mailbox)).toBe('draft');
    expect(findIdentifier('Message #12 holds it.', mailbox)).toBe('draft');
    expect(findIdentifier('It takes 12 days.', mailbox)).toBeNull();
  });

  it('finds the draft handle as a whole token', () => {
    expect(findIdentifier('Draft 1203:88 holds it.', IDS)).toBe('draft');
    expect(findIdentifier('Draft 11203:88 holds it.', IDS)).toBeNull();
  });

  it('finds a marked number written the other ways a person writes one', () => {
    for (const text of [
      'ticket ID 41', 'ticket id 41', 'ticket: 41', 'ticket-41', 'tickets 40 and 41', 'tickets 40, 41',
      '?ticket=41', 'https://helpdesk.example.test/conversation/41#thread-9', 'ticket nr 41', 'ticket n° 41',
      'Ticket No: 41', 'conversations 7 & 41',
    ]) {
      expect(findIdentifier(text, IDS), text).toBe('ticket');
    }
    const mailbox: CaseIdentifiers = { addresses: [], tickets: [], messages: [], drafts: ['12'] };
    for (const text of ['draft id 12', 'https://helpdesk.example.test/conversation/7#thread-12', 'message: 12']) {
      expect(findIdentifier(text, mailbox), text).toBe('draft');
    }
    // A marker word that runs on into another word is not a marker.
    expect(findIdentifier('The ticketing 41 rule.', IDS)).toBeNull();
    expect(findIdentifier('Tickets take 41 minutes.', IDS)).toBeNull();
  });

  it('folds look-alike characters that compatibility forms do not', () => {
    const hyphen = String.fromCharCode(0x2011);
    const dash = String.fromCharCode(0x2010);
    const selector = String.fromCharCode(0xfe00);
    const joiner = String.fromCharCode(0x034f);
    const ids: CaseIdentifiers = { addresses: ['a@b.test'], tickets: ['T-77', '41'], messages: [], drafts: [] };
    expect(findIdentifier(`See T${hyphen}77.`, ids)).toBe('ticket');
    expect(findIdentifier(`See T${dash}77.`, ids)).toBe('ticket');
    expect(findIdentifier('See #' + String.fromCharCode(0x0664, 0x0661) + '.', ids)).toBe('ticket');
    expect(findIdentifier('See #' + String.fromCharCode(0x096a, 0x0967) + '.', ids)).toBe('ticket');
    expect(findIdentifier('Write to a%40b.test.', ids)).toBe('address');
    expect(findIdentifier(`Write to a@b${selector}.test.`, ids)).toBe('address');
    expect(findIdentifier(`Write to a${joiner}@b.test.`, ids)).toBe('address');
  });

  it('ignores an identifier the ledger holds empty', () => {
    expect(findIdentifier('Any text at all.', { addresses: ['', '  '], tickets: [], messages: [], drafts: [] }))
      .toBeNull();
  });

  it('names the first kind in the order address, message, draft, ticket', () => {
    expect(findIdentifier('a@b.test and #41 and 1203:88', IDS)).toBe('address');
    expect(findIdentifier('#41 and 1203:88', IDS)).toBe('draft');
    // A message id that holds the ticket id is named as the message.
    const nested: CaseIdentifiers = { addresses: [], tickets: ['T-9f3a'], messages: ['<m-1-T-9f3a@mail.example>'], drafts: [] };
    expect(findIdentifier('See m-1-T-9f3a@mail.example.', nested)).toBe('message');
  });
});
