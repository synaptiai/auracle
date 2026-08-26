// CLI for the knowledge-base loader (Phase 2, decisions D4-A + D5-A). Run via:
//
//   npm run load-docs -- <dir-of-markdown>
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
import { dbUrl } from '../db/config.js';
import { OpenRouterProvider } from '../models/openrouter.js';
import { DEFAULT_EMBED_MODEL, loadKbDirectory } from './loader.js';

/** OpenRouter list prices, USD per million tokens (DEC-25). */
const USD_PER_MTOK: Readonly<Record<string, number>> = {
  'openai/text-embedding-3-small': 0.02,
  'openai/text-embedding-3-large': 0.13,
};

async function main(): Promise<void> {
  loadDotEnv();
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: npm run load-docs -- <dir-of-markdown>');
    process.exitCode = 1;
    return;
  }
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }

  const embedModelVer = process.env['EMBED_MODEL_VER'] ?? DEFAULT_EMBED_MODEL;
  const priceOverride = process.env['EMBEDDINGS_USD_PER_MTOK'];
  const usdPerMTok = priceOverride !== undefined ? Number(priceOverride) : USD_PER_MTOK[embedModelVer];
  if (
    usdPerMTok === undefined ||
    Number.isNaN(usdPerMTok) ||
    !(usdPerMTok >= 0)
  ) {
    console.error(
      `no embedding price for ${embedModelVer}: set EMBEDDINGS_USD_PER_MTOK so DEC-25 accounting stays truthful.`,
    );
    process.exitCode = 1;
    return;
  }

  const provider = new OpenRouterProvider({
    apiKey,
    ...(process.env['OPENROUTER_BASE_URL']
      ? { baseUrl: process.env['OPENROUTER_BASE_URL'] }
      : {}),
    embeddingsUsdPerMTok: usdPerMTok,
  });

  const pool = new Pool({ connectionString: dbUrl(), max: 1 });
  try {
    console.log(`indexing ${dir} with ${embedModelVer}...`);
    const report = await loadKbDirectory(pool, provider, dir, embedModelVer);
    for (const failure of report.failures) {
      console.error(failure);
    }
    console.log(
      `load-docs report: indexed=${report.indexed} skipped=${report.skipped} ` +
        `failed=${report.failed} cost_cents=${report.costCents}`,
    );
    if (report.failed > 0) {
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
