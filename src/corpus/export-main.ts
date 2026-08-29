// CLI for the real-corpus export. Run via:
//
//   pnpm run export-corpus [-- corpus/history-2026-01-31.json]
//
// Environment:
//   CORPUS_FETCH_CMD  required. A command whose stdout is one JSON object
//                     per line: {"sourceId": "...", "rfc5322Text": "..."}.
//                     Wrap your IMAP client (or any mailbox reader) in this
//                     command; the export feeds every message through the
//                     existing ImapPoller + ImapSmtpAdapter path.
//
// The output lands under corpus/ by default. That directory is gitignored:
// exported history is real customer text and never enters the repository
// (DEC-18). The PII guard on fixtures/ stays responsible for the committed
// synthetic set.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { ImapPoller } from '../ingress/imap-poller.js';
import type { NormalizedEvent } from '../adapters/types.js';
import { buildCorpusTickets, validateCorpusFile } from './corpus.js';

const execAsync = promisify(exec);
const MAX_FETCH_BUFFER_BYTES = 512 * 1024 * 1024;

interface FetchedMessage {
  sourceId: string;
  rfc5322Text: string;
}

async function main(): Promise<void> {
  const fetchCmd = process.env['CORPUS_FETCH_CMD'];
  if (!fetchCmd) {
    console.error('CORPUS_FETCH_CMD is not set.');
    console.error('Set it to a command that prints one {"sourceId","rfc5322Text"} JSON object per line.');
    process.exitCode = 1;
    return;
  }

  const outputPath = process.argv[2] ?? defaultOutputPath();

  // The command routinely embeds a credential (`curl -u user:pass`, an
  // IMAP password), and this line reaches terminal scrollback and CI logs.
  // The first token names the tool, which is all an operator needs.
  console.log(`fetching mailbox through: ${fetchCmd.trimStart().split(/\s/)[0] ?? '(unnamed)'} [arguments hidden]`);
  const messages = await fetchMessages(fetchCmd);
  console.log(`fetched ${messages.length} messages`);

  // The existing IMAP fetcher path: poller normalizes each message through
  // the adapter and isolates per-message failures.
  const events: NormalizedEvent[] = [];
  const poller = new ImapPoller({
    fetchMessages: () => Promise.resolve(messages),
    onEvent: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    onError: () => {},
  });
  const result = await poller.pollOnce();
  if (result.failures.length > 0) {
    console.warn(`${result.failures.length} messages failed normalization and are excluded`);
    for (const failure of result.failures.slice(0, 5)) {
      const reason = failure.error instanceof Error ? failure.error.message : String(failure.error);
      console.warn(`  ${failure.sourceId}: ${reason}`);
    }
  }
  if (events.length === 0) {
    console.error('no message normalized; nothing to export');
    process.exitCode = 1;
    return;
  }

  const tickets = buildCorpusTickets(events);
  const file = validateCorpusFile({
    split: 'corpus',
    source: 'imap',
    count: tickets.length,
    tickets,
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(file, null, 2) + '\n');
  console.log(
    `corpus written: ${outputPath} (${file.count} threads from ${events.length} messages, ` +
    `${result.failures.length} failures excluded)`,
  );
  console.log('this file holds real customer text. It is gitignored and must stay that way (DEC-18).');
}

function defaultOutputPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join('corpus', `history-${date}.json`);
}

async function fetchMessages(command: string): Promise<FetchedMessage[]> {
  const { stdout } = await execAsync(command, { maxBuffer: MAX_FETCH_BUFFER_BYTES });
  const messages: FetchedMessage[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed !== 'object' || parsed === null ||
      typeof (parsed as Record<string, unknown>)['sourceId'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['rfc5322Text'] !== 'string'
    ) {
      throw new Error(`CORPUS_FETCH_CMD emitted a line without sourceId/rfc5322Text strings: ${line.slice(0, 80)}`);
    }
    const record = parsed as Record<string, unknown>;
    messages.push({
      sourceId: record['sourceId'] as string,
      rfc5322Text: record['rfc5322Text'] as string,
    });
  }
  return messages;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
