/**
 * Approval CLI (DEC-11, DEC-12). The entrypoint an operator, or the
 * adopter's helpdesk webhook, calls after a person approves a parked draft:
 *
 *   pnpm run approve -- --run <run-id> [--read-back] [--accept-copy-edit <digest>]
 *
 * `--read-back` fetches the parked draft's current body from the adapter
 * before the approval commits, so the approval-edit distance measures what
 * the person actually edited (section 4.10). Without the flag the manual
 * path stays: no body is captured and the distance stays null.
 *
 * On an adapter whose helpdesk cannot send the copy it parks, this approves
 * the reply the ledger holds (DEC-44): the text a reviewer saved on the
 * console, or the body the park recorded when nobody saved one. With
 * `--read-back` the parked copy is compared against it first, and a copy a
 * person edited after the park refuses — both texts are printed, and nothing
 * is sent. That refusal names the digest of the copy it read;
 * `--accept-copy-edit` with that digest sends the ledger's reply and leaves
 * the copy alone, which is the same choice the console offers. A copy that
 * changed since the refusal does not match the digest, so it refuses again.
 * Without `--read-back` no comparison is made.
 *
 * Configuration:
 * - APPROVE_ADAPTER  read-back adapter name (default: helpdesk; known
 *                    values: helpdesk, imap-smtp, freescout)
 * - DATABASE_URL     ledger connection (see src/db/config.ts)
 *
 * Prints the outcome as JSON on stdout and exits non-zero when the run was
 * not approved. Run via the built dist/approval/cli.js.
 */
import { Pool } from 'pg';

import { selectReadBackAdapter } from '../adapters/read-back.js';
import { loadDotEnv } from '../config/env.js';
import { requireDbUrl } from '../db/config.js';
import { approveRun } from './approve.js';
import type { ApproveOptions, ApproveOutcome } from './approve.js';
import { replyDigest } from './shown.js';
import { terminalText } from '../cli/terminal-text.js';
import { runEntry } from '../cli/entry.js';
import { startedAsCommand } from '../corpus/output-path.js';

/** The shape a digest has, so a mistyped one is refused rather than ignored. */
const DIGEST = /^[0-9a-f]{64}$/;

function runIdFrom(argv: readonly string[]): string | null {
  const i = argv.indexOf('--run');
  const value = i >= 0 ? argv[i + 1] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readBackFrom(argv: readonly string[]): boolean {
  return argv.includes('--read-back');
}

/**
 * The digest `--accept-copy-edit` names, or null when the flag is absent.
 *
 * A value of the wrong shape is a usage fault and not a quiet no-op: the
 * approval would refuse the copy again, and the operator would read that as
 * the flag not working.
 */
function acceptedCopyFrom(argv: readonly string[]): string | null {
  const i = argv.indexOf('--accept-copy-edit');
  if (i < 0) return null;
  const value = argv[i + 1];
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw new TypeError(
      '--accept-copy-edit takes the 64-character digest the refusal printed, '
        + 'so the text a person decided against is the text this command read',
    );
  }
  return value;
}

/**
 * What one invocation asks the approval to do, resolved before any connection.
 *
 * Pure, and exported, because this is the part of the command that decides
 * what gets sent (DEC-44): the adapter is built either way — it opens no
 * connection until it is asked to read — and the declaration it carries
 * decides whether this approves the reply the ledger holds.
 */
export function approvalOptionsFor(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): ApproveOptions {
  const adapter = selectReadBackAdapter(env['APPROVE_ADAPTER'] ?? 'helpdesk', env);
  const accepted = acceptedCopyFrom(argv);
  return {
    ...(adapter.capabilities.supportsLedgerReply ? { ledgerReply: true } : {}),
    ...(readBackFrom(argv) ? { readDraft: adapter } : {}),
    ...(accepted === null ? {} : { copyAcknowledged: accepted }),
  };
}

/**
 * What this command prints on stderr for one outcome, or null when the
 * outcome needs no sentence.
 *
 * Its own function so the refusal that shows two texts can be read in a test:
 * it is the whole of DEC-44's requirement on this path, and a command that
 * refused without printing them would satisfy nothing.
 *
 * Every value from the ledger or the helpdesk is printed through
 * `terminalText`. A reply can contain an escape sequence or a bidi override —
 * a draft is steered by a customer's message — and printed raw it can reorder
 * the two blocks this refusal exists to keep apart, so the operator reads the
 * copy as the reply.
 */
export function refusalSays(result: ApproveOutcome, runId: string): string | null {
  if (result.outcome === 'draft_missing') {
    // The metric must not be fabricated: nothing committed, and only a
    // person can say what happened to the draft (section 4.10). Two ways out,
    // and neither is "approve again the same way": the copy is absent, so
    // nothing this command can read will change that.
    return `read-back refused: the adapter holds no draft '${terminalText(result.draftExternalId)}' `
      + `for run ${runId}, so nothing was sent. Restore the copy in the helpdesk, then approve `
      + 'with --read-back. Approving without it hands the run to the relay, which escalates a '
      + 'copy it cannot find rather than sending one.';
  }
  if (result.outcome === 'copy_changed') {
    // DEC-44: a person edited the copy in the helpdesk after the park, and
    // this command refuses to discard that edit in silence. Both texts are
    // printed, with the digest that names the copy they were read from.
    return 'refused: the copy in the helpdesk was edited after this reply was parked, so nothing '
      + 'was sent. The two texts are below. Choose one:\n'
      + `\n--- the reply the ledger holds ---\n${terminalText(result.ledgerText)}\n`
      + `\n--- the copy the helpdesk holds ---\n${terminalText(result.copyText)}\n`
      + `\nThe copy is ${replyDigest(result.copyText)}. To send the reply the ledger holds and `
      + 'leave the copy alone, approve again with --read-back --accept-copy-edit <that digest>. '
      + 'To send the copy, save it as the reply on the console first: this command sends what '
      + 'the ledger holds.';
  }
  if (result.outcome === 'no_disclosure') {
    return `refused: the reply the ledger holds for run ${runId} carries no disclosure, so it may `
      + 'not be sent (DEC-14). This is a park recorded before the disclosure was kept beside it; '
      + 'a run parked now always has one.';
  }
  return null;
}

async function main(): Promise<void> {
  loadDotEnv();
  const argv = process.argv.slice(2);
  const runId = runIdFrom(argv);
  if (runId === null) {
    console.error('usage: pnpm run approve -- --run <run-id> [--read-back]');
    process.exitCode = 1;
    return;
  }

  const options = approvalOptionsFor(argv, process.env);
  const pool = new Pool({ connectionString: requireDbUrl('the approval CLI'), max: 1 });
  try {
    const result = await approveRun(pool, runId, options);
    console.log(JSON.stringify(result, null, 2));
    const says = refusalSays(result, runId);
    if (says !== null) console.error(says);
    if (result.outcome !== 'approved') {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

// Guarded, as the reviewers' CLI is: a module that starts a process on import
// cannot be tested, and the two functions above are the command's decision.
if (startedAsCommand(import.meta.url, process.argv[1])) {
  void runEntry(main);
}
