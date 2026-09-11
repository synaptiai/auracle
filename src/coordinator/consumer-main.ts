// Consumer daemon entrypoint (section 4.3, DEC-27, DEC-28). Run via
// `pnpm run consumer` (executes the built dist/coordinator/consumer-main.js).
//
// Configuration:
// - CONSUMER_PARTITIONS   comma-separated partitions this process owns
//                         (required). Each partition must be owned by exactly
//                         one consumer across the whole deployment (DEC-27).
// - CONSUMER_INTERVAL_MS  ceiling on the wait between scans, in
//                         milliseconds (default: 5000). Intake signals an
//                         arrival and the loop wakes on it, so this bounds
//                         the wait when a signal is lost rather than setting
//                         it (issue #25).
// - TICKET_DEADLINE_MS    per-ticket clock budget in milliseconds (DEC-25,
//                         default: 60000)
// - OPENROUTER_API_KEY    provider credential
// - MODEL_VER             chat model pin (default: z-ai/glm-5.3-flash)
// - EMBED_MODEL_VER       embedding model pin for retrieval (the chat model
//                         does not embed; default: openai/text-embedding-3-small)
// - PROMPT_VER            prompt version pin (default: consumer-prompt-v1)
// - ACTION_CLASS          action class each run executes (default: route_ticket)
// - ACTION_DELIVERY       delivery rule: at_most_once | at_least_once
// - ACTION_IS_CUSTOMER_VISIBLE  'true' gates every action (DEC-12, default false)
// - DISCLOSURE_TEXT       DEC-14 disclosure; required when customer-visible,
//                         startup fails fast without it
// - EGRESS_ADAPTER        egress adapter that parks gated replies (default:
//                         helpdesk; known values: helpdesk, imap-smtp,
//                         freescout). The policy engine reads the
//                         capabilities of the selected adapter, so gating
//                         follows the real manifest (DEC-03, DEC-06: smtp
//                         accepts no idempotency key, therefore every write
//                         gates; freescout accepts neither an idempotency key
//                         nor a delivery read-back, so the same holds).
// - FREESCOUT_BASE_URL, FREESCOUT_API_KEY, FREESCOUT_USER_ID
//                         required when EGRESS_ADAPTER is freescout. No value
//                         has a default; see src/adapters/freescout.ts
// - DATABASE_URL          ledger connection (see src/db/config.ts)
//
// Each gate takes its own artifact. The agreement number comes from the
// highest artifact under <repo>/calibration/ and the two coverage numbers
// from the highest under <repo>/groundedness/. Either may be absent, and then
// that gate keeps the documented seed of section 4.5 or section 4.7.
//
// Startup logs a line per gate, so one fitted gate beside one seeded gate
// reads correctly: `gate_thresholds_fitted` or `gate_thresholds_seeded` for
// agreement, and `coverage_thresholds_fitted` or `coverage_thresholds_seeded`
// for the pair. Read both lines before you trust a gate number.
//
// All of the above may live in a ./.env file: every entrypoint loads it at
// startup when present. An explicit shell env always wins over .env.
//
// Startup performs the deployment-time rebalance step (claimPartition): each
// claimed partition has its per-ticket fences bumped, so an old owner still
// mid-run fails its next write with stale_epoch (DEC-28).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

import { FreeScoutEgressAdapter, freeScoutConfigFromEnv } from '../adapters/freescout.js';
import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { SmtpEgressAdapter, imapSmtpConfigFromEnv } from '../adapters/imap-smtp.js';
import type { EgressAdapter } from '../adapters/types.js';
import { pinFaults, resolveThresholds } from '../calibration/resolve.js';
import { actionProfileFromEnv } from '../config/action-profile.js';
import {
  loadDotEnv,
  positiveIntEnv,
  DEFAULT_CHAT_MODEL_VER,
} from '../config/env.js';
import { closeLedger, requireDbUrl } from '../db/config.js';
import { openRouterFromEnv } from '../models/from-env.js';
import { pgArrivalSignal } from './arrival-signal.js';
import { claimPartition, startConsumer } from './consumer.js';
import type { CoordinatorDeps } from './coordinator.js';
import { runEntry } from '../cli/entry.js';
import { errorMessage } from '../errors.js';

const EGRESS_ADAPTERS: Readonly<Record<string, () => EgressAdapter>> = {
  helpdesk: () => new HelpdeskAdapter(),
  'imap-smtp': () => new SmtpEgressAdapter(imapSmtpConfigFromEnv()),
  // Declares no idempotency key and no read-back, so the policy engine sends
  // every write of this adapter to the approval path (DEC-06, DEC-30).
  freescout: () => new FreeScoutEgressAdapter(freeScoutConfigFromEnv()),
};

