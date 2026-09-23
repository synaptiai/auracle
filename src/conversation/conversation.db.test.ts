// The conversation reader, against the ledger (DEC-35, DEC-37).
//
// The point of these cases is the absences. A turn the system answered
// without a customer reply, a turn whose text was never retained, and a turn
// no run joins are three different facts, and a surface that showed one blank
// row for all three would be lying about two of them.
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { OUTBOX_STATUSES } from '../ledger/insert.js';
import { truncateLedger } from '../test-support/schema.js';
import { conversationOfRun, readConversation, turnAnsweredBy } from './query.js';

const pool = new Pool({ connectionString: dbUrl(), max: 4 });

afterAll(async () => {
  await pool.end();
});


beforeEach(async () => {
  await truncateLedger(pool);
});

async function conversation(address: string | null = 'someone@customer.example'): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO conversation (conversation_id, primary_ticket_id, customer_address)
     VALUES ($1, 'SYN-1', $2)`,
    [id, address],
  );
  return id;
}

async function turn(
  conversationId: string,
  turnNumber: number,
  fields: { body?: string | null; reply?: string | null } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO turn (conversation_id, turn_number, ticket_id, body_text, approved_reply_text)
     VALUES ($1, $2, 'SYN-1', $3, $4)`,
    [conversationId, turnNumber, fields.body ?? null, fields.reply ?? null],
  );
}

async function run(
  conversationId: string,
  turnNumber: number | null,
  state: string,
  approvedBy: string | null = null,
): Promise<string> {
  const id = randomUUID();
  // DEC-45: the name and its source travel together, and the ledger holds
  // that with a CHECK — including that `unattributed` pairs with `none`,
  // because that name is the column's way of recording nobody. This helper
  // writes the pair the shipped writers write, so a case that models an
  // approval models a row the ledger accepts.
  await pool.query(
    `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                      cost_micros, steps_used, deadline_at, conversation_id, turn_number,
                      approved_by, approved_by_source)
     VALUES ($1, 'SYN-1', 0, 1, $2, 'p', 'm', 0, 0, now(), $3, $4, $5, $6)`,
    [id, state, conversationId, turnNumber, approvedBy, sourceFor(approvedBy)],
  );
  return id;
}

/**
 * The source that goes with a name a case names: `none` when the name records
 * nobody, and a claim when a caller passed one. A real console row reads
 * `roster`, and `approval.db.test.ts` holds that path.
 */
function sourceFor(approvedBy: string | null): 'header' | 'none' | null {
  if (approvedBy === null) return null;
  return approvedBy === 'unattributed' ? 'none' : 'header';
}

/**
 * An outbox row as the writers leave one. The approval of a reply writes a
 * `customer_reply` row whose payload names the parked draft; the automatic
 * path writes an internal action with its own payload.
 */
async function outbox(
  runId: string,
  stepId: string,
  status: string,
  options: { actionClass?: string; draft?: boolean } = {},
): Promise<void> {
  const draft = options.draft ?? stepId === 'approve';
  const actionClass = options.actionClass ?? (draft ? 'customer_reply' : 'tag_ticket');
  const payload = draft ? { draftExternalId: `draft-${runId}` } : { queue: 'triaged' };
  await pool.query(
    `INSERT INTO outbox (run_id, step_id, idem_key, epoch, action_class, delivery, payload, status)
     VALUES ($1, $2, $3, 1, $5, 'at_most_once', $6::jsonb, $4)`,
    [runId, stepId, `idem-${runId}-${stepId}`, status, actionClass, JSON.stringify(payload)],
  );
}

/**
 * The park row a run journals, as the park step leaves one (DEC-11, DEC-34):
 * a customer reply names its helpdesk draft, and an internal write parks in
 * the ledger alone with its payload. `status` other than `done` is the crash
 * marker or a refusal.
 */
