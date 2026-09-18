// What `pnpm run reviewers` accepts and prints (DEC-45).
//
// Pure, so it needs no database: the parsing, the listing and the outcome
// sentences are what a maintainer meets, and all three were untestable while
// they lived inside `main`. Nothing here runs `main()` — the command's exit
// codes and its output split were checked by running it, and the roster suite
// covers the queries behind it.
import { describe, expect, it } from 'vitest';

import { parseArgs, renderAdded, renderDeactivated, renderList, USAGE } from './cli.js';
import type { ReviewerRow } from './roster.js';

function reviewer(over: Partial<ReviewerRow> = {}): ReviewerRow {
  return {
    identity: 'anna@example.test',
    active: true,
    addedAt: new Date('2026-09-18T09:00:00.000Z'),
    deactivatedAt: null,
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
      'anna@example.test\tactive\tadded 2026-09-18',
      'bo@example.test\tdeactivated\tadded 2026-09-18',
    ]);
    expect(renderList([])).toContain('serves nobody');
  });

  // Three outcomes, three sentences. A reactivation changed the roster, and
  // the first version told the maintainer it was already listed, which is the
  // one sentence that means nothing changed.
  it('says which of the three an add did', () => {
    expect(renderAdded({ outcome: 'added' }, 'anna@example.test'))
      .toBe('added anna@example.test');
    expect(renderAdded({ outcome: 'reactivated' }, 'anna@example.test'))
      .toBe('reactivated anna@example.test');
    expect(renderAdded({ outcome: 'already_listed' }, 'anna@example.test'))
      .toBe('anna@example.test is already on the roster');
  });

  it('says whether a deactivation changed anything', () => {
    expect(renderDeactivated({ outcome: 'deactivated' }, 'anna@example.test'))
      .toBe('deactivated anna@example.test');
    expect(renderDeactivated({ outcome: 'not_active' }, 'anna@example.test'))
      .toBe('anna@example.test is not an active reviewer');
  });

  // A word past the identity is refused, as it is past `--list`. Dropping it
  // runs a different command than the one typed: `--add anna --active` used
  // to add her and say nothing about a flag nobody had written.
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
