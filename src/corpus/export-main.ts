// CLI for the real-corpus export. Run via:
//
//   pnpm run export-corpus [-- corpus/history-2026-01-31.json]
//
// Environment:
//   CORPUS_FETCH_CMD       required. A command whose stdout is one JSON object
//                          per line: {"sourceId": "...", "rfc5322Text": "..."}.
//                          Wrap your IMAP client (or any mailbox reader) in this
//                          command; the export feeds every message through the
//                          existing ImapPoller + ImapSmtpAdapter path.
//                          Emit BOTH sides of each thread. The export models
//                          turns now, so an agent reply becomes the reply to
//                          the turn it answered instead of text pasted into a
//                          customer message (DEC-37).
//   CORPUS_AGENT_ADDRESSES optional, comma separated. Mail addresses that
//                          belong to the support side. A message from one of
//                          them is an agent reply. Mail ingress marks every
//                          inbound message as the customer, so without this
//                          the export records the customer's half only.
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
import { buildCorpusTickets, idDigest, validateCorpusFile } from './corpus.js';
import { resolveCorpusOutput, startedAsCommand } from './output-path.js';
import { runEntry } from '../cli/entry.js';
import { errorMessage } from '../errors.js';
import { terminalText } from '../cli/terminal-text.js';

const execAsync = promisify(exec);
const MAX_FETCH_BUFFER_BYTES = 512 * 1024 * 1024;

interface FetchedMessage {
  sourceId: string;
  rfc5322Text: string;
}

/**
 * One line per message the adapter could not normalize.
 *
 * `sourceId` is the operator's raw mailbox identifier — a Message-ID,
 * carrying the customer's domain. This module hides a credential a few lines
 * above for the same reason (DEC-18), so the identifier is named by digest.
 *
 * Exported because it is the only way to test it: a line printed from inside
 * `main` is unreachable from a suite.
 */
export function failureLines(
  failures: readonly { sourceId: string; error: unknown }[],
): string[] {
  return failures.map((failure, index) => {
    const reason = errorMessage(failure.error);
    return `  failure ${index + 1} (id digest ${idDigest(failure.sourceId)}): ${reason}`;
  });
}

/**
 * The warning an export gives when it cannot tell the two sides apart.
 *
 * Mail ingress marks every inbound message as the customer, so without the
 * operator's own support addresses the export records half of each
 * conversation (DEC-37). Extracted, like every other decision in this file,
 * because a line printed from inside `main` is unreachable from a suite.
 */
export function agentAddressWarning(agentAddresses: readonly string[]): string | null {
  if (agentAddresses.length > 0) return null;
  return 'CORPUS_AGENT_ADDRESSES is not set: every message becomes a customer turn, '
    + 'so the export records half of each conversation (DEC-37).';
}

/**
 * Why an export that produced nothing stops, or null when it produced
 * something.
 *
 * Named here rather than left to the validator, which would report it as a
 * file-format fault after the whole mailbox was already fetched.
 */
export function refuseEmptyExport(ticketCount: number, eventCount: number): string | null {
  if (ticketCount > 0) return null;
  return `no record survived: ${String(eventCount)} message(s) normalized, and every one was `
    + 'dropped. The counts above say which rule removed them. Nothing was written.';
}

