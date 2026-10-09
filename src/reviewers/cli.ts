/**
 * Reviewer roster CLI (DEC-45). One command changes the list the console
 * checks every request against:
 *
 *   pnpm run reviewers                        list every reviewer
 *   pnpm run reviewers -- --list              the same, named
 *   pnpm run reviewers -- --add <identity> [--products a,b]
 *                                             add a reviewer, and say which
 *                                             products they cover (DEC-47)
 *   pnpm run reviewers -- --deactivate <id>   deactivate a reviewer
 *   pnpm run reviewers -- --help              the usage above
 *
 * The console never writes this list; a maintainer does, here. Both commands
 * that name an identity apply the ledger's own name rules (DEC-42), so a
 * value the ledger would record as `unattributed` is refused rather than
 * listed, or looked for, under a name no approval could ever keep.
 *
 * Adding an identity that is already listed, and deactivating one that is
 * not active, change nothing and exit 0: the command states what it found,
 * so a repeated run is safe. A refused name exits 1, because the operator
 * asked for a reviewer who is not there.
 *
 * Run via the built dist/reviewers/cli.js.
 */
import { Pool } from 'pg';

import { startedAsCommand } from '../corpus/output-path.js';
import { loadDotEnv } from '../config/env.js';
import { DEFAULT_PRODUCTS_FILE, loadProducts } from '../config/products.js';
import { requireDbUrl } from '../db/config.js';
import { runEntry } from '../cli/entry.js';
import {
  addReviewer,
  deactivateReviewer,
  listReviewers,
  type AddReviewerOutcome,
  type DeactivateOutcome,
  type ReviewerRow,
} from './roster.js';
import { guardLedgerPool, logLedgerPoolError } from '../db/client-errors.js';

/**
 * An `--add` that changed something, or stated something. The refusal is not
 * here: the caller prints it and exits 1, so this renderer never sees it.
 */
export type RosterChange = Exclude<AddReviewerOutcome, { readonly outcome: 'refused_name' }>;

export const USAGE = `usage: pnpm run reviewers [-- --list | --add <identity> | --deactivate <identity> | --help]

--list prints every reviewer: identity, state, and the day it was added. It is
the default. An identity is matched exactly, so the value a proxy sends is the
value to list here.

--add records a reviewer, or reactivates a deactivated one. --products names
the products that reviewer covers, comma separated; the queue puts their cases
first, and it grants nothing. Adding an identity without the flag leaves what
the row already covers. --deactivate stops an identity reviewing without
removing it from the ledger.`;

export type RosterArgs =
  | { readonly action: 'list' }
  | { readonly action: 'help' }
  | {
    readonly action: 'add';
    readonly identity: string;
    /**
     * DEC-47: the products this reviewer covers, or null when the flag was
     * not written. Null is not an empty list: it leaves what the row holds.
     */
    readonly products: readonly string[] | null;
  }
  | { readonly action: 'deactivate'; readonly identity: string }
  | { readonly error: string };

/** The three flags that choose an action, longest spelling of each. */
const ACTIONS = ['--list', '--add', '--deactivate'] as const;

/** DEC-47: the flag that names what a reviewer covers. */
const PRODUCTS = '--products';

/**
 * Reads the command line. One action per run, because two of them in one
 * invocation would make the exit code ambiguous: a refused name beside a
 * good one cannot be both.
 *
 * A `--` is dropped rather than refused. `pnpm run reviewers -- --add x`
 * forwards the separator itself, so the command line this reads begins with
 * one. The other CLIs here match their flags by name and never see it; this
 * one refuses what it does not know, so it has to.
 */
