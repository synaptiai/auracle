// The conversation reader, against the ledger (DEC-35, DEC-37).
//
// The point of these cases is the absences. A turn the system answered
// without a customer reply, a turn whose text was never retained, and a turn
// no run joins are three different facts, and a surface that showed one blank
// row for all three would be lying about two of them.
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { dbUrl } from '../db/config.js';
import { applyLedgerSchema } from '../test-support/schema.js';
import { conversationOfRun, readConversation, turnAnsweredBy } from './query.js';

const pool = new Pool({ connectionString: dbUrl(), max: 4 });

afterAll(async () => {
  await pool.end();
});

beforeAll(async () => {
  await applyLedgerSchema(pool);
});

beforeEach(async () => {
  await pool.query('TRUNCATE run, ticket_epoch, step_journal, outbox, conversation, turn');
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
  await pool.query(
    `INSERT INTO run (run_id, ticket_id, partition, epoch, state, prompt_ver, model_ver,
                      cost_micros, steps_used, deadline_at, conversation_id, turn_number,
                      approved_by)
     VALUES ($1, 'SYN-1', 0, 1, $2, 'p', 'm', 0, 0, now(), $3, $4, $5)`,
    [id, state, conversationId, turnNumber, approvedBy],
  );
  return id;
}

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

  it('joins each turn to the run that answered it', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'hello', reply: 'hi' });
    const runId = await run(id, 1, 'resolved');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.runId).toBe(runId);
    expect(thread?.turns[0]?.runState).toBe('resolved');
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

describe('the three reasons a turn shows no reply', () => {
  it('names an automatic resolution, which sends no customer reply (DEC-12)', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'please close this' });
    await run(id, 1, 'resolved');
    const thread = await readConversation(pool, id);
    expect(thread?.turns[0]?.replyText).toBeNull();
    expect(thread?.turns[0]?.replyAbsence).toBe('handled_automatically');
  });

  it('names a draft still waiting for a person', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'where is my refund' });
    await run(id, 1, 'awaiting_approval');
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

  // Four codes, four distinct answers. A surface reading these sends an
  // operator somewhere different for each, so two that rendered alike would
  // be worse than one that rendered nothing.
  it('gives each absence its own value', async () => {
    const id = await conversation();
    await turn(id, 1, { body: 'a' });
    await run(id, 1, 'resolved');
    await turn(id, 2, { body: 'b' });
    await run(id, 2, 'awaiting_approval');
    await turn(id, 3, { body: 'c' });
    await run(id, 3, 'escalated');
    await turn(id, 4, { body: 'd' });
    await turn(id, 5, { body: 'e' });
    await run(id, 5, 'resolved', 'ops-oncall');
    await turn(id, 6, { body: 'f' });
    await run(id, 6, 'composed');
    const thread = await readConversation(pool, id);
    const codes = thread?.turns.map((t) => t.replyAbsence) ?? [];
    expect(codes).toEqual([
      'handled_automatically', 'awaiting_approval', 'no_reply_sent', 'not_retained',
      'approved_without_reply', 'in_flight',
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
