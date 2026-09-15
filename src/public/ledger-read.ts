// Every read a second interface may make against the ledger.
//
// Read-side only, deliberately. The one write in it is `approveRun`, which is
// the approval bridge a person drives (DEC-12): a customer reply always needs
// approval, and the console is where that approval happens. Nothing here
// walks the state machine, drains the outbox or writes a step journal.
//
// This module opens connections, transitively. `src/test-support/purity.test.ts`
// lists it alongside `db/config` for that reason, so a pure `*.test.ts` that
// imports it fails rather than reaching a real database through a barrel.
export { probeLedger, requireDbUrl } from '../db/config.js';

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

// The adapters an approval reads a parked draft back from. A read of the
// helpdesk, not a write: the approval above is still the one write here.
export { READ_BACK_ADAPTER_NAMES, selectReadBackAdapter } from '../adapters/read-back.js';
export type { DraftReadBack } from '../adapters/types.js';
export type { ApproveOptions, ApproveOutcome } from '../approval/approve.js';