async function park(
  runId: string,
  result: Record<string, unknown> | null,
  status = 'done',
): Promise<void> {
  await pool.query(
    `INSERT INTO step_journal (run_id, step_id, status, result, prompt_ver, model_ver, cost_micros)
     VALUES ($1, 'park', $2, $3::jsonb, 'p', 'm', 0)`,
    [runId, status, result === null ? null : JSON.stringify(result)],
  );
}

const DRAFTED = { draftExternalId: 'hd-draft-0001', actionClass: 'customer_reply', body: 'Open the settings page.' };
const LEDGER_ONLY = { actionClass: 'compensate', payload: { amount: 500 }, body: 'A refund of five euros.' };

// DEC-44: the two reply columns the case screen reads. `turnAnsweredBy` is
// the console's only read of them, so a rule about what an empty stored reply
// means lives here and nowhere else.
describe('the turn a run answered, and the replies on it', () => {
  async function setReplies(
    conversationId: string,
    turnNumber: number,
    saved: string,
    approved: string,
  ): Promise<void> {
    await pool.query(
      `UPDATE turn SET saved_reply_text = $3, approved_reply_text = $4
        WHERE conversation_id = $1 AND turn_number = $2`,
      [conversationId, turnNumber, saved, approved],
    );
  }

  it('reads the reply a reviewer saved and the reply an approval sent', async () => {
    const id = await conversation();
    await turn(id, 1);
    await setReplies(id, 1, 'The reply a reviewer saved.', 'The reply the approval sent.');
    const runId = await run(id, 1, 'awaiting_approval');

    expect(await turnAnsweredBy(pool, runId)).toMatchObject({
      savedReplyText: 'The reply a reviewer saved.',
      approvedReplyText: 'The reply the approval sent.',
    });
  });

  // An empty stored string is no reply, never a blank one. Drawn as text it
  // would be an empty editor over a case whose reply the ledger does not
  // hold, and a case that printed "The reply the approval sent" over nothing.
  it('reads an empty stored reply as none at all', async () => {
    const id = await conversation();
    await turn(id, 1);
    await setReplies(id, 1, '', '');
    const runId = await run(id, 1, 'awaiting_approval');

    expect(await turnAnsweredBy(pool, runId)).toMatchObject({
      savedReplyText: null,
      approvedReplyText: null,
    });
  });

  it('reads a reply the ledger has never held as none', async () => {
    const id = await conversation();
    await turn(id, 1);
    const runId = await run(id, 1, 'awaiting_approval');

    expect(await turnAnsweredBy(pool, runId)).toMatchObject({
      savedReplyText: null,
      approvedReplyText: null,
    });
  });
});