function selectEgressAdapter(name: string): EgressAdapter {
  const create = EGRESS_ADAPTERS[name];
  if (create === undefined) {
    throw new Error(
      `unknown EGRESS_ADAPTER '${name}' (known: ${Object.keys(EGRESS_ADAPTERS).join(', ')})`,
    );
  }
  return create();
}

/** Exported for its cases, like `requirePromptVer` below. */
export function parsePartitions(raw: string | undefined): number[] {
  const parts = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (parts.length === 0) {
    throw new Error('CONSUMER_PARTITIONS is required, e.g. CONSUMER_PARTITIONS=0,1');
  }
  // Digits matched before they are parsed, for the reason `positiveIntEnv`
  // does it: `Number` is far wider than the set of things anyone means to
  // write here. `Number('0x10')` is 16, `Number('1e1')` is 10 and
  // `Number('8.0')` is 8, so `CONSUMER_PARTITIONS=0x10` claimed partition
  // sixteen without a word. DEC-27 gives each partition one owner, and two
  // hosts spelling the same number differently is how one gets two.
  for (const value of parts) {
    if (!/^\d+$/.test(value)) {
      throw new Error(
        `CONSUMER_PARTITIONS entries must be non-negative integers, got '${value}'`,
      );
    }
  }
  const parsed = parts.map((value) => Number.parseInt(value, 10));
  for (const value of parsed) {
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        `CONSUMER_PARTITIONS entries must be non-negative integers, got '${value}'`,
      );
    }
  }
  return parsed;
}

/**
 * Refuses a partition this deployment can never receive work on.
 *
 * The queue partitions on `hash(conversation_id) % PARTITION_COUNT`
 * (DEC-36), so a partition at or above the count takes no ticket ever. A
 * consumer claiming one starts cleanly, reports health and processes
 * nothing — the silent kind of wrong this issue exists to remove. It is
 * checked here rather than in `parsePartitions`, because only the caller
 * holds both values.
 */
export function refuseUnreachablePartitions(
  partitions: number[],
  partitionCount: number,
): void {
  const unreachable = partitions.filter((partition) => partition >= partitionCount);
  if (unreachable.length === 0) return;
  throw new Error(
    `CONSUMER_PARTITIONS names ${unreachable.join(', ')}, which PARTITION_COUNT=`
      + `${partitionCount} never routes to. Valid partitions are 0 to ${partitionCount - 1} `
      + `(DEC-36 partitions on hash(conversation_id) % PARTITION_COUNT).`,
  );
}

/**
 * The prompt pin, refusing the one value the ledger reserves.
 *
 * `abandonMessage` files a run with both pins set to 'intake', and the latency
 * report reads that pair as a run that never entered service. A deployment
 * setting PROMPT_VER=intake would label every real run the same way: the
 * service distribution empties and the count an operator reads as a failing
 * partition spikes on a healthy one. Section 4.5's rule applies here too —
 * enforce it with an assertion, not a comment.
 */
export function requirePromptVer(): string {
  const configured = process.env['PROMPT_VER'];
  if (configured === undefined || configured.length === 0) return 'consumer-prompt-v1';
  if (configured === 'intake') {
    throw new Error(
      "PROMPT_VER cannot be 'intake'. The ledger reserves that value for a run "
        + 'filed without executing, and the latency report reads it as one. Pick '
        + 'another name for the prompt pin.',
    );
  }
  return configured;
}

