/**
 * `pnpm run seed-history` — a backdated synthetic history (issue #23).
 *
 * The bands report judges one UTC day against the thirty measured days before
 * it, and the latency report windows on the same column. Neither can be
 * exercised without a history, and this repository has no traffic and by
 * DEC-18 may never have real traffic. So the history is written, through the
 * real ledger path, from a seed.
 *
 * This is offline tooling. It writes, so unlike `bands` and `latency` it is
 * NOT safe against a live database — the connection is read-write and the
 * command says so before it starts. It is never reachable from a daemon, and
 * `src/ledger/clock-reachability.test.ts` holds that rule.
 */
import { Pool } from 'pg';

import { closeLedger, requireDbUrl } from '../db/config.js';
import { startedAsCommand } from '../corpus/output-path.js';
import { MIXED_PROVIDER } from '../bands/evaluate.js';
import { planHistory } from './plan.js';
import { writeHistory } from './write.js';
import { runEntry } from '../cli/entry.js';
import { errorMessage } from '../errors.js';
import { terminalText } from '../cli/terminal-text.js';
import { lastCompleteDay } from '../time/day.js';

/** 'Arca', the same constant `scripts/generate-fixtures.mjs` uses. */
export const DEFAULT_SEED = 0x41726361;
/** 30 for a full baseline window, plus 15 evaluable days after it. */
export const DEFAULT_DAYS = 45;
/** Four, the shape `CONSUMER_PARTITIONS=0,1,2,3` gives. */
export const DEFAULT_PARTITIONS = 4;

export interface SeedArgs {
  seed: number;
  days: number;
  endDay: string;
  partitions: number;
  provider: string;
}

/**
 * Reads the arguments, refusing anything that would make the history
 * irreproducible or nonsensical.
 *
 * A refusal names the argument and the value, because a seeder that quietly
 * substituted a default would write 45 days nobody asked for.
 */
export function parseArgs(argv: readonly string[], today: string): SeedArgs {
  const read = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const int = (flag: string, fallback: number): number => {
    const raw = read(flag);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${flag} needs a positive whole number, got '${raw}'`);
    }
    return value;
  };
  const endDay = read('--end-day') ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDay)) {
    throw new Error(`--end-day needs a UTC calendar day, got '${endDay}'. For example 2026-06-30`);
  }
  // The closed set src/models/provider.ts declares. A run records what
  // answered it, and only two things can: a stub or a model. Accepting a free
  // name let a seeder write days the report reads as unrecorded, and one
  // named for the report's own disagreement sentinel would have written
  // unanimous days it then refused while reporting a change.
  const provider = read('--provider') ?? 'stub';
  if (provider !== 'stub' && provider !== 'model') {
    throw new Error(
      `--provider must be 'stub' or 'model', got '${provider}'`
        + (provider === MIXED_PROVIDER
          ? `; the control-band report uses '${MIXED_PROVIDER}' for a day whose`
            + ' runs recorded different providers'
          : ''),
    );
  }
  return {
    seed: int('--seed', DEFAULT_SEED),
    days: int('--days', DEFAULT_DAYS),
    endDay,
    partitions: int('--partitions', DEFAULT_PARTITIONS),
    provider,
  };
}

async function main(): Promise<void> {
  let args: SeedArgs;
  try {
    args = parseArgs(process.argv.slice(2), lastCompleteDay(new Date()));
  } catch (error) {
    console.error(`seed-history: ${terminalText(errorMessage(error))}`);
    process.exitCode = 1;
    return;
  }

  // `requireDbUrl`, never `dbUrl`. This command writes, and a compose
  // fallback would let an operator who lost DATABASE_URL seed 45 days into
  // whichever database happened to answer.
  const pool = new Pool({ connectionString: requireDbUrl('the traffic seeder'), max: 4 });
  pool.on('error', (error: Error) => {
    console.error(`seed-history: database connection lost: ${terminalText(error.message)}`);
    process.exitCode = 1;
  });
  try {
    const plan = planHistory(args);
    console.log(
      `seed-history: writing ${plan.length} runs over ${args.days} days`
        + ` ending ${args.endDay}, seed ${args.seed}, provider ${args.provider}`,
    );
    const report = await writeHistory(pool, plan);
    console.log(`seed-history: ${report.accepted} accepted, ${report.refused} refused`);
    if (report.refused > 0) {
      // A refusal means the ledger rejected a row this planner produced, so
      // the history is not the history the seed describes. Loud, not a note.
      console.error('seed-history: the ledger refused rows; the history is incomplete');
      process.exitCode = 1;
    }
  } finally {
    await closeLedger(pool, 'seed-history');
  }
}

if (startedAsCommand(import.meta.url, process.argv[1])) {
  void runEntry(main);
}
