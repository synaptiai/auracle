// Who is making this request (DEC-45).
//
// DEC-45: "The console serves nothing to a request with no roster identity,
// and a trusted proxy authenticates that identity." So this module answers
// one question, and the server asks it before it builds any page: which
// active reviewer, if any, is behind this request.
//
// Two sources, in order. The header the operator named carries what the
// proxy authenticated; when that header yields no identity, the development
// reviewer stands in, and `dev-reviewer.ts` decides whether that is allowed
// at all. A console can be configured with one source or the other, never
// both: the entry point refuses to start on both, because a development
// fallback behind a proxy answers requests the proxy did not name.
//
// Both are checked against the roster: an identity that is not on it, or is
// no longer active, is nobody.
//
// A refusal says why, in as many words as there are fixes for it. An
// operator whose console serves nothing reads that reason: nothing arrived,
// the value arrived twice, the rules refuse it, or the roster does not hold
// it. Each one is a different thing to go and change.
import type { IncomingMessage } from 'node:http';

import { UNATTRIBUTED, approverFrom } from 'auracle/domain';

/** Whether this bounded identity may review. */
export type ActiveReviewer = (identity: string) => Promise<boolean>;

export interface ReviewerSources {
  /** The header a trusted proxy sets, once the operator names one. */
  readonly identityHeader?: string;
  /** The identity a source console on loopback may name (DEC-45). */
  readonly devReviewer?: string;
  readonly active: ActiveReviewer;
}

/**
 * Why no reviewer may make this request.
 *
 * `detail` is the fix, not the symptom: each value names something an
 * operator changes.
 */
export interface ReviewerRefusal {
  readonly detail: 'no_value' | 'repeated' | 'comma' | 'refused_name' | 'not_on_roster';
  /** The header the operator named, or null when the operator named none. */
  readonly header: string | null;
  /**
   * The value this console judged: the header's first line when one carried
   * it, and otherwise the identity the operator configured as the development
   * reviewer. Empty when there was no value from either source.
   */
  readonly said: string;
  /**
   * How many lines the named header carried. Zero when it carried none, and
   * therefore when the value in `said` came from the configuration.
   */
  readonly lines: number;
}

/**
 * The reviewer behind a request, or the reason there is none.
 *
 * The reviewer returned is the name the ledger would keep: it has passed the
 * DEC-42 rules, so the console never shows a person the audit column would
 * record as nobody.
 */
export type ReviewerVerdict =
  | { readonly reviewer: string }
  | { readonly refusal: ReviewerRefusal };

export type ReviewerFor = (req: IncomingMessage) => Promise<ReviewerVerdict>;

export function reviewerResolver(sources: ReviewerSources): ReviewerFor {
  return async (req) => {
    const header = sources.identityHeader ?? null;
    const carried = claimedIdentity(req, sources.identityHeader);
    const refuse = (
      detail: ReviewerRefusal['detail'],
      said: string,
      lines: number,
    ): ReviewerVerdict => ({ refusal: { detail, header, said, lines } });

    if (carried.claim !== null) {
      const name = approverFrom(carried.claim);
      if (name === UNATTRIBUTED) return refuse('refused_name', carried.said, carried.lines);
      // The roster decides, so a deactivated reviewer is refused here exactly
      // like a stranger. A read that throws propagates: the caller refuses
      // the request rather than serving a page it cannot attribute.
      return (await sources.active(name))
        ? { reviewer: name }
        : refuse('not_on_roster', carried.said, carried.lines);
    }
    // Nothing usable arrived. The development reviewer stands in, and it is
    // checked against the roster like any other name.
    if (sources.devReviewer !== undefined) {
      const name = approverFrom(sources.devReviewer);
      // The same rule the header's value gets. `main.ts` refuses such a
      // configuration at startup, and this module states it anyway: a name
      // the ledger would record as nobody is not a reviewer, whoever
      // configured it.
      if (name === UNATTRIBUTED) return refuse('refused_name', sources.devReviewer, 0);
      return (await sources.active(name))
        ? { reviewer: name }
        : refuse('not_on_roster', sources.devReviewer, 0);
    }
    return refuse(carried.detail, carried.said, carried.lines);
  };
}

