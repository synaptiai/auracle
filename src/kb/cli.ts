// CLI for the knowledge-base loader (Phase 2, decisions D4-A + D5-A). Run via:
//
//   pnpm run load-docs -- <dir-of-markdown>
//
// Environment:
//   OPENROUTER_API_KEY       required (DEC-16: OpenRouter supplies the models)
//   EMBED_MODEL_VER          embedding model id
//                            (default: openai/text-embedding-3-small)
//   EMBEDDINGS_USD_PER_MTOK  price override in USD per million tokens. The
//                            built-in table covers the known models; an
//                            unknown model needs this explicitly, or embed()
//                            refuses to report cost and DEC-25 accounting
//                            would go dark.
//   OPENROUTER_BASE_URL      optional override of the API base URL
//
// Exit code is non-zero when any file failed validation.

import { Pool } from 'pg';

import { loadDotEnv } from '../config/env.js';
import { productCatalogueFromEnv } from '../config/products.js';
import { requireDbUrl } from '../db/config.js';
import { embeddingPriceFromEnv, openRouterFromEnv } from '../models/from-env.js';
import { DEFAULT_EMBED_MODEL, loadKbDirectory } from './loader.js';
import { runEntry } from '../cli/entry.js';
import { guardLedgerPool, logLedgerPoolError } from '../db/client-errors.js';

/** OpenRouter list prices, USD per million tokens (DEC-25). */
const USD_PER_MTOK: Readonly<Record<string, number>> = {
  'openai/text-embedding-3-small': 0.02,
  'openai/text-embedding-3-large': 0.13,
};

async function main(): Promise<void> {
  loadDotEnv();
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: pnpm run load-docs -- <dir-of-markdown>');
    process.exitCode = 1;
    return;
  }

  const embedModelVer = process.env['EMBED_MODEL_VER'] ?? DEFAULT_EMBED_MODEL;
  // One reading of the variable, the provider's: blank is unset, and a value
  // that is not a finite number of zero or more is refused.
  const usdPerMTok = embeddingPriceFromEnv().embeddingsUsdPerMTok ?? USD_PER_MTOK[embedModelVer];
  if (usdPerMTok === undefined) {
    console.error(
      `no embedding price for ${embedModelVer}: set EMBEDDINGS_USD_PER_MTOK so DEC-25 accounting stays truthful.`,
    );
    process.exitCode = 1;
    return;
  }

  // The price is the one thing the environment cannot settle on its own:
  // it comes from EMBEDDINGS_USD_PER_MTOK or the table above, and DEC-25
  // accounting needs whichever answered.
  const provider = openRouterFromEnv({ embeddingsUsdPerMTok: usdPerMTok });

  const pool = guardLedgerPool(new Pool({ connectionString: requireDbUrl('the knowledge-base CLI'), max: 1 }), logLedgerPoolError('the knowledge-base CLI'));
  try {
    console.log(`indexing ${dir} with ${embedModelVer}...`);
    const report = await loadKbDirectory(pool, provider, dir, embedModelVer, productCatalogueFromEnv());
    for (const failure of report.failures) {
      console.error(failure);
    }
    console.log(
      `load-docs report: indexed=${report.indexed} skipped=${report.skipped} ` +
        `failed=${report.failed} cost_micros=${report.costMicros}`,
    );
    if (report.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

void runEntry(main);
