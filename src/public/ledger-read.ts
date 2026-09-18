// Every read a second interface may make against the ledger, and the five
// writes it may make.
//
// Read-side by default, deliberately. The writes are named in `LEDGER_WRITES`
// below: the approval bridge a person drives (DEC-12), and the case holds
// (DEC-46). Nothing here walks the state machine, drains the outbox or writes
// a step journal.
//
// This module opens connections, transitively. `src/test-support/purity.test.ts`
// lists it alongside `db/config` for that reason, so a pure `*.test.ts` that
// imports it fails rather than reaching a real database through a barrel.
export { probeLedger, requireDbUrl } from '../db/config.js';

/**
 * Every export of this barrel that can change the ledger (DEC-46).
 *
 * The rest are reads. The console that drives this barrel has exactly the
 * writes it names for itself, and its guard holds it to that: a write here
 * that the console calls without naming it as a write fails
 * `console/src/select-only.test.ts`. So a new write belongs in this record
 * the moment it is exported, or the console's guard is blind to it.
 *
 * Each entry says what the write does, because the name alone does not
 * always say it: `readHold` writes.
 */
export const LEDGER_WRITES: Readonly<Record<string, string>> = {
  approveRun: 'the approval: it commits the send, the run it resolves and the edit distance',
  handoverHold: 'moves a live hold to the teammate it names',
  readHold: 'clears a hold whose period ran out and records the lapse it found',
  releaseHold: 'ends the holder\'s hold on a case',
  takeHold: 'takes a case for one reviewer, and releases the taker\'s others',
};

export { LEDGER_STATES, listEscalations, listRuns, readRun } from '../escalations/query.js';
export type { EscalationItem, EscalationFilters } from '../escalations/query.js';

export { readQueueToday } from '../escalations/today.js';
export type { QueueToday } from '../escalations/today.js';

export { readRunJournal } from '../journal/query.js';
export type { JournalStep, RunJournal } from '../journal/query.js';

export {
  conversationOfRun,
  readConversation,
  turnAnsweredBy,
} from '../conversation/query.js';

export { readDocument } from '../documents/query.js';

// The relay's statuses on an outbox row, so a surface can say what each means
// about the customer without repeating the db/006 CHECK.
export { OUTBOX_STATUSES } from '../ledger/insert.js';
export type { OutboxStatus } from '../ledger/insert.js';

export { readLatency } from '../latency/query.js';
export type { PartitionLatency } from '../latency/query.js';

export { readDays } from '../bands/query.js';

export { approveRun } from '../approval/approve.js';

// DEC-46: the digest of the reply a page drew, which the console puts in its
// approval form and the approval recomputes under the run's lock. One
// definition, because the two must agree byte for byte on the text.
export { replyDigest } from '../approval/shown.js';

// DEC-45: whether an identity may review. A read, and the only part of the
// roster the console reaches: the writers are a command-line tool's, so a
// console can never add itself a reviewer.
export { activeReviewer } from '../reviewers/roster.js';

// DEC-46: the case hold. `takeHold` is a write, and it joins `approveRun` as
// one of the console's own — `console/src/select-only.test.ts` names every
// write the console may make, so a new one fails that guard until it is
// named there. The rest are reads; `readHolds` is the queue's, one statement
// for every row.
export {
  handoverHold, holdHistory, readHold, readHolds, releaseHold, takeHold,
} from '../holds/hold.js';
export type {
  HandoverOutcome, Hold, HoldEvent, ReleaseOutcome, TakeOutcome,
} from '../holds/hold.js';

// The adapters an approval reads a parked draft back from. A read of the
// helpdesk, never a write.
export { READ_BACK_ADAPTER_NAMES, selectReadBackAdapter } from '../adapters/read-back.js';
export type { DraftReadBack } from '../adapters/types.js';
export type { ApproveOptions, ApproveOutcome } from '../approval/approve.js';
