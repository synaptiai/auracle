// Consumer daemon entrypoint (section 4.3, DEC-27, DEC-28). Run via
// `npm run consumer` (executes the built dist/coordinator/consumer-main.js).
//
// Configuration:
// - CONSUMER_PARTITIONS   comma-separated partitions this process owns
//                         (required). Each partition must be owned by exactly
//                         one consumer across the whole deployment (DEC-27).
// - CONSUMER_INTERVAL_MS  milliseconds between scans (default: 5000)
// - TICKET_DEADLINE_MS    per-ticket clock budget in milliseconds (DEC-25,
//                         default: 60000)
// - OPENROUTER_API_KEY    provider credential
// - MODEL_VER             chat model pin (default: stealth/ox-alpha)
// - EMBED_MODEL_VER       embedding model pin for retrieval (stealth chat
//                         models do not embed; default: openai/text-embedding-3-small)
// - PROMPT_VER            prompt version pin (default: consumer-prompt-v1)
// - ACTION_CLASS          action class each run executes (default: route_ticket)
// - ACTION_DELIVERY       delivery rule: at_most_once | at_least_once
// - ACTION_IS_CUSTOMER_VISIBLE  'true' gates every action (DEC-12, default false)
// - DISCLOSURE_TEXT       DEC-14 disclosure; required when customer-visible,
//                         startup fails fast without it
// - DATABASE_URL          ledger connection (see src/db/config.ts)
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
import { actionProfileFromEnv } from '../config/action-profile.js';
import { loadDotEnv } from '../config/env.js';
import { dbUrl } from '../db/config.js';
import { OpenRouterProvider } from '../models/openrouter.js';
import type { AdapterCapabilities } from '../policy/policy.js';
import { claimPartition, startConsumer } from './consumer.js';
import type { CoordinatorDeps } from './coordinator.js';

const CAPABILITIES: AdapterCapabilities = {
  supportsIdempotencyKey: true,
  supportsReadBack: true,
  supportsDraftState: true,
  supportsStructuredFields: true,
  supportsThreading: true,
};

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
  const pool = new Pool({ connectionString: dbUrl(), max: 1 });
  let bumped = 0;
  for (const partition of partitions) {
    bumped += await claimPartition(pool, partition);
  }

  const deps: CoordinatorDeps = {
    pool,
    provider: new OpenRouterProvider({ apiKey }),
    taxonomy,
    capabilities: CAPABILITIES,
    egress: new HelpdeskAdapter(),
    pins: {
      promptVer: process.env['PROMPT_VER'] ?? 'consumer-prompt-v1',
      // stealth/ox-alpha is the user-approved starting chat model. Override
      // with MODEL_VER.
      modelVer: process.env['MODEL_VER'] ?? 'stealth/ox-alpha',
    },
    // Embeddings are a separate pin: stealth chat models do not embed, so the
    // retrieval query embeds through its own model (EMBED_MODEL_VER).
    embedModelVer: process.env['EMBED_MODEL_VER'] ?? 'openai/text-embedding-3-small',
    // Rolling per-ticket clock: the getter re-reads at each check, so a
    // long-lived daemon does not escalate everything once a fixed deadline
    // passes (DEC-25).
    limits: {
      maxCostCents: 10_000,
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