describe('a conversation the ledger holds', () => {
  it('answers null for one it does not hold, and for a malformed id', async () => {
    expect(await readConversation(pool, randomUUID())).toBeNull();
    // Asked before the ledger is: the column is uuid, and a driver exception
    // is not an answer a surface can render.
    expect(await readConversation(pool, 'not-a-uuid')).toBeNull();
  });

  it('returns its turns in turn order, not insertion order', async () => {
    const id = await conversation();
    await turn(id, 2, { body: 'second' });
    await turn(id, 1, { body: 'first' });
    await turn(id, 3, { body: 'third' });
    const thread = await readConversation(pool, id);
    expect(thread?.turns.map((t) => t.turnNumber)).toEqual([1, 2, 3]);
    expect(thread?.turns.map((t) => t.bodyText)).toEqual(['first', 'second', 'third']);
  });

  it('says a participant is named without saying who', async () => {
    const named = await readConversation(pool, await conversation('ada@customer.example'));
    expect(named?.participantNamed).toBe(true);
    expect(JSON.stringify(named)).not.toContain('ada@customer.example');
    const unnamed = await readConversation(pool, await conversation(null));
    expect(unnamed?.participantNamed).toBe(false);
  });

  it('joins each turn to the newest run of this turn', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'hello', reply: 'hi' });
    const runId = await run(id, 1, 'resolved');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.runId).toBe(runId);
    expect(thread?.turns[0]?.runState).toBe('resolved');
  });

  // A resolved run commits its outbox row and does not deliver it. The relay
  // records what became of the send on that row, and a surface that inferred
  // delivery from the run state alone would call a pending reply sent.
  it('returns the outbox status of each turn', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'one', reply: 'answer one' });
    await turn(id, 2, { body: 'two', reply: 'answer two' });
    await turn(id, 3, { body: 'three' });
    await turn(id, 4, { body: 'four' });
    const sent = await run(id, 1, 'resolved', 'reviewer-synthetic');
    const pending = await run(id, 2, 'resolved', 'reviewer-synthetic');
    await run(id, 3, 'awaiting_approval');
    await outbox(sent, 'approve', 'sent');
    await outbox(pending, 'approve', 'pending');
    const thread = await readConversation(pool, id);
    expect(thread?.turns.map((t) => t.outboxStatus)).toEqual(['sent', 'pending', null, null]);
  });

  // A retry of the automatic path derives the same key, loses the outbox
  // insert and stops superseded with no row (section 4.2, rule 2). The turn
  // still shows that retry, and reads the row the earlier run holds.
  it('reads the outbox row an earlier run holds when the newest was superseded', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'retried' });
    const earlier = await run(id, 1, 'resolved');
    await outbox(earlier, 'execute', 'sent');
    await pool.query("UPDATE run SET created_at = now() - interval '1 hour' WHERE run_id = $1", [earlier]);
    const retry = await run(id, 1, 'superseded');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.runId).toBe(retry);
    expect(thread?.turns[0]?.runState).toBe('superseded');
    // The absence is the retry's own: it sent nothing. The row says the rest.
    expect(thread?.turns[0]?.replyAbsence).toBe('no_reply_sent');
    expect(thread?.turns[0]?.outboxStatus).toBe('sent');
    expect(thread?.turns[0]?.runAttempts).toBe(2);
  });

  // A redelivered message can park a second run on a turn whose first reply
  // went out. That run waits in the approval queue, so the turn shows it, and
  // the row still says the first reply was sent.
  it('shows a newer run waiting for a person, and the row an earlier run sent', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'redelivered', reply: 'answered once' });
    const earlier = await run(id, 1, 'resolved', 'reviewer-synthetic');
    await outbox(earlier, 'approve', 'sent');
    await pool.query("UPDATE run SET created_at = now() - interval '1 hour' WHERE run_id = $1", [earlier]);
    const parked = await run(id, 1, 'awaiting_approval');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.runId).toBe(parked);
    expect(thread?.turns[0]?.runState).toBe('awaiting_approval');
    expect(thread?.turns[0]?.outboxStatus).toBe('sent');
  });

  // The key comes from the action (DEC-24), so a later run on the turn that
  // took another action holds a row of its own. Its status says nothing about
  // the reply: here the reply's send is unknown, and the later write was sent.
  it('reads the reply row on a turn with reply text, not a later action', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'answered', reply: 'the approved reply' });
    const replied = await run(id, 1, 'escalated', 'reviewer-synthetic');
    await outbox(replied, 'approve', 'delivery_unknown');
    await pool.query("UPDATE run SET created_at = now() - interval '1 hour' WHERE run_id = $1", [replied]);
    const later = await run(id, 1, 'resolved', 'reviewer-synthetic');
    // An approved internal write: step approve, and no draft (DEC-34).
    await outbox(later, 'approve', 'sent', { actionClass: 'tag_ticket', draft: false });
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.runId).toBe(later);
    expect(thread?.turns[0]?.outboxStatus).toBe('delivery_unknown');
  });

  // A profile can mark another class customer-visible, and the approval then
  // writes the reply's row under that class. The draft on the row, not the
  // class, marks it as the reply's, so a later write still cannot speak for it.
  it('reads the reply row by its draft, whatever its action class', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'routed', reply: 'the approved reply' });
    const approved = await run(id, 1, 'escalated', 'reviewer-synthetic');
    await outbox(approved, 'approve', 'delivery_unknown', { actionClass: 'route_ticket' });
    await pool.query("UPDATE run SET created_at = now() - interval '1 hour' WHERE run_id = $1", [approved]);
    const later = await run(id, 1, 'resolved');
    await outbox(later, 'execute', 'sent');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.runId).toBe(later);
    expect(thread?.turns[0]?.outboxStatus).toBe('delivery_unknown');
  });

  // Another action's row says nothing about the reply, so a reply turn whose
  // draft row is absent reads no row rather than that one.
  it('reads no row on a reply turn whose only row names no draft', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'answered', reply: 'the approved reply' });
    const other = await run(id, 1, 'resolved');
    await outbox(other, 'execute', 'sent');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.outboxStatus).toBeNull();
  });

  // Only the approval writes the reply's row. No writer puts a draft on an
  // execute row, so this second row is hand-written: it proves the step, and
  // not the draft alone, decides which row counts.
  it('reads the approval row, not a later row of another step naming a draft', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'answered', reply: 'the approved reply' });
    const approved = await run(id, 1, 'escalated', 'reviewer-synthetic');
    await outbox(approved, 'approve', 'delivery_unknown');
    await pool.query("UPDATE run SET created_at = now() - interval '1 hour' WHERE run_id = $1", [approved]);
    const later = await run(id, 1, 'resolved');
    await outbox(later, 'execute', 'sent', { draft: true, actionClass: 'tag_ticket' });
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.outboxStatus).toBe('delivery_unknown');
  });

  // A reply turn whose approval row is the only row reads it, so a send the
  // relay still retries stays on the page.
  it('reads the only row a reply turn holds', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'routed', reply: 'the approved reply' });
    const approved = await run(id, 1, 'resolved', 'reviewer-synthetic');
    await outbox(approved, 'approve', 'pending', { actionClass: 'route_ticket' });
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.outboxStatus).toBe('pending');
  });

  // The filter applies only on a turn with reply text. A turn without it
  // says what became of its newest action, whatever an earlier draft row says.
  it('reads the newest row on a turn with no reply text, over an older draft row', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'no reply text' });
    const earlier = await run(id, 1, 'resolved', 'reviewer-synthetic');
    await outbox(earlier, 'approve', 'fenced');
    await pool.query("UPDATE run SET created_at = now() - interval '1 hour' WHERE run_id = $1", [earlier]);
    const later = await run(id, 1, 'resolved');
    await outbox(later, 'execute', 'sent');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.outboxStatus).toBe('sent');
  });

  // Between two runs that each hold a row, the newest still decides.
  it('reads the newest of the runs that hold an outbox row', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'twice' });
    const earlier = await run(id, 1, 'resolved');
    await outbox(earlier, 'execute', 'sent');
    await pool.query("UPDATE run SET created_at = now() - interval '1 hour' WHERE run_id = $1", [earlier]);
    const newest = await run(id, 1, 'escalated');
    await outbox(newest, 'execute', 'delivery_unknown');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.runId).toBe(newest);
    expect(thread?.turns[0]?.outboxStatus).toBe('delivery_unknown');
  });

  // Each path writes one step, so a run holds one row. A hand-written second
  // row must still give one answer. `ORDER BY step_id` fixes which: `approve`
  // sorts before `execute`.
  it('reads the approve row when one run holds two', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'two rows' });
    const runId = await run(id, 1, 'resolved', 'reviewer-synthetic');
    await outbox(runId, 'execute', 'fenced');
    await outbox(runId, 'approve', 'sent');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.outboxStatus).toBe('sent');
  });

  // The reader narrows the column to the statuses the relay writes. The set is
  // read from the migrated ledger, so a migration that widens the CHECK fails
  // here and not on a page that cannot say what the new status means.
  it('knows every status the ledger allows on an outbox row, and no other', async () => {
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'outbox_status_check'`,
    );
    const def = String((rows[0] as { def: string }).def);
    const allowed = [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(allowed.length).toBeGreaterThan(0);
    expect([...allowed].sort()).toEqual([...OUTBOX_STATUSES].sort());
  });

  it('refuses a status outside that set rather than drawing it', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'widened' });
    const runId = await run(id, 1, 'resolved');
    const { rows } = await pool.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'outbox_status_check'`,
    );
    const def = String((rows[0] as { def: string }).def);
    await pool.query('ALTER TABLE outbox DROP CONSTRAINT outbox_status_check');
    try {
      await outbox(runId, 'execute', 'bounced');
      await expect(readConversation(pool, id)).rejects.toThrow(/outbox status bounced/);
    } finally {
      await pool.query('DELETE FROM outbox WHERE run_id = $1', [runId]);
      // Put back as the ledger held it, so no later case runs without it.
      await pool.query(`ALTER TABLE outbox ADD CONSTRAINT outbox_status_check ${def}`);
    }
  });

  it('joins no run to a turn whose run recorded no turn number', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'hello' });
    await run(id, null, 'resolved');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.runId).toBeNull();
    expect(thread?.turns[0]?.replyAbsence).toBe('not_retained');
  });
});

