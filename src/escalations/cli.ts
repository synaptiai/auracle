/**
 * Escalations CLI (decision D9-A). One command answers "what needs a person
 * right now and why" without tailing daemon logs:
 *
 *   pnpm run escalations                     JSON array on stdout
 *   pnpm run escalations -- --pretty         compact table
 *   pnpm run escalations -- --since 24h      arrived in the last day
 *   pnpm run escalations -- --state awaiting_approval
 *
 * Filters: --since takes an ISO timestamp or a duration like `45m`, `24h`,
 * `7d`; --state takes `escalated`, `awaiting_approval` or `delivery_unknown`.
 * Note the ledger deletes intake rows once a ticket is picked up, so
 * --since only narrows output for tickets still queued there; escalations
 * with no known arrival always stay visible. The tool only runs SELECTs, so
 * it is safe against a live database without approval. Run via the built
 * dist/escalations/cli.js.
 */
import { Pool } from 'pg';

import { requireDbUrl } from '../db/config.js';
import { listEscalations, parseSince, type EscalationItem } from './query.js';
import { runEntry } from '../cli/entry.js';

function optionValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

const USAGE = `usage: pnpm run escalations [-- --pretty] [-- --since <iso|45m|24h|7d>] [-- --state <escalated|awaiting_approval|delivery_unknown>]

--since filters on ticket arrival (intake.enqueued_at). Intake rows are
deleted once a ticket is picked up, so items with unknown arrival always
stay listed rather than being hidden by the window.`;

const KNOWN_STATES = new Set(['escalated', 'awaiting_approval', 'delivery_unknown']);

export function renderTable(items: readonly EscalationItem[]): string {
  // PIN is the prompt version. It is here because this is the queue a person
  // works from, and a seeded run reaches it exactly like a produced one:
  // `pnpm run seed-history` writes runs in `escalated` and
  // `awaiting_approval`, which are the two states this report selects. It
  // pins `seed`, and without this column nothing on the screen said so.
  const header = [
    'RUN', 'TICKET', 'STATE', 'PIN', 'INTENT', 'REASON', 'OUTBOX', 'COSTµ$', 'STEPS', 'DRAFT',
  ];
  const rows = items.map((item) => [
    item.runId.slice(0, 8),
    item.ticketId,
    item.state,
    item.promptVer,
    item.intentId ?? '-',
    // The escalation reason, or the gate rule when the run has not escalated.
    //
    // This report selects `escalated` and `awaiting_approval`, and only the
    // first of those has an escalation reason — so every waiting run printed
    // `-` in the column that says why a person is needed, while the gate row
    // held the answer. The operator console had the same defect and reads
    // through this same module, which is the point of sharing it.
    item.reason ?? item.gateReason ?? '-',
    item.outboxStatus ?? '-',
    String(item.costMicros),
    String(item.stepsUsed),
    // What approving it acts on. A gated write with no customer draft parks
    // its payload in the ledger and is still approvable (DEC-34), and a `-`
    // here read as a run nothing could be done with.
    item.draftExternalId ?? (item.payloadRecorded ? 'payload' : '-'),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i]!.length)),
  );
  const line = (cells: readonly string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i]!)).join('  ');
  return [line(header), ...rows.map(line)].join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log(USAGE);
    return;
  }
  let since: string | undefined;
  const sinceArg = optionValue(argv, '--since');
  if (sinceArg !== undefined) {
    // Validate up front so a bad value exits before any connection opens.
    parseSince(sinceArg);
    since = sinceArg;
  }
  // Same up-front validation as --since: a typo like `escaleted` must fail
  // loudly instead of filtering out everything and printing a false
  // all-clear.
  const state = optionValue(argv, '--state');
  if (state !== undefined && !KNOWN_STATES.has(state)) {
    console.error(`unknown --state value: ${state}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const pool = new Pool({ connectionString: requireDbUrl('the escalations CLI'), max: 1 });
  try {
    const items = await listEscalations(pool, {
      ...(since === undefined ? {} : { since }),
      ...(state === undefined ? {} : { state }),
    });
    if (hasFlag(argv, '--pretty')) {
      console.log(
        items.length === 0 ? 'Nothing needs a person.' : renderTable(items),
      );
    } else {
      console.log(JSON.stringify(items, null, 2));
    }
  } finally {
    await pool.end();
  }
}

void runEntry(main);
