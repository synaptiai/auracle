// What `pnpm run reviewers` accepts and prints (DEC-45).
//
// Pure, so it needs no database: the parsing, the listing and the outcome
// sentences are what a maintainer meets, and all three were untestable while
// they lived inside `main`. Nothing here runs `main()` — the command's exit
// codes and its output split were checked by running it, and the roster suite
// covers the queries behind it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  parseArgs, refusalFor, renderAdded, renderDeactivated, renderList, showsEveryCharacter, USAGE,
} from './cli.js';
import type { ReviewerRow } from './roster.js';

function reviewer(over: Partial<ReviewerRow> = {}): ReviewerRow {
  return {
    identity: 'anna@example.test',
    active: true,
    addedAt: new Date('2026-09-18T09:00:00.000Z'),
    deactivatedAt: null,
    products: [],
    ...over,
  };
}

describe('the reviewer roster command (DEC-45)', () => {
  it('lists with no arguments, and with the flag that names it', () => {
    expect(parseArgs([])).toEqual({ action: 'list' });
    expect(parseArgs(['--list'])).toEqual({ action: 'list' });
  });

  // `pnpm run reviewers -- --add x` forwards the separator itself, so the
  // command line the command reads begins with `--`. Found by running it.
  it('drops the separator pnpm forwards, wherever it sits', () => {
    expect(parseArgs(['--', '--add', 'anna@example.test'])).toEqual({
      action: 'add',
      identity: 'anna@example.test',
      products: null,
    });
    expect(parseArgs(['--', '--list'])).toEqual({ action: 'list' });
    expect(parseArgs(['--deactivate', '--', 'anna@example.test'])).toEqual({
      action: 'deactivate',
      identity: 'anna@example.test',
    });
  });

  it('answers a request for its usage, on either spelling', () => {
    expect(parseArgs(['--help'])).toEqual({ action: 'help' });
    expect(parseArgs(['-h'])).toEqual({ action: 'help' });
    expect(parseArgs(['--', '--help'])).toEqual({ action: 'help' });
  });

  it('reads one identity for one action', () => {
    expect(parseArgs(['--add', 'anna@example.test'])).toEqual({
      action: 'add',
      identity: 'anna@example.test',
      products: null,
    });
    expect(parseArgs(['--deactivate', 'anna@example.test'])).toEqual({
      action: 'deactivate',
      identity: 'anna@example.test',
    });
  });

  it('refuses two actions in one run', () => {
    // The exit code would be ambiguous: a refused name beside an accepted
    // one cannot be both, and a script reads the code.
    expect(parseArgs(['--add', 'a@example.test', '--deactivate', 'b@example.test']))
      .toEqual({ error: 'one action per run: --list, --add or --deactivate, not two' });
    expect(parseArgs(['--list', '--add', 'a@example.test']))
      .toEqual({ error: 'one action per run: --list, --add or --deactivate, not two' });
  });

  it('refuses an action with no identity, including one that is a flag', () => {
    expect(parseArgs(['--add'])).toEqual({ error: '--add needs an identity' });
    expect(parseArgs(['--deactivate'])).toEqual({
      error: '--deactivate needs an identity',
    });
    // A flag where the identity belongs reads as two actions, which is what
    // it is, and the message says so.
    expect(parseArgs(['--add', '--deactivate'])).toEqual({
      error: 'one action per run: --list, --add or --deactivate, not two',
    });
  });

  it('refuses an argument it does not know', () => {
    // A typo must fail rather than list: a maintainer who meant `--deactivate`
    // and wrote `--deactive` would otherwise be told the roster changed.
    expect(parseArgs(['--ls'])).toEqual({ error: "unknown argument '--ls'" });
    expect(parseArgs(['--list', 'extra'])).toEqual({ error: "unknown argument 'extra'" });
    expect(parseArgs(['anna@example.test'])).toEqual({
      error: "unknown argument 'anna@example.test'",
    });
  });

  it('prints one line per reviewer, and says an empty roster serves nobody', () => {
    const listed = renderList([
      reviewer(),
      reviewer({
        identity: 'bo@example.test',
        active: false,
        deactivatedAt: new Date('2026-09-18T10:00:00.000Z'),
      }),
    ]);
    expect(listed.split('\n')).toEqual([
      'anna@example.test\tactive\tadded 2026-09-18\tproducts: none',
      'bo@example.test\tdeactivated\tadded 2026-09-18\tproducts: none',
    ]);
    expect(renderList([])).toContain('serves nobody');
  });

  // Four outcomes, four sentences. A reactivation changed the roster, and the
  // first version told the maintainer it was already listed, which is the one
  // sentence that means nothing changed. A products change is the third way a
  // row can move, and it is not a reactivation: the reviewer was working.
  // A command that named products says what the row now covers, whatever
  // else it did: a reactivation and a products change is two moves, and a
  // sentence naming one leaves the operator guessing about the other.
  it('names the products an add wrote, beside what else it did', () => {
    expect(renderAdded({ outcome: 'added' }, 'anna@example.test', ['aurora']))
      .toBe('added anna@example.test, covering aurora');
    expect(renderAdded({ outcome: 'reactivated' }, 'anna@example.test', ['aurora', 'ledger']))
      .toBe('reactivated anna@example.test, covering aurora, ledger');
    expect(renderAdded({ outcome: 'products_set' }, 'anna@example.test', ['ledger']))
      .toBe('set the products anna@example.test covers to ledger');
    // Nothing was written, so nothing is claimed about the row.
    expect(renderAdded({ outcome: 'already_listed' }, 'anna@example.test', null))
      .toBe('anna@example.test is already on the roster');
  });

  it('says which of the four an add did', () => {
    expect(renderAdded({ outcome: 'added' }, 'anna@example.test'))
      .toBe('added anna@example.test');
    expect(renderAdded({ outcome: 'reactivated' }, 'anna@example.test'))
      .toBe('reactivated anna@example.test');
    expect(renderAdded({ outcome: 'products_set' }, 'anna@example.test'))
      .toBe('set the products anna@example.test covers');
    expect(renderAdded({ outcome: 'already_listed' }, 'anna@example.test'))
      .toBe('anna@example.test is already on the roster');
  });

  // DEC-47: `--products` names what a reviewer covers, and the queue puts
  // their products first. Absent means the flag was not written, which is not
  // the same as an empty list: an operator adding an identity must not clear
  // a focus they did not mention.
  it('reads the products a reviewer covers, when the flag names them', () => {
    expect(parseArgs(['--add', 'anna@example.test']))
      .toEqual({ action: 'add', identity: 'anna@example.test', products: null });
    expect(parseArgs(['--add', 'anna@example.test', '--products', 'aurora, ledger']))
      .toEqual({
        action: 'add',
        identity: 'anna@example.test',
        products: ['aurora', 'ledger'],
      });
    // The flag may come first: a command line is not a fixed word order.
    expect(parseArgs(['--products', 'aurora', '--add', 'anna@example.test']))
      .toEqual({ action: 'add', identity: 'anna@example.test', products: ['aurora'] });
  });

  // The identity is found by position, not by value: a reviewer whose
  // identity reads like a product id is still a reviewer, and the old
  // value-based lookup answered that this --add needed an identity.
  it('reads an identity that reads like a product id', () => {
    expect(parseArgs(['--add', 'aurora', '--products', 'aurora']))
      .toEqual({ action: 'add', identity: 'aurora', products: ['aurora'] });
    expect(parseArgs(['--products', 'aurora', '--add', 'aurora']))
      .toEqual({ action: 'add', identity: 'aurora', products: ['aurora'] });
  });

  // DEC-47: a product the catalogue does not hold is refused before the row
  // is written, and the sentence names the file that was read — which is the
  // file `PRODUCTS_FILE` names, not always the shipped one.
  it('refuses a product the catalogue does not hold, naming the file', () => {
    const shipped = fileURLToPath(new URL('../../products.json', import.meta.url));
    expect(refusalFor(['aurora', 'ledger'], shipped)).toBeNull();
    expect(refusalFor([], shipped)).toBeNull();
    expect(refusalFor(['aurora', 'nobody-serves-this'], shipped)).toBe(
      `refused: 'nobody-serves-this' is not a product this deployment serves (${shipped})`,
    );

    // The path is the caller's, so an operator running with PRODUCTS_FILE
    // hears the file they edited rather than the shipped one. A catalogue
    // that cannot be read is a fault rather than a refusal: this names the
    // second file, which holds a different product.
    const elsewhere = join(mkdtempSync(join(tmpdir(), 'auracle-products-')), 'products.json');
    writeFileSync(elsewhere, JSON.stringify({
      products: [{ id: 'other', label: 'Other' }],
      channels: { other: 'other' },
    }));
    expect(refusalFor(['aurora'], elsewhere)).toBe(
      `refused: 'aurora' is not a product this deployment serves (${elsewhere})`,
    );
    expect(refusalFor(['other'], elsewhere)).toBeNull();
    expect(() => refusalFor(['aurora'], `${elsewhere}.missing`)).toThrow(/could not be read/);
  });

  it('refuses a products list that is not one', () => {
    expect(parseArgs(['--add', 'anna@example.test', '--products']))
      .toEqual({ error: '--products needs a comma-separated list of products' });
    expect(parseArgs(['--add', 'anna@example.test', '--products', 'aurora,,ledger']))
      .toEqual({ error: "'aurora,,ledger' has an empty item" });
    expect(parseArgs(['--add', 'anna@example.test', '--products', 'aurora,aurora']))
      .toEqual({ error: "'aurora,aurora' names aurora twice" });
    expect(parseArgs(['--add', 'anna@example.test', '--products', '--list']))
      .toEqual({ error: '--products needs a comma-separated list of products' });
    // The flag belongs to --add: a deactivation covers nobody.
    // The flag belongs to --add, and the refusal says so rather than calling
    // it unknown while the usage beside it lists the flag.
    expect(parseArgs(['--deactivate', 'anna@example.test', '--products', 'aurora']))
      .toEqual({ error: '--products belongs to --add, not to --deactivate' });
  });

  it('prints the products a reviewer covers, and says none when none', () => {
    const listed = renderList([
      {
        identity: 'anna@example.test',
        active: true,
        addedAt: new Date('2026-09-18T10:00:00.000Z'),
        deactivatedAt: null,
        products: ['aurora', 'ledger'],
      },
      {
        identity: 'bo@example.test',
        active: true,
        addedAt: new Date('2026-09-18T10:00:00.000Z'),
        deactivatedAt: null,
        products: [],
      },
    ]);
    expect(listed.split('\n')).toEqual([
      'anna@example.test\tactive\tadded 2026-09-18\tproducts: aurora, ledger',
      'bo@example.test\tactive\tadded 2026-09-18\tproducts: none',
    ]);
  });

  it('says whether a deactivation changed anything', () => {
    expect(renderDeactivated({ outcome: 'deactivated' }, 'anna@example.test'))
      .toBe('deactivated anna@example.test');
    expect(renderDeactivated({ outcome: 'not_active' }, 'anna@example.test'))
      .toBe('anna@example.test is not an active reviewer');
  });

  // A word past the identity is refused, as it is past `--list`. Dropping it
  // runs a different command than the one typed: `--add anna --active` would
  // add her and say nothing about a flag the command does not know.
  // A word that opens with `--` is a flag this command does not know. The
  // positional lookup alone would take one for an identity, and an identity
  // of that shape names no reviewer.
  it('refuses a flag where an identity belongs', () => {
    expect(parseArgs(['--add', '--active']))
      .toEqual({ error: "unknown argument '--active'" });
    expect(parseArgs(['--deactivate', '--products', 'aurora']))
      .toEqual({ error: '--products belongs to --add, not to --deactivate' });
  });

  // The refusal's own subject is a value that draws nothing: a zero-width
  // space prints as nothing at all, and a non-breaking space prints as an
  // ordinary one. The sentence shows each such character as its code point,
  // so the operator can see what was refused.
  it('shows the characters that draw nothing', () => {
    expect(showsEveryCharacter('anna@example.test')).toBe('anna@example.test');
    expect(showsEveryCharacter('anna\u200b@example.test')).toBe('anna<U+200B>@example.test');
    expect(showsEveryCharacter('anna\u00a0reviewer')).toBe('anna<U+00A0>reviewer');
    // Every other character is kept verbatim, including the punctuation and
    // symbols a name may hold.
    expect(showsEveryCharacter("o'brien+test&co")).toBe("o'brien+test&co");
  });

  it('refuses a word past the identity it was given', () => {
    expect(parseArgs(['--add', 'anna@example.test', 'extra']))
      .toEqual({ error: "unknown argument 'extra'" });
    expect(parseArgs(['--deactivate', 'anna@example.test', '--active']))
      .toEqual({ error: "unknown argument '--active'" });
  });

  // Every action the parser accepts is one the usage text names, and the
  // usage text opens the way a usage line does. The earlier version of this
  // case claimed the usage lived "in one place", which nothing can decide.
  it('spells every action it accepts in its usage', () => {
    expect(USAGE.startsWith('usage: pnpm run reviewers')).toBe(true);
    for (const action of ['--list', '--add', '--deactivate', '--help']) {
      const parsed = parseArgs([action]);
      // `--add` alone answers that it needs an identity, which is a flag the
      // parser knows. What none of them may answer is that it is unknown.
      expect('error' in parsed ? parsed.error : '', action).not.toContain('unknown argument');
      expect(USAGE, action).toContain(action);
    }
  });
});
