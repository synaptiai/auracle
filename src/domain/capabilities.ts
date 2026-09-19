/**
 * The adapter contract, defined once (DEC-06).
 *
 * Adapters declare their capabilities and autonomy adapts to those
 * declarations. That contract is the thing DEC-06 names, so it has to have
 * one definition. It had two: `src/policy/policy.ts` and
 * `src/adapters/types.ts` each carried an `AdapterCapabilities` with the same
 * five fields, and both comments claimed to be "the exact shape from section
 * 4.1". Adapters declared against one copy and the policy engine was typed
 * against the other, with structural typing carrying objects between them. So
 * a sixth flag added to either side compiled cleanly, the other side never saw
 * it, and no test failed. Two end-to-end suites imported both and aliased one
 * `PolicyCapabilities`, which is what the duplication looked like from the
 * outside.
 *
 * `RiskTier` had the same problem in a different shape: declared in
 * `policy.ts` and derived again in `src/fixtures/load.ts`.
 *
 * This module holds both and imports nothing. A file that needs the contract
 * does not also acquire the policy engine or the fixture loader.
 */

/**
 * Cost of an error for an intent. A person sets it; the system does not learn
 * it (DEC-13).
 *
 * The runtime list and the type come from the same line, so a tier added to
 * one is added to the other. `src/fixtures/load.ts` validates a taxonomy
 * against `RISK_TIERS` and used to own a second copy of the type.
 */
export const RISK_TIERS = ['low', 'medium', 'high'] as const;

export type RiskTier = (typeof RISK_TIERS)[number];

/**
 * Capability declaration from section 4.1. Autonomy adapts to these (DEC-06).
 *
 * Each flag is a guarantee the target system gives, so an adapter must
 * declare it honestly: a false flag is never a soft claim.
 *
 * `supportsIdempotencyKey` and `supportsReadBack` are the two the policy
 * engine reads. Each is a separate guarantee about a write's outcome, and an
 * automatic write needs both: one makes a retry safe, the other makes the
 * result knowable. An adapter with no idempotency key cannot make a retry
 * safe, and one with no read-back cannot say whether its write landed, so
 * `resolveSendFailure` escalates such a failure rather than retry blind
 * (DEC-30).
 *
 * The remaining three describe what an adapter can carry, not what it
 * guarantees about a delivery, so no policy rule reads them.
 */
export interface AdapterCapabilities {
  supportsIdempotencyKey: boolean; // controls automatic writes
  supportsReadBack: boolean; // lets the relay reconcile
  supportsDraftState: boolean; // necessary for DEC-11
  supportsStructuredFields: boolean; // necessary for bug records
  supportsThreading: boolean;
  /**
   * DEC-44: the helpdesk cannot send the copy it parks, so the ledger holds
   * the approved reply and every approval path sends it.
   *
   * True only where the parked copy can never reach a customer. A helpdesk
   * that can send its own draft makes this false whatever else it declares:
   * two texts that may both send is the failure DEC-44 rejected by name.
   *
   * The relay reads it to choose between sending the parked handle and
   * sending the reply the approval recorded; the console reads it to decide
   * whether a reviewer edits the reply here; the approval reads it through
   * its caller, which passes `ledgerReply`.
   *
   * Unlike the two flags the policy engine reads, this one decides no
   * autonomy: an automatic write never sends a customer reply (DEC-12), so
   * only the approval path consults it.
   */
  supportsLedgerReply: boolean;
}
