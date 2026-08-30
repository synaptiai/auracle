// Offline runner for the taxonomy-induction job (section 4.11, DEC-02,
// DEC-10). Run via:
//
//   pnpm run induce [-- output.json]
//
// Environment:
//   OPENROUTER_API_KEY   required (DEC-16: OpenRouter supplies the models)
//   CHAT_MODEL_VER       chat model id used to name clusters
//                        (default: openai/gpt-4o-mini)
//   EMBED_MODEL_VER      embedding model id (default: openai/text-embedding-3-small)
//   OPENROUTER_BASE_URL  optional override of the API base URL
//
// The history is the synthetic fixture corpus (DEC-18) by default. Set
// CORPUS_PATH to a file written by `pnpm run export-corpus` to run the same
// job over real mailbox history instead; that file is gitignored and never
// committed (DEC-18). In corpus mode the output default also lands under
// the gitignored corpus/ directory: the artifact is real-derived data. The
// artifact it writes is a candidate list for a person to curate; nothing
// at runtime reads it.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { loadDotEnv, dataGuaranteeOption } from '../config/env.js';
import { CORPUS_SOURCE, corpusHistoryItems, loadCorpusFile } from '../corpus/corpus.js';
import { resolveCorpusOutput, startedAsCommand } from '../corpus/output-path.js';
import { goldCaseText, loadGoldSet } from '../fixtures/load.js';
import { OpenRouterProvider } from '../models/openrouter.js';
import { INTENT_CAP, induceTaxonomy } from './taxonomy-induction.js';
import type { HistoryItem } from './taxonomy-induction.js';

const PROMPT_VER = 'induce-v1';
const DEFAULT_CHAT_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_EMBED_MODEL = 'openai/text-embedding-3-small';

async function main(): Promise<void> {
  loadDotEnv();
  const apiKey = process.env['OPENROUTER_API_KEY'];
  if (!apiKey) {
    console.error('OPENROUTER_API_KEY is not set.');
    process.exitCode = 1;
    return;
  }
  // DEC-02: raw ticket history with no tags. Intent labels are ignored here
  // on purpose; only subject and body feed the job.
  const corpusPath = process.env['CORPUS_PATH'];
  // Corpus mode never defaults into the repo root: labels and sample ids
  // derive from real customer text, and only /corpus/ is gitignored
  // (DEC-18). Synthetic mode keeps the old default.
  let outputPath: string;
  if (corpusPath !== undefined) {
    const output = resolveCorpusOutput(process.argv.slice(2), 'corpus/taxonomy-candidates-real.json');
    if ('refusal' in output) {
      console.error(output.refusal);
      process.exitCode = 1;
      return;
    }
    outputPath = output.path;
  } else {
    outputPath = process.argv.slice(2).filter((arg) => arg !== '--')[0] ?? 'taxonomy-candidates.json';
  }

  let items: HistoryItem[];
  if (corpusPath !== undefined) {
    const corpus = loadCorpusFile(corpusPath);
    items = corpusHistoryItems(corpus.tickets);
    const later = corpus.tickets.length - items.length;
    // Always printed, including zero: an absent line cannot be told apart
    // from "not reported", and the runbook tells an operator to read it.
    console.log(
      `history source: ${corpusPath} (${items.length} real first turns, `
        + `${later} later turns excluded, gitignored)`,
    );
  } else {
    const { fit, report } = loadGoldSet();
    items = [...fit.tickets, ...report.tickets].map((ticket) => ({
      id: ticket.ticket_id,
      text: goldCaseText(ticket),
    }));
    console.log('history source: synthetic fixture gold set');
  }

  const provider = new OpenRouterProvider({
    apiKey,
    ...(process.env['OPENROUTER_BASE_URL']
      ? { baseUrl: process.env['OPENROUTER_BASE_URL'] }
      : {}),
    ...dataGuaranteeOption(),
  });

  const chatModelVer = process.env['CHAT_MODEL_VER'] ?? DEFAULT_CHAT_MODEL;
  const embedModelVer = process.env['EMBED_MODEL_VER'] ?? DEFAULT_EMBED_MODEL;

  console.log(
    `embedding ${items.length} history tickets and clustering (cap ${INTENT_CAP} intents)...`,
  );
  const taxonomy = await induceTaxonomy(provider, {
    items,
    promptVer: PROMPT_VER,
    chatModelVer,
    embedModelVer,
    ...(corpusPath !== undefined ? { source: CORPUS_SOURCE } : {}),
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(taxonomy, null, 2)}\n`, 'utf8');
  console.log(
    `wrote ${outputPath}: ${taxonomy.candidates.length} named candidates ` +
      `(cap ${INTENT_CAP - 1}) + other group of ${taxonomy.other.size}, ` +
      `${taxonomy.cost_micros} micro-dollars`,
  );
  if (corpusPath !== undefined) {
    console.log('this artifact holds real-derived data. It is gitignored and must stay that way (DEC-18).');
  }
}

// The idiom three other jobs already use. Without it this module runs on
// import, so nothing could test the guards inside it — which is how a guard
// cloned here to close a class inherited the original's absence of tests.
if (startedAsCommand(import.meta.url, process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
