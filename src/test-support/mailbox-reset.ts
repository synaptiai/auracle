// Empties the mailboxes a mail suite owns, before it runs.
//
// The mail suites address a fixed account — `support@acme.example` and
// `support-ingress@acme.example` — and assert on what is in it. That held
// while the only server was a throwaway container, which is new on every run
// and empty by construction.
//
// `docker compose --profile test up -d` now starts GreenMail, and that server
// outlives the run. On a second run the Drafts mailbox already held the first
// run's draft, and the case that asserts exactly one draft found four. The
// suite was right; the server was the thing that changed.
//
// Truncating the ledger between cases was never enough, because the mailbox
// is state this system keeps outside the ledger.
//
// Deleting rather than renaming the account. An account per run leaves a
// growing list of users on a server a person keeps for weeks, and GreenMail
// creates a user on first use, so nothing would ever remove them.
import { ImapFlow } from 'imapflow';

import { assertLocalHost } from './local-host.js';

export interface MailboxAccount {
  readonly host: string;
  readonly imapPort: number;
  readonly user: string;
  readonly pass: string;
}

/**
 * Removes every message from each named mailbox, and returns when they are
 * empty.
 *
 * A mailbox the account does not have yet is not an error: GreenMail creates
 * one on first use, and an absent mailbox is already empty.
 */
/** Set to '1' to empty mailboxes on a host that is not this machine. */
export const ALLOW_REMOTE_MAIL = 'AURACLE_TEST_ALLOW_REMOTE_MAIL';

/**
 * Refuses to empty mailboxes on a host that is not this machine.
 *
 * `MAIL_HOST` means "read mail here", and also "delete every message in
 * INBOX and Drafts of the two support accounts here". The reachability probe
 * checks a TCP port rather than who owns the server. A shared GreenMail — one
 * a team keeps for a demo, or a colleague's — would be emptied under someone
 * else's run by a variable that reads like a pointer.
 *
 * The ledger has the same shape of hazard and the same shape of answer:
 * `.claude/hooks/live_db_approval.py` stops a command reaching a database that
 * is not local unless a person says so.
 *
 * Bounded, not absolute: an auth-disabled server is the only one these
 * credentials reach. The refusal is for the case where that is exactly the
 * problem.
 */
export function assertLocalMailHost(host: string): void {
  assertLocalHost(
    host,
    ALLOW_REMOTE_MAIL,
    'refusing to empty mailboxes, deleting every message in the ones this run owns,',
    '`docker compose --profile test up -d` starts one on 127.0.0.1. ',
  );
}

export async function resetMailboxes(
  account: MailboxAccount,
  mailboxes: readonly string[],
): Promise<void> {
  assertLocalMailHost(account.host);
  const client = new ImapFlow({
    host: account.host,
    port: account.imapPort,
    secure: false,
    auth: { user: account.user, pass: account.pass },
    logger: false,
  });
  await client.connect();
  try {
    for (const mailbox of mailboxes) {
      let lock;
      try {
        lock = await client.getMailboxLock(mailbox);
      } catch (error) {
        // No such mailbox yet, so nothing to remove. imapflow says so only
        // after a LIST finds none. Any other failure means the reset did not
        // run, and the next case would find the drafts this one left.
        if ((error as { mailboxMissing?: boolean }).mailboxMissing === true) continue;
        throw error;
      }
      try {
        // `{ all: true }` is every message in the box: imapflow maps a lone
        // `all` key to the range `1:*`. `messageDelete` expunges, so the next
        // fetch sees none rather than seeing them flagged, and it acts on the
        // selected mailbox alone.
        const deleted = await client.messageDelete({ all: true }, { uid: false });
        // imapflow answers false for an empty mailbox too, so false alone
        // proves nothing. With messages still there, or with the mailbox lost
        // to a dropped connection, the delete did not happen.
        if (!deleted && client.mailbox === false) {
          throw new Error(`the connection lost ${mailbox} while emptying it`);
        }
        if (!deleted && client.mailbox !== false && client.mailbox.exists > 0) {
          throw new Error(
            `the mail server refused to empty ${mailbox}; ${client.mailbox.exists} message(s) remain`,
          );
        }
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}
