// What `pnpm run approve` decides, and what it prints (DEC-44, DEC-12).
//
// The command itself commits nothing new: it hands the approval the options
// these functions build and prints the sentence they return. So the case for
// criterion 11 lives here — which text the command approves — and the ledger
// half lives in `ledger-reply.db.test.ts`, where a real parked reply is sent.
import { describe, expect, it } from 'vitest';

import { approvalOptionsFor, refusalSays } from './cli.js';
import { replyDigest } from './shown.js';
import { HelpdeskAdapter } from '../adapters/helpdesk.js';
import { FreeScoutEgressAdapter } from '../adapters/freescout.js';
import type { ApproveOutcome } from './approve.js';

const FREESCOUT_ENV = {
  APPROVE_ADAPTER: 'freescout',
  FREESCOUT_BASE_URL: 'http://helpdesk.invalid',
  FREESCOUT_API_KEY: 'synthetic-key',
  FREESCOUT_USER_ID: '7',
};

describe('the options one approval runs with', () => {
  // DEC-44: the declaration decides whether this command sends the parked
  // copy or the reply the ledger holds.
  it('approves the ledger reply only on the adapter that declares it', () => {
    expect(approvalOptionsFor(['--run', 'r'], { ...FREESCOUT_ENV, FREESCOUT_INTERNAL_NOTE: 'true' }))
      .toEqual({ ledgerReply: true });
    expect(approvalOptionsFor(['--run', 'r'], FREESCOUT_ENV)).toEqual({});
    expect(approvalOptionsFor(['--run', 'r'], { APPROVE_ADAPTER: 'helpdesk' })).toEqual({});
  });

  // Without the flag no read-back is built, so no comparison is made: the
  // command approves what the ledger holds and never reads the copy.
  it('reads the copy back only under --read-back', () => {
    const withFlag = approvalOptionsFor(
      ['--run', 'r', '--read-back'],
      { ...FREESCOUT_ENV, FREESCOUT_INTERNAL_NOTE: 'true' },
    );
    expect(withFlag.ledgerReply).toBe(true);
    expect(withFlag.readDraft).toBeInstanceOf(FreeScoutEgressAdapter);

    // The manual path on an adapter that sends its own parked copy.
    expect(approvalOptionsFor(['--run', 'r'], { APPROVE_ADAPTER: 'helpdesk' }).readDraft)
      .toBeUndefined();
    const helpdeskReadBack = approvalOptionsFor(
      ['--run', 'r', '--read-back'],
      { APPROVE_ADAPTER: 'helpdesk' },
    );
    expect(helpdeskReadBack.readDraft).toBeInstanceOf(HelpdeskAdapter);
    // The reference adapter holds its drafts in another process's memory, but
    // the command still builds it as asked: building opens no connection, and
    // refusing to build would be this command second-guessing the operator.
    expect(helpdeskReadBack.ledgerReply).toBeUndefined();
  });

  // DEC-44: the operator's decision about a helpdesk copy a person edited.
  // It travels as the digest the refusal printed, so the approval refuses
  // again when the copy that text came from has moved.
  it('carries the digest --accept-copy-edit names', () => {
    const digest = 'a'.repeat(64);
    const options = approvalOptionsFor(
      ['--run', 'r', '--read-back', '--accept-copy-edit', digest],
      { ...FREESCOUT_ENV, FREESCOUT_INTERNAL_NOTE: 'true' },
    );

    expect(options.copyAcknowledged).toBe(digest);
    expect(options.ledgerReply).toBe(true);
  });

  // A mistyped digest is a usage fault and not a quiet no-op: ignored, the
  // approval would refuse the copy again and the operator would read that as
  // the flag not working.
  it('refuses an acknowledgement that is not a digest', () => {
    expect(() => approvalOptionsFor(
      ['--run', 'r', '--accept-copy-edit', 'yes'],
      { ...FREESCOUT_ENV, FREESCOUT_INTERNAL_NOTE: 'true' },
    )).toThrow(/64-character digest/);
  });

  it('refuses an adapter name it does not know, before any connection', () => {
    expect(() => approvalOptionsFor(['--run', 'r'], { APPROVE_ADAPTER: 'zendesk' }))
      .toThrow(/unknown APPROVE_ADAPTER 'zendesk'/);
  });
});