describe('the reasons a turn shows no reply', () => {
  it('names an automatic resolution, which sends no customer reply (DEC-12)', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'please close this' });
    await run(id, 1, 'resolved');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyText).toBeNull();
    expect(thread?.turns[0]?.replyAbsence).toBe('handled_automatically');
  });

  // #123: a customer reply parks as a draft in the helpdesk (DEC-11), and an
  // internal write parks in the ledger alone (DEC-34). Both wait for a
  // person, and only the first holds a drafted reply. The park row says which.
  it('names a drafted reply waiting for a person', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'how do I reset my password' });
    await park(await run(id, 1, 'awaiting_approval'), DRAFTED);
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyAbsence).toBe('reply_awaiting_approval');
  });

  it('names an internal write waiting for a person, which holds no draft', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'where is my refund' });
    await park(await run(id, 1, 'awaiting_approval'), LEDGER_ONLY);
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyAbsence).toBe('action_awaiting_approval');
  });

  // The ledger names neither kind, so the page claims neither.
  it('names neither kind for a waiting run with no park recorded', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'where is my refund' });
    await run(id, 1, 'awaiting_approval');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyAbsence).toBe('awaiting_approval');
  });

  // A reply parked in the ledger alone, under a profile that shows no
  // customer, records a payload and is the reply's own action. It is not an
  // internal write, and it holds no draft either.
  it('names neither kind for a reply parked in the ledger alone', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'how do I reset my password' });
    await park(await run(id, 1, 'awaiting_approval'), { ...LEDGER_ONLY, actionClass: 'customer_reply' });
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyAbsence).toBe('awaiting_approval');
  });

  // An internal write records its payload as an object. A payload of another
  // shape names no action.
  it('names neither kind for a park whose payload is not an object', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'where is my refund' });
    await park(await run(id, 1, 'awaiting_approval'), { ...LEDGER_ONLY, payload: 'refund' });
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyAbsence).toBe('awaiting_approval');
  });

  // The newest run decides, as it does for the state. An earlier run's draft
  // belongs to a run that no longer waits.
  it('reads the draft of the run that waits, not of an earlier run', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'where is my refund' });
    const earlier = await run(id, 1, 'superseded');
    await park(earlier, DRAFTED);
    await pool.query("UPDATE run SET created_at = now() - interval '1 minute' WHERE run_id = $1", [earlier]);
    await park(await run(id, 1, 'awaiting_approval'), LEDGER_ONLY);
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyAbsence).toBe('action_awaiting_approval');
  });

  // Only a park that finished names a draft. The crash marker records the
  // intent, and the draft it may have made has no handle anyone can name.
  it('names no draft for a park that never recorded one', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'how do I reset my password' });
    await park(await run(id, 1, 'awaiting_approval'), { parkKey: 'k', draftExternalId: 'hd-1' }, 'parking');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyAbsence).toBe('awaiting_approval');
  });

  // A handle names a draft only as a non-empty string, as the approval
  // requires. A number is present and of the wrong kind, which a test for a
  // present value alone would read as a draft; null and the empty string name
  // nothing.
  for (const [label, handle] of [['a number', 123], ['null', null], ['empty', '']] as const) {
    it(`names no draft for a handle that is ${label}`, async () => {
      const id = await conversation();
      await turn(id, 1, { body: 'how do I reset my password' });
      await park(await run(id, 1, 'awaiting_approval'), { ...DRAFTED, draftExternalId: handle });
      const thread = await readConversation(pool, id);
      expect(thread?.turns[0]?.replyAbsence).toBe('awaiting_approval');
    });
  }

  // A refusal records the adapter's error, and the handle it may carry names
  // no draft the ledger holds.
  it('names no draft for a park the adapter refused', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'how do I reset my password' });
    await park(await run(id, 1, 'awaiting_approval'), { ...DRAFTED, error: 'refused' }, 'failed');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyAbsence).toBe('awaiting_approval');
  });

  it('names a run that stopped without sending', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'this went wrong' });
    await run(id, 1, 'escalated');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyAbsence).toBe('no_reply_sent');
  });

  // A person closed the case without answering it (DEC-48). The two labels
  // beside it are wrong about this turn: the system did not handle it, and
  // nobody approved an action on it.
  it('names a case a person closed with no reply', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'duplicate of another ticket' });
    await run(id, 1, 'closed');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyText).toBeNull();
    expect(thread?.turns[0]?.replyAbsence).toBe('closed_without_reply');
  });

  // A person put the case aside for a period (DEC-48). Neither label beside
  // it is true: the case is not waiting for approval now, and nothing about
  // it is in flight.
  it('names a case a person put aside', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'the parcel is late' });
    // A drafted reply put aside is still put aside: the draft does not decide.
    await park(await run(id, 1, 'snoozed'), DRAFTED);
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyText).toBeNull();
    expect(thread?.turns[0]?.replyAbsence).toBe('put_aside');
  });

  // Every code, every distinct answer. A surface reading these sends an
  // operator somewhere different for each, so two that rendered alike would
  // be worse than one that rendered nothing.
  it('gives each absence its own value', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'a' });
    await run(id, 1, 'resolved');
    await turn(id, 2, { body: 'b' });
    await park(await run(id, 2, 'awaiting_approval'), LEDGER_ONLY);
    await turn(id, 3, { body: 'c' });
    await run(id, 3, 'escalated');
    await turn(id, 4, { body: 'd' });
    await turn(id, 5, { body: 'e' });
    await run(id, 5, 'resolved', 'ops-oncall');
    await turn(id, 6, { body: 'f' });
    await run(id, 6, 'composed');
    await turn(id, 7, { body: 'g' });
    await run(id, 7, 'closed');
    await turn(id, 8, { body: 'h' });
    await run(id, 8, 'snoozed');
    await turn(id, 9, { body: 'i' });
    await park(await run(id, 9, 'awaiting_approval'), DRAFTED);
    await turn(id, 10, { body: 'j' });
    await run(id, 10, 'awaiting_approval');
    const thread = await readConversation(pool, id);
    const codes = thread?.turns.map((t) => t.replyAbsence) ?? [];
    expect(codes).toEqual([
      'handled_automatically', 'action_awaiting_approval', 'no_reply_sent', 'not_retained',
      'approved_without_reply', 'in_flight', 'closed_without_reply', 'put_aside',
      'reply_awaiting_approval', 'awaiting_approval',
    ]);
    expect(new Set(codes).size).toBe(codes.length);
  });

  // DEC-42's column is what separates a write the system made alone from one
  // a person approved. Both resolve with no reply text on the turn, and they
  // are not the same fact.
  it('separates an automatic resolution from one a person approved', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'a' });
    await run(id, 1, 'resolved');
    await turn(id, 2, { body: 'b' });
    await run(id, 2, 'resolved', 'unattributed');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyAbsence).toBe('handled_automatically');
    expect(thread?.turns[1]?.replyAbsence).toBe('approved_without_reply');
  });

  // Six states are in flight, and every one of them used to report as a run
  // that terminally sent nothing.
  it('says a run that has not finished has not finished', async () => {
    const states = ['received', 'classified', 'retrieved', 'composed', 'gated', 'executing'];
    for (const [index, state] of states.entries()) {
      const id = await conversation();
      await turn(id, 1, { body: 'still going' });
      await run(id, 1, state);
      const thread = await readConversation(pool, id);
      expect(thread?.turns[0]?.replyAbsence, `${state} (${index})`).toBe('in_flight');
    }
  });

  it('names a reply that exists rather than an absence', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'hello', reply: 'the answer' });
    await run(id, 1, 'resolved');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyText).toBe('the answer');
    expect(thread?.turns[0]?.replyAbsence).toBeNull();
  });
});