export function parseArgs(argv: readonly string[]): RosterArgs {
  const words = argv.filter((arg) => arg !== '--');
  if (words.includes('--help') || words.includes('-h')) return { action: 'help' };

  // DEC-47: `--products` takes the word after it. That word is checked
  // before anything else about the command line, because a missing value is
  // a fault in the flag itself: `--add anna --products --list` has two
  // problems, and the one to name is the value the flag never got.
  const productsAt = words.indexOf(PRODUCTS);
  if (productsAt !== -1 && words.indexOf(PRODUCTS, productsAt + 1) !== -1) {
    return { error: `${PRODUCTS} takes one list` };
  }
  if (productsAt !== -1) {
    const value = words[productsAt + 1];
    if (value === undefined || value.startsWith('--')) {
      return { error: `${PRODUCTS} needs a comma-separated list of products` };
    }
  }

  const chosen = words.filter((arg) => (ACTIONS as readonly string[]).includes(arg));
  if (chosen.length === 0) {
    if (words.length > 0) return { error: `unknown argument '${words[0]}'` };
    return { action: 'list' };
  }
  if (chosen.length > 1) {
    return { error: 'one action per run: --list, --add or --deactivate, not two' };
  }
  const flag = chosen[0]!;
  if (flag === '--list') {
    const extra = words.find((word) => word !== '--list');
    return extra === undefined ? { action: 'list' } : { error: `unknown argument '${extra}'` };
  }
  // The flag's value belongs to the flag, so both are off the table before
  // the identity is looked for: the identity is the first word that is
  // neither an action, nor this flag, nor its value.
  let products: readonly string[] | null = null;
  // The words that are not the identity: the flags, and the flag's own value.
  // Dropped by POSITION rather than by value, so an identity that happens to
  // read like a product id is still an identity.
  let valueAt = -1;
  if (productsAt !== -1) {
    // The flag declares what a reviewer covers, and only an add writes a row.
    // Refused by name rather than as an unknown argument: the usage below
    // the sentence lists the flag, so "unknown" would read as a lie.
    if (flag !== '--add') {
      return { error: `${PRODUCTS} belongs to --add, not to ${flag}` };
    }
    const parsed = parseProductList(words[productsAt + 1]!);
    if (typeof parsed === 'string') return { error: parsed };
    products = parsed;
    valueAt = productsAt + 1;
  }
  const isFlag = (text: string): boolean => (ACTIONS as readonly string[]).includes(text)
    || text === PRODUCTS;
  const isWord = (text: string, position: number): boolean =>
    position !== valueAt && !isFlag(text);
  const identityAt = words.findIndex(isWord);
  if (identityAt === -1) {
    return { error: `${flag} needs an identity` };
  }
  // A word that opens with `--` is a flag this command does not know, not an
  // identity. Refusing it here keeps the guard of a value-based lookup:
  // `--add --active` is refused as an unknown argument, and an identity of
  // that shape names no reviewer.
  if (words[identityAt]!.startsWith('--')) {
    return { error: `unknown argument '${words[identityAt]}'` };
  }
  const identity = words[identityAt]!;
  // A word past the identity is a command line this does not understand.
  // Dropping it would run a different command than the one typed, which is
  // how `--add anna --active` would add her and say nothing about the flag
  // nobody wrote.
  const past = words.filter((text, position) => isWord(text, position) && position !== identityAt);
  if (past.length > 0) return { error: `unknown argument '${past[0]}'` };
  return flag === '--add'
    ? { action: 'add', identity, products }
    : { action: 'deactivate', identity };
}

/**
 * DEC-47: the products named on `--products`, or the sentence that refuses
 * them.
 *
 * Commas and whitespace only, because the flag's value is one shell word.
 * An empty item and a repeated one are both refused by name: the first is
 * what a trailing comma produces, the second is a paste that ran twice, and
 * neither has a reader that could make sense of it.
 */
function parseProductList(value: string): readonly string[] | string {
  const products = value.split(',').map((product) => product.trim());
  if (products.some((product) => product === '')) {
    return `'${value}' has an empty item`;
  }
  const seen = new Set<string>();
  for (const product of products) {
    if (seen.has(product)) return `'${value}' names ${product} twice`;
    seen.add(product);
  }
  return products;
}

/**
 * The refusal both commands print for a name the ledger would not record.
 *
 * One sentence, because the two commands answer the same input the same way.
 * A `--deactivate` sentence of its own could report that nobody was
 * deactivated. That hides that the reviewer the operator meant stays active.
 */
function refusedName(identity: string): string {
  return `refused: '${showsEveryCharacter(identity)}' is not a name the ledger would record`
    + ' (DEC-42: it is empty, too long, or carries a character that draws nothing)';
}

/**
 * The name with every character that draws nothing spelled out.
 *
 * The refusal's own subject is a value the operator cannot see: a zero-width
 * space or a non-breaking space draws as nothing or as an ordinary space, so
 * the sentence listed three causes and named none of them. Each such
 * character is written as its code point instead, and the rest is kept
 * verbatim.
 */
export function showsEveryCharacter(identity: string): string {
  let shown = '';
  for (const character of identity) {
    const draws = /^[\p{L}\p{N}\p{P}\p{S}\s]$/u.test(character) && !/^[\u200B-\u200F\u2028-\u202F\uFEFF\u00A0]$/.test(character);
    shown += draws ? character : `<U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}>`;
  }
  return shown;
}

/**
 * What an `--add` did, in words. The four outcomes differ, and a caller
 * reads this to know which happened: a reactivation changes the roster, a
 * products change moves which cases come first, and a second `--add` of the
 * same active identity changes nothing.
 */
