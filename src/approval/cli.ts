/**
 * Approval CLI (DEC-11, DEC-12). The entrypoint an operator, or the
 * adopter's helpdesk webhook, calls after a person approves a parked draft:
 *
 *   npm run approve -- --run <run-id>
 *
 * Prints the outcome as JSON on stdout and exits non-zero when the run was
 * not approved. Run via the built dist/approval/cli.js.
 */
import { Pool } from 'pg';

import { approveRun } from './approve.js';
import { dbUrl } from '../db/config.js';

function runIdFrom(argv: readonly string[]): string | null {
  const i = argv.indexOf('--run');
  const value = i >= 0 ? argv[i + 1] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function main(): Promise<void> {
  const runId = runIdFrom(process.argv.slice(2));
  if (runId === null) {
    console.error('usage: npm run approve -- --run <run-id>');
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: dbUrl(), max: 1 });
  try {
    const result = await approveRun(pool, runId);
    console.log(JSON.stringify(result, null, 2));
    if (result.outcome !== 'approved') {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