async function main(): Promise<void> {
  const fetchCmd = process.env['CORPUS_FETCH_CMD'];
  if (!fetchCmd) {
    console.error('CORPUS_FETCH_CMD is not set.');
    console.error('Set it to a command that prints one {"sourceId","rfc5322Text"} JSON object per line.');
    process.exitCode = 1;
    return;
  }

  const output = resolveCorpusOutput(process.argv.slice(2), defaultOutputPath());
  if ('refusal' in output) {
    console.error(output.refusal);
    process.exitCode = 1;
    return;
  }
  const outputPath = output.path;

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
    // Never called on this path: pollOnce reports per-message failures in its
    // result, and ImapPoller routes to onError only from its interval loop.
    // Kept honest rather than empty, in case this ever calls loop().
    onError: (err) => {
      console.error(`poll error: ${terminalText(errorMessage(err))}`);
    },
  });
  const result = await poller.pollOnce();
  if (result.failures.length > 0) {
    console.warn(`${result.failures.length} messages failed normalization and are excluded`);
    for (const line of failureLines(result.failures.slice(0, 5))) console.warn(line);
  }
  if (events.length === 0) {
    console.error('no message normalized; nothing to export');
    process.exitCode = 1;
    return;
  }

  const agentAddresses = (process.env['CORPUS_AGENT_ADDRESSES'] ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address.length > 0);
  const warning = agentAddressWarning(agentAddresses);
  if (warning !== null) console.warn(warning);
  const { tickets, stats, orderFallbackConversations } = buildCorpusTickets(events, { agentAddresses });

  // Printed before validation and before the write. These counters describe
  // the build, and a validation fault used to discard the only explanation of
  // why the build produced what it did.
  console.log(
    `built ${stats.turns} turns across ${stats.threads} threads, from ${events.length} messages`,
  );
  console.log(
    `turn order: ${stats.orderFallbackThreads} thread(s) fell back to delivery order ` +
    'because a message stated no readable time',
  );
  console.log(
    `dropped: ${stats.droppedEmptyMessages} with no body text, ` +
    `${stats.droppedSystemMessages} from neither party, ` +
    `${stats.droppedDuplicateMessages} repeat deliveries of one message, ` +
    `${stats.droppedOrphanAgentMessages} agent message(s) preceding every customer turn, ` +
    `${stats.droppedSubjectlessMessages} message(s) in ${stats.droppedSubjectlessThreads} ` +
    'thread(s) stating no subject at all',
  );
  console.log(
    `${result.failures.length} message(s) failed normalization and are excluded`,
  );

  // Named before validation, which would report it as a file-format fault
  // ("corpus file holds no tickets") after the whole mailbox was fetched.
  const refusal = refuseEmptyExport(tickets.length, events.length);
  if (refusal !== null) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }

  const file = validateCorpusFile({
    split: 'corpus',
    source: 'imap',
    count: tickets.length,
    provenance: {
      ...stats,
      order_fallback_conversations: orderFallbackConversations,
      normalization_failures: result.failures.length,
    },
    tickets,
  });

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(file, null, 2) + '\n');
  console.log(`corpus written: ${outputPath} (${file.count} records)`);
  console.log('this file holds real customer text. It is gitignored and must stay that way (DEC-18).');
}

function defaultOutputPath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join('corpus', `history-${date}.json`);
}

/**
 * Read the mailbox through the operator's own command.
 *
 * Exported for the same reason `failureLines` is: the two DEC-18 guards
 * inside it are unreachable from a suite otherwise, and this file's own
 * docblock states that standard. An earlier version applied the standard to
 * the helper in hand and left its two siblings structurally untestable.
 *
 * Neither guard may quote what it read. The rejection Node builds carries
 * the whole command, credential included; a JSON SyntaxError carries a
 * window of the input, which is a customer's message.
 */
export async function fetchMessages(command: string): Promise<FetchedMessage[]> {
  let stdout: string;
  try {
    ({ stdout } = await execAsync(command, { maxBuffer: MAX_FETCH_BUFFER_BYTES }));
  } catch (err: unknown) {
    // Node builds this rejection's message as `Command failed: <the whole
    // command>`, and the top-level handler prints it. The command routinely
    // embeds a credential, which is why the startup line above hides its
    // arguments — and a bad credential is the likeliest way to reach here, so
    // the unguarded path leaked the secret in exactly the common case.
    const code = (err as { code?: number }).code;
    throw new Error(
      `CORPUS_FETCH_CMD failed${code === undefined ? '' : ` with exit code ${String(code)}`}; `
        + 'arguments hidden. Run the command yourself to see its output.',
    );
  }
  const messages: FetchedMessage[] = [];
  for (const [index, line] of stdout.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    // The line is mail-derived by construction, so no fault here quotes it.
    // Node embeds a prefix of the input in a JSON SyntaxError, which is how a
    // customer's message text would reach a CI log (DEC-18).
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`CORPUS_FETCH_CMD emitted invalid JSON on line ${index + 1}`);
    }
    if (
      typeof parsed !== 'object' || parsed === null ||
      typeof (parsed as Record<string, unknown>)['sourceId'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['rfc5322Text'] !== 'string'
    ) {
      throw new Error(
        `CORPUS_FETCH_CMD line ${index + 1} has no sourceId and rfc5322Text strings`,
      );
    }
    const record = parsed as Record<string, unknown>;
    messages.push({
      sourceId: record['sourceId'] as string,
      rfc5322Text: record['rfc5322Text'] as string,
    });
  }
  return messages;
}

// The idiom three other jobs already use. Without it this module runs on
// import, so nothing could test the guards inside it — which is how a guard
// cloned here to close a class inherited the original's absence of tests.
if (startedAsCommand(import.meta.url, process.argv[1])) {
  void runEntry(main);
}
