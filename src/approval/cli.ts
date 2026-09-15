/**
 * Approval CLI (DEC-11, DEC-12). The entrypoint an operator, or the
 * adopter's helpdesk webhook, calls after a person approves a parked draft:
 *
 *   pnpm run approve -- --run <run-id> [--read-back]
 *
 * `--read-back` fetches the parked draft's current body from the adapter
 * before the approval commits, so the approval-edit distance measures what
 * the person actually edited (section 4.10). Without the flag the manual
 * path stays: no body is captured and the distance stays null.
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
import { runEntry } from '../cli/entry.js';

function runIdFrom(argv: readonly string[]): string | null {
  const i = argv.indexOf('--run');
  const value = i >= 0 ? argv[i + 1] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readBackFrom(argv: readonly string[]): boolean {
  return argv.includes('--read-back');
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

  // The adapter is read only under --read-back; the manual path needs none.
  const readDraft = readBackFrom(argv)
    ? selectReadBackAdapter(process.env['APPROVE_ADAPTER'] ?? 'helpdesk', process.env)
    : undefined;

  const pool = new Pool({ connectionString: requireDbUrl('the approval CLI'), max: 1 });
  try {
    const result = await approveRun(pool, runId, readDraft === undefined ? {} : { readDraft });
    console.log(JSON.stringify(result, null, 2));
    if (result.outcome === 'draft_missing') {
      // The metric must not be fabricated: nothing committed, and only a
      // person can say what happened to the draft (section 4.10).
      console.error(
        `read-back refused: the adapter holds no draft '${result.draftExternalId}' `
          + `for run ${runId}. Reconcile the draft by hand, then approve again.`,
      );
    }
    if (result.outcome !== 'approved') {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

void runEntry(main);