describe('what the command prints for a refusal', () => {
  it('prints both texts when a person edited the copy after the park', () => {
    const result: ApproveOutcome = {
      outcome: 'copy_changed',
      ledgerText: 'Your refund is on its way.',
      copyText: 'Your refund is on its way. Ask billing about the invoice.',
    };

    const says = refusalSays(result, 'run-1');

    expect(says).toContain('the reply the ledger holds');
    expect(says).toContain('Your refund is on its way.');
    expect(says).toContain('the copy the helpdesk holds');
    expect(says).toContain('Ask billing about the invoice.');
    expect(says).toContain('nothing was sent');
  });

  // The refusal names the action that answers it, and the digest that binds
  // the action to the text the operator just read. Without either, the second
  // branch of the choice is unreachable from this command.
  it('names the digest and the flag that send the ledger reply past a copy', () => {
    const copyText = 'Your refund is on its way. Ask billing about the invoice.';
    const says = refusalSays({ outcome: 'copy_changed', ledgerText: 'Your refund is on its way.', copyText }, 'run-1');

    expect(says).toContain(replyDigest(copyText));
    expect(says).toContain('--accept-copy-edit');
  });

  // A reply is steered by a customer's message, so it can carry a terminal
  // escape or a bidi override. Printed raw, a bidi override reorders the two
  // blocks this refusal exists to keep apart, and the operator reads the copy
  // as the ledger's reply.
  it('prints the two texts with every invisible character escaped', () => {
    const says = refusalSays({
      outcome: 'copy_changed',
      ledgerText: 'Dear Ana, \u001b]0;pwned\u0007 we shipped it.',
      copyText: 'Dear Ana, \u202e we shipped it.',
    }, 'run-1');

    expect(says).toContain('\\u001b');
    expect(says).toContain('\\u0007');
    expect(says).toContain('\\u202e');
    // The escape is the character a reader sees, and not one a terminal reads.
    expect(says).not.toContain('\u001b');
    expect(says).not.toContain('\u202e');
  });

  // A typed escape and a real control must not print alike, so a backslash
  // prints twice. Both blocks are escaped the same way, so they still compare.
  it('prints a backslash in either text twice', () => {
    const says = refusalSays({
      outcome: 'copy_changed',
      ledgerText: String.raw`Open C:\files, then type \u202e.`,
      copyText: 'Open C:\\files, then \u202e.',
    }, 'run-1');
    expect(says).toContain(String.raw`--- the reply the ledger holds ---
Open C:\\files, then type \\u202e.`);
    expect(says).toContain(String.raw`--- the copy the helpdesk holds ---
Open C:\\files, then \u202e.`);
  });

  it('says a reply the ledger cannot disclose is refused (DEC-14)', () => {
    expect(refusalSays({ outcome: 'no_disclosure' }, 'run-1')).toContain('no disclosure');
  });

  // The way out is a step that exists. "Approve again" is the one step that
  // cannot work — the draft this approval would read is what is missing — and
  // the sentence used to name it.
  it('names the ways out of a missing draft', () => {
    const says = refusalSays({ outcome: 'draft_missing', draftExternalId: '9:12' }, 'run-1');

    expect(says).toContain("the adapter holds no draft '9:12'");
    expect(says).toContain('Restore the copy in the helpdesk');
    expect(says).toContain('Approving without it hands the run to the relay');
  });

  // An outcome that needs no sentence gets none: a command that printed one
  // for every outcome would bury the two that matter.
  it('prints nothing for an approval, or for a refusal that speaks for itself', () => {
    expect(refusalSays({ outcome: 'approved', idemKey: 'k' }, 'run-1')).toBeNull();
    expect(refusalSays({ outcome: 'shown_changed' }, 'run-1')).toBeNull();
  });
});