export function renderAdded(
  added: RosterChange,
  identity: string,
  /**
   * DEC-47: the products the command named, when it wrote the row. Null when
   * the flag was not written, or when nothing changed — a list nobody wrote
   * would be a claim about a row this command did not touch.
   */
  covers: readonly string[] | null = null,
): string {
  const andCovers = covers === null ? '' : `, covering ${covers.join(', ')}`;
  switch (added.outcome) {
    case 'added':
      return `added ${identity}${andCovers}`;
    case 'reactivated':
      return `reactivated ${identity}${andCovers}`;
    case 'products_set':
      return `set the products ${identity} covers${covers === null ? '' : ` to ${covers.join(', ')}`}`;
    case 'already_listed':
      return `${identity} is already on the roster`;
  }
}

/** What a `--deactivate` did, in words. */
export function renderDeactivated(
  deactivated: Exclude<DeactivateOutcome, { readonly outcome: 'refused_name' }>,
  identity: string,
): string {
  return deactivated.outcome === 'deactivated'
    ? `deactivated ${identity}`
    : `${identity} is not an active reviewer`;
}

/** One line per reviewer, in the order the query returned them. */
export function renderList(rows: readonly ReviewerRow[]): string {
  if (rows.length === 0) {
    return 'no reviewers. The console serves nobody until one is added.';
  }
  return rows
    .map((row) => {
      const state = row.active ? 'active' : 'deactivated';
      const added = row.addedAt.toISOString().slice(0, 10);
      // DEC-47: what this reviewer covers, and `none` rather than a blank:
      // an undeclared focus is a fact, and a column that drew nothing would
      // read as a value nobody could see rather than a choice nobody made.
      const covers = row.products.length === 0 ? 'none' : row.products.join(', ');
      return `${row.identity}\t${state}\tadded ${added}\tproducts: ${covers}`;
    })
    .join('\n');
}

/**
 * The first product the catalogue does not hold, or null when it holds them
 * all. Read from the file a process reads, so the check follows the map an
 * operator edits rather than a list written here.
 */
export function refusalFor(
  products: readonly string[],
  // The path is read here as well as in the loader, because the refusal has
  // to name the file an operator should open. `PRODUCTS_FILE` may name one
  // that is not `products.json`.
  file: string = process.env['PRODUCTS_FILE'] ?? DEFAULT_PRODUCTS_FILE,
): string | null {
  const held = new Set(loadProducts(file).products.map((product) => product.id));
  const unknown = products.find((product) => !held.has(product));
  return unknown === undefined
    ? null
    : `refused: '${unknown}' is not a product this deployment serves (${file})`;
}

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if ('error' in args) {
    console.error(`${args.error}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  // Usage before the pool, so the one request that needs no ledger is the one
  // request that works without one. The escalations CLI validates its flags
  // the same way and for the same reason.
  if (args.action === 'help') {
    console.log(USAGE);
    return;
  }

  const pool = guardLedgerPool(new Pool({ connectionString: requireDbUrl('the reviewer roster') }), logLedgerPoolError('the reviewer roster'));
  try {
    // `help` is answered above, and the compiler holds that: it is not
    // comparable here, so an arm for it would be dead code.
    switch (args.action) {
      case 'list':
        console.log(renderList(await listReviewers(pool)));
        return;
      case 'add': {
        // DEC-47: the products are checked against the catalogue the
        // processes read, before the row is written. A product no channel
        // serves is a focus that can never match a run, so it is a typo to
        // hear about now rather than an empty column of cases later.
        if (args.products !== null) {
          const refusal = refusalFor(args.products);
          if (refusal !== null) {
            console.error(refusal);
            process.exitCode = 1;
            return;
          }
        }
        const added = await addReviewer(
          pool,
          args.identity,
          // Absent means the flag was not written, which leaves what the row
          // already covers rather than clearing it.
          args.products ?? undefined,
        );
        if (added.outcome === 'refused_name') {
          console.error(refusedName(args.identity));
          process.exitCode = 1;
          return;
        }
        // A write that named products says so, whatever the outcome: a
        // reactivation and a products change in one command is two moves,
        // and a sentence that named one would leave the operator guessing
        // what the row now covers.
        console.log(renderAdded(
          added,
          args.identity,
          added.outcome === 'already_listed' ? null : args.products,
        ));
        return;
      }
      case 'deactivate': {
        const deactivated = await deactivateReviewer(pool, args.identity);
        if (deactivated.outcome === 'refused_name') {
          console.error(refusedName(args.identity));
          process.exitCode = 1;
          return;
        }
        console.log(renderDeactivated(deactivated, args.identity));
        return;
      }
    }
  } finally {
    await pool.end();
  }
}

// The command runs only when this module is the entry point. `cli.test.ts`
// imports the parsing the listing and the rendering above, and an import must
// not open a pool. The rule itself is `startedAsCommand`'s, which every other
// CLI in this tree calls: it resolves both sides through symlinks, so a
// linked path still runs the command rather than exiting 0 having done
// nothing.
if (startedAsCommand(import.meta.url, process.argv[1])) {
  void runEntry(main);
}