async function main(): Promise<void> {
  loadDotEnv();
  // First, as it was before this issue moved the preflight into
  // `openRouterFromEnv`. Building the provider is what refuses a missing
  // OPENROUTER_API_KEY, and it belongs ahead of everything: nothing here
  // acquires a handle, but when two things are misconfigured the operator
  // should read the same first error they always did.
  const provider = openRouterFromEnv();
  const partitions = parsePartitions(process.env['CONSUMER_PARTITIONS']);
  // One read, used by both the ownership check and the hash below. Read
  // twice, the two could disagree.
  const partitionCount = positiveIntEnv('PARTITION_COUNT', 8);
  refuseUnreachablePartitions(partitions, partitionCount);
  const intervalMs = positiveIntEnv('CONSUMER_INTERVAL_MS', 5000);
  const ticketDeadlineMs = positiveIntEnv('TICKET_DEADLINE_MS', 60_000);
  const profile = actionProfileFromEnv();
  const egress = selectEgressAdapter(process.env['EGRESS_ADAPTER'] ?? 'helpdesk');

  const modelVer = process.env['MODEL_VER'] ?? DEFAULT_CHAT_MODEL_VER;

  // Resolved once, here, and passed down. The policy engine stays a pure
  // synchronous function, so nothing reads a file inside a gate decision.
  const { thresholds, fittedPins } = await resolveThresholds();

  // Each fitted gate must have been fitted under the pin this process runs.
  // The rule lives beside the resolver so it has a test; this call site only
  // decides what to do about it, which is to refuse rather than start.
  const faults = pinFaults(fittedPins, modelVer);
  if (faults.length > 0) throw new Error(faults.join(' '));

  // fixtures/taxonomy.json is curated by a person (section 4.11 step 4).
  const taxonomyUrl = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../fixtures/taxonomy.json',
  );
  const taxonomy = JSON.parse(readFileSync(taxonomyUrl, 'utf8')) as {
    intents: CoordinatorDeps['taxonomy']['intents'];
  };

  // Deployment-time rebalance: bump every fence in the claimed partitions so
  // the previous owner's writes are refused (DEC-27 cost, DEC-28 safety).
  const pool = new Pool({ connectionString: requireDbUrl('the consumer'), max: 1 });
  let bumped = 0;
  for (const partition of partitions) {
    bumped += await claimPartition(pool, partition);
  }

  const deps: CoordinatorDeps = {
    pool,
    provider,
    taxonomy,
    capabilities: egress.capabilities,
    egress,
    pins: {
      promptVer: requirePromptVer(),
      // The default lives in one place, beside the guarantee it carries.
      // Override with MODEL_VER. Read above, because the coverage pair a
      // fitted artifact installs must have been fitted under this same pin.
      modelVer,
    },
    // Embeddings are a separate pin: the chat model does not embed, so the
    // retrieval query embeds through its own model (EMBED_MODEL_VER).
    embedModelVer: process.env['EMBED_MODEL_VER'] ?? 'openai/text-embedding-3-small',
    // Rolling per-ticket clock: the getter re-reads at each check, so a
    // long-lived daemon does not escalate everything once a fixed deadline
    // passes (DEC-25).
    thresholds,
    limits: {
      // 100 USD in micro-dollars. The ceiling was 10 000 cents before the
      // ledger moved to micro-dollars; the amount is unchanged.
      maxCostMicros: 100_000_000,
      maxSteps: 50,
      get deadlineAt(): Date {
        return new Date(Date.now() + ticketDeadlineMs);
      },
    },
    // Read once at the top, beside the check that every claimed partition
    // is one this count can route to.
    partitionCount,
  };

  console.log(
    JSON.stringify({
      event: 'rebalanced',
      at: new Date().toISOString(),
      partitions,
      fencesBumped: bumped,
    }),
  );

  // Issue #25: intake signals an arrival and the loop wakes on it, instead
  // of sleeping the full interval through a message that landed just after a
  // scan. Its own connection, never the pool above: that pool is `max: 1`,
  // and a LISTEN client is held for the process lifetime, so taking it from
  // there would leave the consumer with no client for its actual work.
  //
  // `intervalMs` stays as the ceiling. A dropped notification costs the
  // latency this daemon had before the signal existed, and nothing more.
  const handle = startConsumer(deps, {
    partitions,
    intervalMs,
    signal: pgArrivalSignal(requireDbUrl('the consumer')),
    action: {
      actionClass: profile.actionClass,
      actionPayload: { queue: 'triaged' },
      delivery: profile.delivery,
      isCustomerVisible: profile.isCustomerVisible,
      disclosure: profile.disclosure,
    },
  });

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = (): void => {
      if (stopping) return;
      stopping = true;
      void handle
        .stop()
        .catch((error: unknown) => {
          // The chain must always settle. Without this, a rejection leaves
          // the shutdown promise pending forever, the SIGTERM listener is
          // already consumed, and the process dies on an unhandled rejection
          // instead of reporting why it could not stop.
          console.error(
            JSON.stringify({
              event: 'shutdown_failed',
              at: new Date().toISOString(),
              error: errorMessage(error),
            }),
          );
          process.exitCode = 1;
        })
        .finally(async () => {
          // In `finally`, not `then`: a rejecting stop() would otherwise skip
          // the pool and leave it holding the event loop while the exit code
          // said the process had failed cleanly.
          //
          // `closeLedger`, like the other three jobs. It swallowed the
          // rejection outright before, which is the defect this issue fixed
          // in bands, latency and seed-history: a pool that would not close
          // reported nothing and exited 0. It never rejects, so the `finally`
          // contract above still holds.
          await closeLedger(pool, 'consumer');
          resolve();
        });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

void runEntry(main);
