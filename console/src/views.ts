// What a ledger row and a journal step say on a page (issue #27).
//
// Its own module for the reason `hosts.ts` and `ledger-name.ts` have one:
// `main.ts` runs `main()` when it is imported, so nothing defined there can
// be reached from a test. These three decide what an operator reads about a
// run, which is not a thing to leave unasserted.
//
// They map and nothing else. No statement is issued here, and every value
// comes from a reader in the root package.
import { CLASSIFIER_K } from 'auracle/dist/classifier/classifier.js';
import type { JournalStep, RunJournal } from 'auracle/dist/journal/query.js';

import { escalationHead } from './render.js';
import type { PartitionLatency } from 'auracle/dist/latency/query.js';

import type { RunDetail, RunRow } from './surfaces.js';

export function toRow(item: {
  runId: string; ticketId: string; state: string; promptVer: string;
  reason: string | null; costMicros: number; stepsUsed: number;
}): RunRow {
  return {
    runId: item.runId,
    ticketId: item.ticketId,
    state: item.state,
    promptVer: item.promptVer,
    // Trimmed here, at the one boundary every surface reads through, so no
    // surface can render the untrimmed value by forgetting to ask.
    reason: escalationHead(item.reason),
    stepsUsed: item.stepsUsed,
  };
}

/**
 * A run's two gate values, on a surface that does not read them.
 *
 * The approval queue reads the escalation module, which reports what a person
 * needs to work the queue and carries neither gate number. Reading the
 * journal for every waiting run would be one statement per row on an uncapped
 * list, so the queue shows a dash and links to the run detail, which reads
 * them for one run.
 *
 * A dash, never a zero. Zero agreement says the samples disagreed completely,
 * which is a measurement rather than its absence.
 */
const GATES_NOT_READ = { agreement: null, coverage: null } as const;

export function toDetail(item: Parameters<typeof toRow>[0] & { draftExternalId: string | null }): RunDetail {
  return { ...toRow(item), ...GATES_NOT_READ, draftExternalId: item.draftExternalId };
}

/**
 * What one journal row recorded, in a line.
 *
 * The wording lives here rather than in the surfaces, because it is a reading
 * of the query module's shapes and it changes when those change. No line
 * carries a duration: `step_journal` has no timestamp, so no step has one.
 */
export function stepSays(step: JournalStep, journal: RunJournal): string | null {
  if (step.faultShape !== null) return `failed on a ${step.faultShape} answer`;
  switch (step.stepId) {
    case 'classify': {
      const read = journal.agreement;
      if (read === null) return null;
      const samples = Math.round(read.agreement * CLASSIFIER_K);
      return `intent ${read.intentId} · ${samples} of ${CLASSIFIER_K} samples agreed`;
    }
    case 'retrieve': {
      const count = journal.documents?.length ?? null;
      const embed = step.embedModelVer === null ? '' : ` · embed ${step.embedModelVer}`;
      return count === null ? null : `${count} documents${embed}`;
    }
    case 'compose': {
      const composed = step.compose;
      if (composed === null) return null;
      if (composed.abstained) return `abstained · ${composed.provider ?? 'provider unrecorded'}`;
      const claims = composed.claimCount === null ? 'claims unrecorded' : `${composed.claimCount} claims`;
      return `${claims} · ${composed.provider ?? 'provider unrecorded'}`;
    }
    case 'gate': {
      const read = journal.coverage;
      return read === null ? null : `${read.decision} · ${read.reason ?? 'reason unrecorded'}`;
    }
    case 'park': {
      const parked = step.park;
      if (parked === null) return null;
      // The parked body and the action payload are recorded as present, never
      // shown. Both carry the composed reply, and this console authenticates
      // nobody; the operator edits the draft in the helpdesk, which is where
      // DEC-11 keeps it.
      // Four park rows exist, and reading only the two presence flags folded
      // the other two into `nothing recorded` — an absence asserted where the
      // ledger holds a measurement, which is the reverse of the rule every
      // other surface here follows.
      //
      // The crash marker records a park key and no body: a draft may exist in
      // the helpdesk that nobody can name, and that is what a person has to
      // reconcile. The refusal records the adapter's error, withheld because
      // it can quote a customer address, but its presence is not withheld.
      const held = parked.draftRecorded
        ? 'draft held in the helpdesk'
        : parked.payloadRecorded
          ? 'action payload recorded'
          : parked.failureRecorded
            ? 'the adapter refused before it appended'
            : parked.parkKey === null
              ? 'nothing recorded'
              : 'park key recorded, no draft named';
      return `${parked.actionClass ?? 'action unrecorded'} · ${parked.delivery ?? 'delivery unrecorded'} · ${held}`;
    }
    case 'execute':
      return step.idemKey === null ? null : `idempotency key ${step.idemKey}`;
    case 'escalate':
      return escalationHead(step.escalationReason);
    default:
      return null;
  }
}

/**
 * The runs a partition's percentiles could not describe, named for a reader.
 *
 * Deliberately not `excluded` from `src/latency/run.ts`. That function prints
 * the ledger's own state names — `unmeasured`, `never_ran` — which is right
 * for a command an engineer runs and wrong for a console an operator reads.
 * The wording differs on purpose.
 *
 * What must not differ is the coverage. Six states exist and a seventh would
 * be invisible here, so `views.test.ts` holds this list against the fields
 * the query module exposes rather than against a copy of them.
 *
 * Folding these in as zeros would invent the most flattering possible number
 * about the runs the ledger knows least about.
 */
export function latencyCaveats(p: PartitionLatency): string[] {
  const pairs: readonly (readonly [number, string])[] = [
    [p.wait.unmeasured, 'no arrival time'],
    [p.wait.unordered, 'pickup before arrival'],
    [p.service.unfinished, 'still running'],
    [p.service.unstamped, 'no finish time'],
    [p.service.unordered, 'finish before start'],
    [p.service.neverRan, 'never ran'],
  ];
  return pairs.filter(([count]) => count > 0).map(([count, says]) => `${count} ${says}`);
}
