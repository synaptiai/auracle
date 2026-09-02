// Consumer daemon entrypoint (section 4.3, DEC-27, DEC-28). Run via
// `pnpm run consumer` (executes the built dist/coordinator/consumer-main.js).
//
// Configuration:
// - CONSUMER_PARTITIONS   comma-separated partitions this process owns
//                         (required). Each partition must be owned by exactly
//                         one consumer across the whole deployment (DEC-27).
// - CONSUMER_INTERVAL_MS  milliseconds between scans (default: 5000)
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
//                         helpdesk; known values: helpdesk, imap-smtp). The
//                         policy engine reads the capabilities of the selected
//                         adapter, so gating follows the real manifest
//                         (DEC-03, DEC-06: smtp accepts no idempotency key,
//                         therefore every write gates).
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

import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { SmtpEgressAdapter, imapSmtpConfigFromEnv } from '../adapters/imap-smtp.js';
import type { EgressAdapter } from '../adapters/types.js';
import { pinFaults, resolveThresholds } from '../calibration/resolve.js';
import { actionProfileFromEnv } from '../config/action-profile.js';
import { loadDotEnv, dataGuaranteeOption, DEFAULT_CHAT_MODEL_VER } from '../config/env.js';
import { requireDbUrl } from '../db/config.js';
import { OpenRouterProvider } from '../models/openrouter.js';
import { claimPartition, startConsumer } from './consumer.js';
import type { CoordinatorDeps } from './coordinator.js';

const EGRESS_ADAPTERS: Readonly<Record<string, () => EgressAdapter>> = {
  helpdesk: () => new HelpdeskAdapter(),
  'imap-smtp': () => new SmtpEgressAdapter(imapSmtpConfigFromEnv()),
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

function parsePartitions(raw: string | undefined): number[] {
  const parts = (raw ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (parts.length === 0) {
    throw new Error('CONSUMER_PARTITIONS is required, e.g. CONSUMER_PARTITIONS=0,1');
  }
  const parsed = parts.map((value) => Number(value));
  for (const value of parsed) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`CONSUMER_PARTITIONS entries must be non-negative integers, got '${raw}'`);
    }
  }
  return parsed;
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got '${raw ?? ''}'`);
  }
  return value;
}

async function main(): Promise<void> {
  loadDotEnv();
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set.');
  const partitions = parsePartitions(process.env['CONSUMER_PARTITIONS']);
  const intervalMs = intFromEnv('CONSUMER_INTERVAL_MS', 5000);
  const ticketDeadlineMs = intFromEnv('TICKET_DEADLINE_MS', 60_000);
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
    provider: new OpenRouterProvider({ apiKey, ...dataGuaranteeOption() }),
    taxonomy,
    capabilities: egress.capabilities,
    egress,
    pins: {
      promptVer: process.env['PROMPT_VER'] ?? 'consumer-prompt-v1',
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
    partitionCount: Number(process.env['PARTITION_COUNT'] ?? '8'),
  };

  console.log(
    JSON.stringify({
      event: 'rebalanced',
      at: new Date().toISOString(),
      partitions,
      fencesBumped: bumped,
    }),
  );

  const handle = startConsumer(deps, {
    partitions,
    intervalMs,
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
      void handle.stop().then(async () => {
        await pool.end();
        resolve();
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
