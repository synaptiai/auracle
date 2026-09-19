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
  // DEC-48: a case a reviewer finishes with no reply. It sends nothing: the
  // run lands `closed`, the journal records who and why, and the hold ends.
  closeRun: 'finishes a waiting case with no reply, and records who closed it and why',
  handoverHold: 'moves a live hold to the teammate it names',
  readHold: 'clears a hold whose period ran out and records the lapse it found',
  releaseHold: 'ends the holder\'s hold on a case',
  // DEC-44: the reply a reviewer edits on the case screen, saved onto the
  // turn it answers. One statement under the run's row lock, and no state
  // moves with it.
  saveReply: 'the reply a reviewer saved: it writes the text the approval will send',
  takeHold: 'takes a case for one reviewer, and releases the taker\'s others',
  // DEC-51: the way back inside a held send. It removes every effect of the
  // approval — the record, the approver, the distance, the approved text and
  // the finish time — so a batch confirmed by mistake can be taken back.
  undoApproval: 'reverses an approval inside its hold period, and refuses outside it',
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
// DEC-48: the codes a turn's two absences can carry. Exported so the console
// that words them is held to the reader's own union: a table keyed by
// `string` renders an eighth code as its own literal, and nobody notices.
export type { MessageAbsence, ReplyAbsence } from '../conversation/query.js';

export { readDocument } from '../documents/query.js';

// The relay's statuses on an outbox row, so a surface can say what each means
// about the customer without repeating the db/006 CHECK.
export { OUTBOX_STATUSES } from '../ledger/insert.js';
export type { OutboxStatus } from '../ledger/insert.js';

export { readLatency } from '../latency/query.js';
export type { PartitionLatency } from '../latency/query.js';

export { readDays } from '../bands/query.js';

export { approveRun } from '../approval/approve.js';

// DEC-48: the case a reviewer finishes with no reply. The bound travels with
// the write, so the form that posts a reason and the ledger that records it
// cannot disagree about how long one may be.
export { MAX_CLOSE_REASON_CHARS, closeRun } from '../outcomes/close.js';
export type { CloseOptions, CloseOutcome } from '../outcomes/close.js';

// DEC-46: the digest of the reply a page drew, which the console puts in its
// approval form and the approval recomputes under the run's lock. One
// definition, because the two must agree byte for byte on the text.
export { replyDigest } from '../approval/shown.js';

// DEC-44: whether a copy read back from the helpdesk holds text at all. One
// rule, read by the approval that compares it and by the case screen that
// draws it, so a copy a person cleared is not offered as a text to send.
export { copyHoldsText } from '../approval/reply-copy.js';

// DEC-45: whether an identity may review, and DEC-47: the products that
// reviewer covers, which the queue reads to put their cases first. Both are
// reads, and they are the only part of the roster the console reaches: the
// writers are a command-line tool's, so a console can never add itself a
// reviewer or move a product into its own list.
export { activeReviewer, reviewerProducts } from '../reviewers/roster.js';

// DEC-47: the product catalogue. The console reads it once at startup for
// the labels it draws. It is a file read rather than a ledger read, and it
// opens no connection: `src/test-support/purity.test.ts` lists this barrel
// for the reads beside it, not for this one.
export { productCatalogueFromEnv, type ProductCatalogue } from '../config/products.js';

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
export type { ReadBackAdapter } from '../adapters/read-back.js';
export type { DraftReadBack } from '../adapters/types.js';
// DEC-30: the class of egress failure a retry can never clear. The console
// reads it to tell the reader of a failed read-back whether the fault is
// worth retrying or needs a configuration put back in step.
export { PermanentEgressError } from '../adapters/types.js';
export type { ApproveOptions, ApproveOutcome } from '../approval/approve.js';
// DEC-44: the console's second write. The reply a reviewer saves, guarded the
// way the approval is guarded (DEC-46), so the text a person edits is the text
// the approval sends.
export { saveReply } from '../approval/save-reply.js';
export type { SaveOutcome, SaveReplyOptions } from '../approval/save-reply.js';

// DEC-51: the way back inside a held send. The console's third write.
export { undoApproval } from '../approval/undo.js';
export type { UndoOptions, UndoOutcome } from '../approval/undo.js';
// and the read that draws it: whether a send is still held, and for how long.
export { readApprovalHold } from '../approval/undo.js';
export type { ApprovalHold } from '../approval/undo.js';
