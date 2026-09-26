// The identifiers of a case, and whether a text carries one (DEC-50).
//
// A document a reviewer writes from a case serves every later case of its
// products, so it must not carry the case it came from. DEC-50 says so, and
// the check is narrow on purpose: it looks for the identifiers the ledger
// holds for this case and nothing else. It is not a personal-data detector.
// DEC-15 keeps personal data in the runtime path, and DEC-19 states the
// compliance position with no machine check. A name, a phone number or
// another customer's address passes, and a reader owns those.
//
// What it looks for, from the maintainer's ruling:
//
//   the customer's address, in any case
//   every ticket id and message id the conversation holds
//   every draft handle a park recorded
//
// Each is matched as a whole token, so an address inside a longer address,
// or a number inside a longer number, is not a match. A ticket id that is a
// number alone matches only where it is marked as one: "#41", "ticket 41",
// "ticket no. 41", "conversation #41", "draft 12". FreeScout's ticket ids and
// a mailbox's draft ids are short numbers, and "up to 41 days" is prose.
//
// Both sides are normalised first: compatibility forms fold to their plain
// character (NFKC turns a full-width at sign into "@"), and format characters
// such as a zero-width space are removed. Without that, an address split by
// an invisible character would pass the check and still read as the address
// on a screen.
//
// A letter of another alphabet that only looks like a Latin one, such as a
// Cyrillic "а" in place of "a", is not folded. Unicode keeps no fold for it
// that would not also change real names in those alphabets. A reviewer who
// types one on purpose is past any check of this kind.

/** The identifiers the ledger holds for one case. */
export interface CaseIdentifiers {
  readonly addresses: readonly string[];
  readonly tickets: readonly string[];
  readonly messages: readonly string[];
  readonly drafts: readonly string[];
}

export type IdentifierKind = 'address' | 'ticket' | 'message' | 'draft';

/**
 * HTML character references, decoded: every numeric one that names a real
 * character, and the named ones for the signs an identifier holds and the
 * characters that draw nothing. A text copied from a mail client's source
 * view carries them, and a reader, or a model, reads them as the character.
 * An invisible character decoded here is removed with the rest below.
 */