describe('a turn several runs worked', () => {
  // `run_turn_idx` is not unique and nothing constrains the pair. The
  // consumer files one orphan run per failed attempt, and abandoning the
  // message files another — so a plain join multiplied the turn by its
  // attempts, and a console drew the customer's message once per retry with
  // a different state on each copy.
  it('returns the turn once, however many runs worked it', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'the one message the customer sent' });
    await run(id, 1, 'escalated');
    await run(id, 1, 'escalated');
    await run(id, 1, 'abandoned');
    const thread = await readConversation(pool, id);
    expect(thread?.turns).toHaveLength(1);
    expect(thread?.turns[0]?.bodyText).toBe('the one message the customer sent');
  });

  it('counts the attempts rather than hiding them', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'a' });
    await run(id, 1, 'escalated');
    await run(id, 1, 'abandoned');
    await turn(id, 2, { body: 'b' });
    await run(id, 2, 'resolved');
    await turn(id, 3, { body: 'c' });
    const thread = await readConversation(pool, id);
    expect(thread?.turns.map((t) => t.runAttempts)).toEqual([2, 1, 0]);
  });

  // The newest run is the one that decided, so it is the one the turn shows.
  it('shows the run that last worked the turn', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'a' });
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        cost_micros, steps_used, deadline_at, conversation_id, turn_number,
                        created_at)
       VALUES (gen_random_uuid(), 'SYN-1', 0, 1, 'escalated', 'p', 'm', 0, 0, now(), $1, 1,
               now() - interval '1 hour')`,
      [id],
    );
    const newest = await run(id, 1, 'resolved');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.runId).toBe(newest);
    expect(thread?.turns[0]?.runState).toBe('resolved');
    expect(thread?.turns[0]?.runAttempts).toBe(2);
  });
});

describe('a turn whose message text was never retained', () => {
  // A turn recorded before db/010 has no copy of the message anywhere: the
  // queue row it would have come from was already acked.
  it('names the absence rather than rendering the turn blank', async () => {
    const id = await conversation();
    await turn(id, 1, { body: null, reply: 'we answered' });
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.bodyText).toBeNull();
    expect(thread?.turns[0]?.messageAbsence).toBe('not_retained');
  });

  // `intake.ticket_text` is NOT NULL with no non-empty check, and
  // `turn.body_text` is copied from it, so an empty message is stored rather
  // than refused. It is a message the customer sent, not one nobody retained.
  it('separates an empty message from one that was never retained', async () => {
    const id = await conversation();
    await turn(id, 1, { body: '' });
    await turn(id, 2, { body: null });
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.messageAbsence).toBe('empty_message');
    expect(thread?.turns[1]?.messageAbsence).toBe('not_retained');
  });

  it('names no absence when the message is there', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'the message' });
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.messageAbsence).toBeNull();
  });
});

describe('the conversation a run belongs to', () => {
  it('names it, and answers null for a run that belongs to none', async () => {
    const id = await conversation();
    const withConversation = await run(id, 1, 'resolved');
    expect(await conversationOfRun(pool, withConversation)).toBe(id);

    const orphan = randomUUID();
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        cost_micros, steps_used, deadline_at)
       VALUES ($1, 'SYN-V1', 0, 1, 'resolved', 'p', 'm', 0, 0, now())`,
      [orphan],
    );
    expect(await conversationOfRun(pool, orphan)).toBeNull();
    expect(await conversationOfRun(pool, 'not-a-uuid')).toBeNull();
  });
});

