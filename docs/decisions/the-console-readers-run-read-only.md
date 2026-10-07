# The console readers run read-only

## Problem

Without this change, four reader modules that the console calls send their statements outside `boundedRead`.
They are the run journal, the conversation, the document and the latency report.
Each module header says that the module never writes, so it is safe against a live database.
So a source guard is the only thing that holds that promise.

The guard reads each statement and checks its text.
A text check cannot be complete. `pg_terminate_backend` ends another session, and `SELECT … INTO` creates a table.
Both start with SELECT.
Each reader sends its statements on the pool that the console also writes with.
So a write that the guard misses reaches the ledger.

## Proposed outcome

Each of the four readers runs its statements through `boundedRead`.
That helper opens one READ ONLY transaction at REPEATABLE READ, and it bounds each statement and the whole read.
It sends each statement alone, so the server refuses a second statement in one string.
It refuses a statement that does not start as a read, so a read cannot end its own transaction.
It refuses every statement once the read starts to end, so a statement function kept past its read sends nothing.
After the read, the helper discards the session's state.

`src/db/bounded-read.db.test.ts` holds each of these rules against the database.
It sends `SELECT 1; COMMIT; INSERT …`, a `COMMIT` followed by an `INSERT`, and a write after the read has ended.
None of them writes a row.

The guard holds each module that reads through `boundedRead`.
It refuses `INTO`, a row lock, a word that writes, and a second statement.
It allows only the functions, the globals and the imports that the readers use today.
It finds a pool by the members that `pg` declares.
The guard cannot read four modules, and it names each one.
Each hands the statement function to a helper, builds a statement at runtime, or both.

## Threat model

The guards catch a mistake in ordinary code.
Examples are a write added to a reader, a pool handed to a helper and a call that changes something.
They do not stop code that someone writes to evade them.
Such code can always find a form that a source guard does not read.
A database role is the barrier against that code.

READ ONLY refuses a write to a table, and it does not refuse every effect.
A function can still act on another session.
A superuser's session can still write to the catalog or create a replication slot.
The readers' role can neither act on another session nor create a replication slot.
It writes to the catalog only to change its own password, settings and default rights.

## Affected users and systems

- The console pages that show a run, a case, a conversation, a document and the partition latency.
- The console actions that read a run before they write: approve, confirm a batch, edit, publish and rewrite.
- `readRunJournal`, `readConversation`, `turnAnsweredBy`, `conversationOfRun` and `readDocument`.
- `readLatency`, which the console's latency page and `pnpm run latency` call.
- `boundedRead`, which the queue count, the team, routing and knowledge screens and the rerun list also use.
- `src/journal/journal.test.ts` and `src/latency/latency.test.ts`, the source guards.

## Constraints

- A reader returns what it returned before. Only the transaction and the bounds change.
- Each reader keeps its own statement bound. The latency report has 60 seconds, as the bands report does, and each other reader has 2. The statements of one read share a client deadline one second longer. The end of the read shares one more deadline of that length.
- The two statements of a journal read or a conversation read now read one snapshot.
- The console's writes keep their own path (DEC-44). This change touches no write.
- A console read that does not go through `boundedRead` still uses a plain connection, with no statement timeout. The case page's hold read is one, and it writes.

## Decisions affected

Affects: DEC-40, DEC-44

DEC-40 lets a read-only operator console approve a parked action.
This change makes the four readers it moves read-only in the database, not only in their source.
The database refuses a write to a table from one of them, even when the statement that writes is new.

DEC-44 makes the console write on every adapter.
Those writes go through the core functions that the console takes from its barrel.
This change routes none of them through `boundedRead`, so each write keeps its own transaction.

## Open questions

A database role for the readers, with no superuser right and no `pg_signal_backend`, would refuse what READ ONLY lets through.
It would also stand behind the four modules that the guard cannot read.
That role is deployment configuration, and an issue of its own tracks it.