function decodeCharacterReferences(text: string): string {
  const named: Readonly<Record<string, string>> = {
    commat: '@', period: '.', hyphen: '-', dash: '-', num: '#', colon: ':', lowbar: '_', plus: '+', amp: '&',
    nbsp: ' ', shy: String.fromCharCode(0xad), zwj: String.fromCharCode(0x200d),
    zwnj: String.fromCharCode(0x200c), lrm: String.fromCharCode(0x200e), rlm: String.fromCharCode(0x200f),
    // Every name HTML gives a character that draws nothing: the zero-width
    // space under five names, the word joiner, and the invisible operators.
    zerowidthspace: String.fromCharCode(0x200b), negativeverythinspace: String.fromCharCode(0x200b),
    negativethinspace: String.fromCharCode(0x200b), negativemediumspace: String.fromCharCode(0x200b),
    negativethickspace: String.fromCharCode(0x200b), nobreak: String.fromCharCode(0x2060),
    applyfunction: String.fromCharCode(0x2061), af: String.fromCharCode(0x2061),
    invisibletimes: String.fromCharCode(0x2062), it: String.fromCharCode(0x2062),
    invisiblecomma: String.fromCharCode(0x2063),
    ic: String.fromCharCode(0x2063),
  };
  // The longest HTML name is 31 letters.
  return text.replace(/&(?:#0*(\d{1,7})|#[xX]0*([0-9a-fA-F]{1,6})|([a-zA-Z]{2,31}));?/gu,
    (whole: string, decimal?: string, hex?: string, name?: string) => {
      if (name !== undefined) return named[name.toLowerCase()] ?? whole;
      const code = decimal !== undefined ? Number(decimal) : parseInt(hex!, 16);
      const real = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
      return real ? String.fromCodePoint(code) : whole;
    });
}

/** A percent-encoded ASCII character, decoded, as a link carries one. */
function decodePercent(text: string): string {
  return text.replace(/%([0-7][0-9a-f])/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Compatibility forms and both encodings, folded until the text stops
 * changing: a reference written in wide characters becomes a reference
 * only after NFKC, and a decoded one can hold a wide character again.
 */
function decoded(text: string): string {
  let current = text.normalize('NFKC');
  for (let round = 0; round < 4; round += 1) {
    const next = decodePercent(decodeCharacterReferences(current)).normalize('NFKC');
    if (next === current) break;
    current = next;
  }
  return current;
}

/** The value of one decimal digit of any script, as an ASCII digit. */
function asciiDigit(digit: string): string {
  // A script's digits are ten consecutive code points, zero first, so the
  // value is the distance back to the first code point that is not a digit.
  let start = digit.codePointAt(0)!;
  while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
  return String((digit.codePointAt(0)! - start) % 10);
}

/**
 * A text folded the way both sides of a comparison are folded.
 *
 * Compatibility forms fold (NFKC), and HTML character references and
 * percent-encoded characters decode, until the text stops changing. So
 * `a%40b.test` is the address pasted from a link, and `a&#64;b.test` the one
 * copied from a mail's source.
 * Characters that draw nothing are removed: format characters, variation
 * selectors and the combining grapheme joiner. Every script's digits become
 * ASCII digits, because NFKC does not fold them. Every character Unicode
 * marks as a dash becomes an ASCII hyphen, the minus signs among them, so
 * `T–77` is `T-77` and `ticket–41` is `ticket-41`. No other character's
 * compatibility form holds a hyphen, so the class is closed under NFKC. A
 * character that is only drawn like a hyphen is folded by name below.
 */
export function foldForMatch(text: string): string {
  return withDashes(text).replace(/\p{Dash}/gu, '-');
}

/**
 * The same text with its dashes as written, one code unit for one with the
 * folded text, so a position in one is the same position in the other. A
 * match is found in the folded text, and whether the character beside it
 * continues an address is read here: an em dash around an address is
 * punctuation, and a hyphen inside one is part of it. A dash outside the
 * basic plane takes two code units, so it is folded here already.
 */
function withDashes(text: string): string {
  return decoded(text)
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
    .replace(/\p{Nd}/gu, (digit) => (/[0-9]/u.test(digit) ? digit : asciiDigit(digit)))
    .toLowerCase()
    // A hyphen and the minus sign join words, so they are the ASCII hyphen in
    // both copies, and so are three characters drawn as one: the modifier
    // letter minus, the hyphen bullet and the heavy minus sign. NFKC also
    // turns a superscript or subscript minus into the minus sign. The minus
    // sign is a symbol, not a dash, so the fold below would miss it.
    .replace(/[\u2010\u2011\u2212\u02d7\u2043\u2796]/gu, '-')
    // The ideographic full stop separates the labels of a domain, as a mail
    // client that reads international names takes it, so it is a stop here.
    // NFKC turns the halfwidth and vertical forms into it.
    .replace(/\u3002/gu, '.')
    .replace(/(?=\p{Dash})[\u{10000}-\u{10ffff}]/gu, '-');
}

const WORD = /[\p{L}\p{N}]/u;

function isWord(char: string | undefined): boolean {
  return char !== undefined && WORD.test(char);
}

/**
 * Whether `needle` occurs in `hay` as a whole token: the characters beside it
 * do not run on from its own first and last characters.
 *
 * `joins` names the characters that continue a token besides letters and
 * digits. An address takes `.`, `-`, `_` and `+`, so `x.a@b.test` and
 * `a@b.test.example` are other addresses. After the address such a character
 * joins only when a letter or a digit follows it, so a full stop that ends a
 * sentence still ends the address.
 */
function hasToken(hay: string, raw: string, needle: string, joins = ''): boolean {
  const first = needle[0];
  const last = needle[needle.length - 1];
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    // The characters beside the match as written, dashes unfolded.
    const before = at === 0 ? undefined : raw[at - 1];
    const after = raw[at + needle.length];
    // Before it, a joining character runs on only when a letter or a digit
    // precedes it: "x.a@b.test" is another address, and "_a@b.test_" is
    // emphasis around this one.
    const joinsBefore = isWord(first)
      && (isWord(before) || (before !== undefined && joins.includes(before) && isWord(raw[at - 2])));
    // After it, a joining character runs on only when a letter or a digit
    // follows: "a@b.test." ends a sentence, and "a@b.test.example" is another.
    const joinsAfter = isWord(last)
      && (isWord(after) || (after !== undefined && joins.includes(after) && isWord(raw[at + needle.length + 1])));
    if (!joinsBefore && !joinsAfter) return true;
  }
  return false;
}

/**
 * The numbers the text marks as an id.
 *
 * "#41" marks one. So does a marker word, singular or plural, before the
 * number: ticket, case, conversation, message, draft or thread. "In case 41"
 * and "worst case 41 minutes" are refused as well, on purpose: a refusal
 * costs a rewording, and the case is what the console calls a ticket.
 *
 * The word may take a qualifier, as in "ticket id 41", "ticket no. 41",
 * "ticket nr 41", "ticket number 41" or "ticket n° 41". Any short run of
 * signs may join it to the number, as in "ticket: 41", "ticket (41)",
 * "ticket_41", "?ticket=41" or "/conversation/41". A list after one marker is
 * marked whole: "tickets 40 and 41", "tickets 40/41", "tickets 40, 41, and 42".
 * Leading zeros are dropped, so "#041" is 41.
 *
 * Every run of digits after a marker is marked, whatever joins it to the
 * next. A number written with a thousands comma is also marked whole, so
 * "cases: 1,041" marks 1, 41 and 1041. So "case 3.41", "#1,041" and
 * "#2024-041" are refused where the case's ticket is 41. A reading that
 * joined the digits instead would let "tickets 41,205" or "ticket 41.2"
 * through, and a refusal costs one rewording.
 */
function markedNumbers(hay: string): Set<string> {
  const marked = new Set<string>();
  // A rule, not a list of signs: up to five characters that are neither a
  // letter nor a digit may stand between a marker and its number, and up to
  // three between the numbers of a list, with "and" or "or" among them.
  // Brackets, quotes, stops, underscores and line breaks are such
  // characters, and a word is not. A line break counts, because a textarea
  // wraps between a marker and its number. A run of white space counts once,
  // so a line break a browser sends as two characters, or an indent after
  // it, takes no more of the five than a space does.
  // Nothing before a "#" is read: a heading "# 41 ways" or "C# 41" is
  // refused as well, because a rule that told those from a mark was a way
  // past it, and a refusal costs the reviewer one rewording.
  const gap = '[^\\p{L}\\p{N}]{0,5}';
  const marker = `(?:#${gap}|(?<![\\p{L}\\p{N}])(?:tickets?|cases?|conversations?|messages?|drafts?|threads?)`
    + `(?:${gap}(?:id|no\\.?|nr\\.?|n\\.|n°|number)(?!\\p{L}))?${gap})`;
  const separator = '[^\\p{L}\\p{N}]{1,3}(?:(?:and|or)[^\\p{L}\\p{N}]{1,3})?';
  const list = `(\\d+(?:${separator}\\d+)*)(?!\\d)`;
  const spaced = hay.replace(/\s+/gu, ' ');
  for (const match of spaced.matchAll(new RegExp(marker + list, 'gu'))) {
    for (const [digits] of match[1]!.matchAll(/\d+/gu)) marked.add(stripZeros(digits));
    for (const [written] of match[1]!.matchAll(/\d{1,3}(?:,\d{3})+(?!\d)/gu)) {
      marked.add(stripZeros(written.replaceAll(',', '')));
    }
  }
  return marked;
}

function stripZeros(digits: string): string {
  const stripped = digits.replace(/^0+/, '');
  return stripped === '' ? '0' : stripped;
}

/** The forms of one identifier a text may carry it in. */
function formsOf(id: string): string[] {
  const folded = foldForMatch(id).trim();
  if (folded === '') return [];
  const forms = [folded];
  // A message id is written in angle brackets, and a person quoting one often
  // drops them.
  const bare = /^<(.+)>$/u.exec(folded)?.[1];
  if (bare !== undefined && bare.trim() !== '') forms.push(bare.trim());
  return forms;
}

function carries(
  hay: string,
  raw: string,
  marked: Set<string>,
  ids: readonly string[],
  joins = '',
): boolean {
  for (const id of ids) {
    for (const form of formsOf(id)) {
      if (/^\d+$/u.test(form)) {
        if (marked.has(stripZeros(form))) return true;
      } else if (hasToken(hay, raw, form, joins)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The first kind of identifier of the case the text carries, or null.
 *
 * The kinds are tried in a fixed order, so the refusal names the same kind
 * for the same text every time. The longer identifiers come first: a message
 * id can hold a ticket id inside it, and the refusal names the message.
 */
export function findIdentifier(text: string, ids: CaseIdentifiers): IdentifierKind | null {
  const raw = withDashes(text);
  const hay = raw.replace(/\p{Dash}/gu, '-');
  const marked = markedNumbers(hay);
  if (carries(hay, raw, marked, ids.addresses, '.-_+')) return 'address';
  if (carries(hay, raw, marked, ids.messages)) return 'message';
  if (carries(hay, raw, marked, ids.drafts)) return 'draft';
  if (carries(hay, raw, marked, ids.tickets)) return 'ticket';
  return null;
}
