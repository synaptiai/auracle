// What a failed draft read means for a send (DEC-30).
//
// Its own module because it names IMAP response codes, and the guard that
// keeps `.env.example` complete reads every capitalised word in a module that
// reads the environment.
import { errorMessage } from '../errors.js';
import type { NothingSentError } from './types.js';

/** The fields imapflow sets on a failed command. */
interface ImapFault {
  readonly mailboxMissing?: unknown;
  readonly authenticationFailed?: unknown;
  readonly serverResponseCode?: unknown;
  readonly responseStatus?: unknown;
  readonly responseText?: unknown;
  readonly code?: unknown;
  /** The server's goodbye, which `withImap` copies from the client. */
  readonly serverGoodbye?: unknown;
  /** The server's reply. imapflow leaves a refused FETCH's code in it. */
  readonly response?: unknown;
}

/**
 * The response code of a refusal. imapflow copies it to `serverResponseCode`
 * for most commands, and not for a refused FETCH, whose parsed reply keeps it
 * as its first bracketed section.
 */
function responseCode(fault: ImapFault): string | undefined {
  if (typeof fault.serverResponseCode === 'string') return fault.serverResponseCode;
  const reply = fault.response as { attributes?: { section?: { value?: unknown }[] }[] } | undefined;
  const value = typeof reply === 'object' && reply !== null ? reply.attributes?.[0]?.section?.[0]?.value : undefined;
  return typeof value === 'string' ? value.trim().toUpperCase() : undefined;
}

/**
 * Server text, cut by character to a bound: it reaches the journal and the
 * console, and half a surrogate pair is text the journal's jsonb column
 * refuses, so the escalation would never be written.
 */
function bounded(text: string): string {
  const chars = Array.from(text);
  return chars.length > SAID_LIMIT ? `${chars.slice(0, SAID_LIMIT).join('')}…` : text;
}

/**
 * RFC 5530 codes that ask the client to try again later, whatever the command.
 * LIMIT is not one: it names a limit the request hit, and a retry hits it again.
 */
const TRY_LATER = new Set(['UNAVAILABLE', 'INUSE']);

/** The most of the server's text a cause carries. */
const SAID_LIMIT = 200;

/**
 * The error a send throws for a failed draft read.
 *
 * An answer the server refused proves nothing about an earlier attempt, so it
 * passes through as a plain fault and DEC-30 escalates it as an unknown
 * delivery. That covers a refused login, a mailbox that is gone and a FETCH
 * the server refused. A refusal that asks for a later try, a throttle, a
 * goodbye before the login, and any fault that is not an answer at all, such
 * as a dropped connection or a timeout, read nothing. So the record waits.
 *
 * imapflow's own message for a refusal is "Command failed", so the server's
 * text is what names the cause. It reaches the journal and the console, so it
 * is cut to a bound.
 */
export function draftReadFault(
  error: unknown,
  mailbox: string,
  nothingSent: (cause: unknown, permanent: boolean) => NothingSentError,
): Error {
  const fault: ImapFault = typeof error === 'object' && error !== null ? (error as ImapFault) : {};
  const text = typeof fault.responseText === 'string' && fault.responseText.length > 0
    ? fault.responseText
    : errorMessage(error);
  const said = bounded(text);
  // imapflow sets its login flag on any error raised during LOGIN. A dropped
  // connection or a timeout carries a code. A refusal is an answer from the
  // server, or a login failure imapflow raised itself with no code, such as a
  // login the server has disabled.
  const refused = fault.responseStatus === 'NO' || fault.responseStatus === 'BAD'
    || (fault.authenticationFailed === true && fault.code === undefined);
  const step = fault.authenticationFailed === true ? 'the login' : 'the draft read';
  // A throttle and a try-later code come first: imapflow can also mark such a
  // reply as a failed login, or as a missing mailbox when its LIST is refused.
  const later = fault.code === 'ETHROTTLE'
    || (refused && TRY_LATER.has(responseCode(fault) ?? ''));
  if (later) {
    return nothingSent(new Error(`the IMAP server refused ${step} for now: ${said}`, { cause: error }), false);
  }
  // A server that said goodbye ended the session before anything was read: a
  // login failure after one is the session closing, not a refusal. A failure
  // that carries the server's reply is still an answer, and still a refusal.
  if (typeof fault.serverGoodbye === 'string' && fault.responseStatus === undefined && fault.response === undefined) {
    return nothingSent(new Error(`the IMAP server closed the session: ${bounded(fault.serverGoodbye)}`, { cause: error }), false);
  }
  if (fault.mailboxMissing === true) {
    return new Error(`the mailbox '${mailbox}' does not exist`, { cause: error });
  }
  if (refused) {
    return new Error(`the IMAP server refused ${step}: ${said}`, { cause: error });
  }
  return nothingSent(error, false);
}
