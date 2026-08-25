// Offline runner for the taxonomy-induction job (section 4.11, DEC-02,
// DEC-10). Run via:
//
//   npm run build && node dist/jobs/run-taxonomy-induction.js [output.json]
//
// Environment:
//   OPENROUTER_API_KEY   required (DEC-16: OpenRouter supplies the models)
//   CHAT_MODEL_VER       chat model id used to name clusters
//                        (default: openai/gpt-4o-mini)
//   EMBED_MODEL_VER      embedding model id (default: openai/text-embedding-3-small)
//   OPENROUTER_BASE_URL  optional override of the API base URL
//
// The history is the synthetic fixture corpus (DEC-18). The artifact it
// writes is a candidate list for a person to curate; nothing at runtime
// reads it.

import { writeFile } from 'node:fs/promises';

import { loadGoldSet } from '../fixtures/load.js';
import { OpenRouterProvider } from '../models/openrouter.js';
import { INTENT_CAP, induceTaxonomy } from './taxonomy-induction.js';
import type { HistoryItem } from './taxonomy-induction.js';

const PROMPT_VER = 'induce-v1';
const DEFAULT_CHAT_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_EMBED_MODEL = 'openai/text-embedding-3-small';

async function main(): Promise<void> {
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }
  const outputPath = process.argv[2] ?? 'taxonomy-candidates.json';

  // DEC-02: raw ticket history with no tags. The gold-set intent labels are
  // ignored here on purpose; only subject and body feed the job.
  const { fit, report } = loadGoldSet();
  const items: HistoryItem[] = [...fit.tickets, ...report.tickets].map(
    (ticket) => ({
      id: ticket.ticket_id,
      text: `${ticket.subject}\n${ticket.body}`,
    }),
  );

  const provider = new OpenRouterProvider({
    apiKey,
    ...(process.env['OPENROUTER_BASE_URL']
      ? { baseUrl: process.env['OPENROUTER_BASE_URL'] }
      : {}),
  });

  const chatModelVer = process.env['CHAT_MODEL_VER'] ?? DEFAULT_CHAT_MODEL;
  const embedModelVer = process.env['EMBED_MODEL_VER'] ?? DEFAULT_EMBED_MODEL;

  console.log(
    `embedding ${items.length} fixture tickets and clustering (cap ${INTENT_CAP} intents)...`,
  );
  const taxonomy = await induceTaxonomy(provider, {
    items,
    promptVer: PROMPT_VER,
    chatModelVer,
    embedModelVer,
  });

  await writeFile(outputPath, `${JSON.stringify(taxonomy, null, 2)}\n`, 'utf8');
  console.log(
    `wrote ${outputPath}: ${taxonomy.candidates.length} named candidates ` +
      `(cap ${INTENT_CAP - 1}) + other group of ${taxonomy.other.size}, ` +
      `${taxonomy.cost_cents} cents`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