describe('the turn one run answered', () => {
  it('names the message, so a surface can draw it beside the reply', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'there are two charges for the same month' });
    const runId = await run(id, 1, 'awaiting_approval');
    const answered = await turnAnsweredBy(pool, runId);
    expect(answered?.conversationId).toBe(id);
    expect(answered?.turnNumber).toBe(1);
    expect(answered?.bodyText).toBe('there are two charges for the same month');
    expect(answered?.absence).toBeNull();
  });

  // A message nobody kept is not a run that answered no turn. A surface draws
  // the first as an absence and the second as nothing at all, so the reader
  // has to tell them apart.
  it('separates a message nobody kept from a run with no turn', async () => {
    const id = await conversation();
    await turn(id, 1, { body: null });
    const kept = await run(id, 1, 'resolved');
    expect((await turnAnsweredBy(pool, kept))?.absence).toBe('not_retained');

    const noTurn = await run(id, null, 'resolved');
    expect(await turnAnsweredBy(pool, noTurn)).toBeNull();
  });

  it('names an empty message as one the customer sent', async () => {
    const id = await conversation();
    await turn(id, 1, { body: '' });
    const runId = await run(id, 1, 'resolved');
    expect((await turnAnsweredBy(pool, runId))?.absence).toBe('empty_message');
  });

  // `intake.ticket_text` is a subject and a body joined by two newlines, so an
  // empty body with an empty subject stores whitespace and not the empty
  // string. It renders as a blank block, which is the one thing the absence
  // codes exist to prevent.
  it('names a message of whitespace as one the customer sent', async () => {
    const cases: readonly (readonly [string, string])[] =
      [['spaces', '   '], ['newlines', '\n\n'], ['a tab', '\t']];
    for (const [name, body] of cases) {
      const id = await conversation();
      await turn(id, 1, { body });
      const runId = await run(id, 1, 'resolved');
      expect((await turnAnsweredBy(pool, runId))?.absence, name).toBe('empty_message');
    }
  });

  it('answers null for a run the ledger does not hold, and for a bad id', async () => {
    expect(await turnAnsweredBy(pool, randomUUID())).toBeNull();
    expect(await turnAnsweredBy(pool, 'not-a-uuid')).toBeNull();
  });

  // The discriminator the join needs, and the one every other fixture here
  // lacks: a run carrying a turn number and no conversation, while another
  // conversation holds a turn of that number.
  //
  // Joining on the turn alone would hand back that other customer's message.
  // `db/015` says as much of the column — "a null here is not a turn one, and
  // a reader joins on it rather than assuming it" (DEC-35).
  it('joins on the conversation as well as the turn', async () => {
    const theirs = await conversation();
    await turn(theirs, 1, { body: 'a message from another conversation' });

    const orphan = randomUUID();
    await pool.query(
      `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                        cost_micros, steps_used, deadline_at, conversation_id, turn_number)
       VALUES ($1, 'SYN-9', 0, 1, 'resolved', 'p', 'm', 0, 0, now(), NULL, 1)`,
      [orphan],
    );

    const answered = await turnAnsweredBy(pool, orphan);
    expect(answered, 'a run with no conversation answers no turn').toBeNull();
  });

  it('takes the turn of its own conversation when two hold the same number', async () => {
    const mine = await conversation();
    const theirs = await conversation();
    await turn(mine, 1, { body: 'MINE' });
    await turn(theirs, 1, { body: 'THEIRS' });
    const runId = await run(mine, 1, 'resolved');
    const answered = await turnAnsweredBy(pool, runId);
    expect(answered?.bodyText).toBe('MINE');
    expect(answered?.conversationId).toBe(mine);
  });
});