/** What the named header carried, and why it yielded no identity. */
interface ClaimedHeader {
  /** The value this console would keep, or null when it keeps none. */
  readonly claim: string | null;
  readonly detail: ReviewerRefusal['detail'];
  readonly said: string;
  readonly lines: number;
}

/**
 * What the named header carried, and why it yields no identity (DEC-42).
 *
 * One condition: the operator named the header. A console cannot guess which
 * of its request headers a proxy controls, and naming one is the operator's
 * statement that a proxy in front sets it and strips any copy a client sent.
 * `identityHeader()` in `hosts.ts` says why the hosts no longer decide this.
 */
export function claimedIdentity(
  req: IncomingMessage,
  identityHeader: string | undefined,
): ClaimedHeader {
  const none: ClaimedHeader = { claim: null, detail: 'no_value', said: '', lines: 0 };
  if (identityHeader === undefined) return none;
  // Read from `headersDistinct`, which keeps every line. `headers` joins a
  // repeated `x-forwarded-user` with a comma, but for some names, such as
  // `From` and `Authorization`, it keeps the first value and drops the rest
  // without a sign. The operator may name any header.
  const values = req.headersDistinct[identityHeader.toLowerCase()];
  if (values === undefined) return none;
  const first = values[0] ?? '';
  // Two lines are two claims, and this console cannot say which one the proxy
  // meant — so it names nobody rather than guessing. A proxy that appends
  // rather than replaces produces exactly that, which is the forgeable audit
  // trail DEC-42 refuses. The count travels with the refusal, because it is
  // what tells that operator what their proxy is doing.
  if (values.length !== 1) {
    return { claim: null, detail: 'repeated', said: headerText(first), lines: values.length };
  }
  // The header arrived and carried nothing. `lines` stays 1, so the log does
  // not read as a header that never came: the two have different fixes.
  if (first === '') return { claim: null, detail: 'no_value', said: '', lines: 1 };
  // A comma cannot appear in a principal this console will keep, because it
  // cannot tell one name containing a comma from two names a proxy folded
  // into one line.
  if (first.includes(',')) {
    return { claim: null, detail: 'comma', said: headerText(first), lines: 1 };
  }
  // `said` is the text the console judged, not the bytes Node read: a name a
  // proxy sent as UTF-8 that the rules then refuse would otherwise reach the
  // log as `SynthÃ¶tic`, and the fix for that refusal is to check what the
  // proxy sends.
  const said = headerText(first);
  return { claim: said, detail: 'no_value', said, lines: 1 };
}

/**
 * A header value as the text its sender meant.
 *
 * Node reads header bytes as Latin-1, one character per byte. A proxy that
 * sends a name as UTF-8 then arrives as `SynthÃ¶tic`, and that is what the
 * ledger would record. So bytes that decode as UTF-8 are read as UTF-8.
 *
 * Bytes that do not decode stay as Node read them, because they are Latin-1
 * text. A lone byte from 0xF5 to 0xFF, for example, never occurs in UTF-8.
 * Plain ASCII reads the same either way. A comma never appears inside a
 * UTF-8 sequence, so the check above sees every one.
 *
 * One trade-off remains. A Latin-1 name whose bytes also form valid UTF-8
 * reads as UTF-8: the Latin-1 pair 0xC3 0xA9 records as one letter. Such a
 * name needs a byte from 0xC2 to 0xF4 followed by one from 0x80 to 0xBF,
 * which Latin-1 names rarely hold.
 */
export function headerText(value: string): string {
  const bytes = Buffer.from(value, 'latin1');
  if (bytes.every((byte) => byte < 0x80)) return value;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}
