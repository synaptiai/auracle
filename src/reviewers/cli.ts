/**
 * Reviewer roster CLI (DEC-45). One command changes the list the console
 * checks every request against:
 *
 *   pnpm run reviewers                        list every reviewer
 *   pnpm run reviewers -- --list              the same, named
 *   pnpm run reviewers -- --add <identity>    add a reviewer
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

/**
 * An `--add` that changed something, or stated something. The refusal is not
 * here: the caller prints it and exits 1, so this renderer never sees it.
 */
export type RosterChange = Exclude<AddReviewerOutcome, { readonly outcome: 'refused_name' }>;

export const USAGE = `usage: pnpm run reviewers [-- --list | --add <identity> | --deactivate <identity> | --help]

--list prints every reviewer: identity, state, and the day it was added. It is
the default. An identity is matched exactly, so the value a proxy sends is the
value to list here.

--add records a reviewer, or reactivates a deactivated one. --deactivate stops
an identity reviewing without removing it from the ledger.`;

export type RosterArgs =
  | { readonly action: 'list' }
  | { readonly action: 'help' }
  | { readonly action: 'add'; readonly identity: string }
  | { readonly action: 'deactivate'; readonly identity: string }
  | { readonly error: string };

/** The three flags that choose an action, longest spelling of each. */
const ACTIONS = ['--list', '--add', '--deactivate'] as const;

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
  const identity = words[words.indexOf(flag) + 1];
  if (identity === undefined || identity.startsWith('--')) {
    return { error: `${flag} needs an identity` };
  }
  // A word past the identity is a command line this does not understand.
  // Dropping it would run a different command than the one typed, which is
  // how `--add anna --active` would add her and say nothing about the flag
  // nobody wrote.
  const past = words.slice(words.indexOf(flag) + 2);
  if (past.length > 0) return { error: `unknown argument '${past[0]}'` };
  return flag === '--add'
    ? { action: 'add', identity }
    : { action: 'deactivate', identity };
}

/**
 * The refusal both commands print for a name the ledger would not record.
 *
 * One sentence, because the two commands answer the same input the same way:
 * `--deactivate` refused with a sentence of its own used to report that
 * nobody was deactivated, while the reviewer stayed active.
 */
function refusedName(identity: string): string {
  return `refused: '${identity}' is not a name the ledger would record`
    + ' (DEC-42: it is empty, too long, or carries a character that draws nothing)';
}

/**
 * What an `--add` did, in words. The three outcomes differ, and a caller
 * reads this to know which happened: a reactivation changes the roster, and a
 * second `--add` of an active identity does not.
 */
export function renderAdded(added: RosterChange, identity: string): string {
  switch (added.outcome) {
    case 'added':
      return `added ${identity}`;
    case 'reactivated':
      return `reactivated ${identity}`;
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
      return `${row.identity}\t${state}\tadded ${added}`;
    })
    .join('\n');
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

  const pool = new Pool({ connectionString: requireDbUrl('the reviewer roster') });
  try {
    // `help` is answered above, and the compiler holds that: it is not
    // comparable here, so an arm for it would be dead code.
    switch (args.action) {
      case 'list':
        console.log(renderList(await listReviewers(pool)));
        return;
      case 'add': {
        const added = await addReviewer(pool, args.identity);
        if (added.outcome === 'refused_name') {
          console.error(refusedName(args.identity));
          process.exitCode = 1;
          return;
        }
        console.log(renderAdded(added, args.identity));
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
